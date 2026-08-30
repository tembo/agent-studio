"""Characterization tests for the Rust-to-Python runner protocol.

The Rust parent starts ``scripts/run_pydantic.py`` with ``--fmt`` and
``--user-message``. It writes one JSON launch envelope to stdin, then keeps
stdin open as a checkpoint acknowledgement channel. The wrapper writes a
line-oriented stdout stream:

* ``__TAS_CHECKPOINT__`` carries typed message history. Rust persists it and
  replies ``checkpoint`` on stdin before the graph may advance.
* ``__TAS_DELTA__`` and ``__TAS_PROGRESS__`` are live, best-effort events.
* ``__TAS_TOOLS__``, ``__TAS_STEPS__``, ``__TAS_SCALEDOWN__``, and
  ``__TAS_USAGE__`` are authoritative terminal summaries when applicable.
* all other stdout is the final user-facing output.

Exit 0 is success, exit 1 is a provider/runtime failure, and exit 2 is invalid
launch input or an invalid spec. Cancellation is owned by Rust: it kills the
process, so a cancelled wrapper is not expected to emit terminal summaries.

The tests below execute the real wrapper in a subprocess against a loopback
Anthropic-compatible server. No provider credentials or external traffic are
used.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
from typing import Any

import pytest


API_ROOT = Path(__file__).resolve().parents[1]
WRAPPER = API_ROOT / "scripts" / "run_pydantic.py"

CHECKPOINT = "__TAS_CHECKPOINT__:"
DELTA = "__TAS_DELTA__:"
PROGRESS = "__TAS_PROGRESS__:"
TOOLS = "__TAS_TOOLS__:"
STEPS = "__TAS_STEPS__:"
USAGE = "__TAS_USAGE__:"

BASE_SPEC = {
    "name": "protocol-test",
    "model": "anthropic:claude-sonnet-4-5",
    "instructions": "Complete the request.",
}


def _sse_event(name: str, payload: dict[str, Any]) -> bytes:
    return f"event: {name}\ndata: {json.dumps(payload)}\n\n".encode()


def _text_stream(text: str, *, input_tokens: int = 4, output_tokens: int = 2) -> bytes:
    return b"".join(
        [
            _sse_event(
                "message_start",
                {
                    "type": "message_start",
                    "message": {
                        "id": "msg_test",
                        "type": "message",
                        "role": "assistant",
                        "content": [],
                        "model": "claude-sonnet-4-5",
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": {"input_tokens": input_tokens, "output_tokens": 0},
                    },
                },
            ),
            _sse_event(
                "content_block_start",
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "text", "text": ""},
                },
            ),
            _sse_event(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": text},
                },
            ),
            _sse_event("content_block_stop", {"type": "content_block_stop", "index": 0}),
            _sse_event(
                "message_delta",
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                    "usage": {"output_tokens": output_tokens},
                },
            ),
            _sse_event("message_stop", {"type": "message_stop"}),
        ]
    )


def _tool_call_stream() -> bytes:
    return b"".join(
        [
            _sse_event(
                "message_start",
                {
                    "type": "message_start",
                    "message": {
                        "id": "msg_tool",
                        "type": "message",
                        "role": "assistant",
                        "content": [],
                        "model": "claude-sonnet-4-5",
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": {"input_tokens": 5, "output_tokens": 0},
                    },
                },
            ),
            _sse_event(
                "content_block_start",
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {
                        "type": "tool_use",
                        "id": "toolu_echo",
                        "name": "echo",
                        "input": {},
                    },
                },
            ),
            _sse_event(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": '{"message":"hello"}',
                    },
                },
            ),
            _sse_event("content_block_stop", {"type": "content_block_stop", "index": 0}),
            _sse_event(
                "message_delta",
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": "tool_use", "stop_sequence": None},
                    "usage": {"output_tokens": 4},
                },
            ),
            _sse_event("message_stop", {"type": "message_stop"}),
        ]
    )


@dataclass
class ResponsePlan:
    body: bytes = b""
    status: int = 200
    content_type: str = "text/event-stream"
    first_chunk: bytes | None = None
    release: threading.Event | None = None


@dataclass
class FakeAnthropic:
    plans: list[ResponsePlan]
    requests: list[dict[str, Any]] = field(default_factory=list)
    _server: ThreadingHTTPServer | None = field(init=False, default=None)
    _thread: threading.Thread | None = field(init=False, default=None)

    def __enter__(self) -> "FakeAnthropic":
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
                length = int(self.headers.get("content-length", "0"))
                raw = self.rfile.read(length)
                owner.requests.append(json.loads(raw))
                plan = owner.plans.pop(0) if owner.plans else ResponsePlan(
                    status=500,
                    content_type="application/json",
                    body=b'{"type":"error","error":{"message":"unexpected request"}}',
                )

                self.send_response(plan.status)
                self.send_header("Content-Type", plan.content_type)
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    if plan.first_chunk is not None:
                        self.wfile.write(plan.first_chunk)
                        self.wfile.flush()
                        assert plan.release is not None
                        plan.release.wait(timeout=10)
                    self.wfile.write(plan.body)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                self.close_connection = True

            def log_message(self, _format: str, *_args: object) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        assert self._server is not None
        self._server.shutdown()
        self._server.server_close()
        assert self._thread is not None
        self._thread.join(timeout=5)

    @property
    def base_url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address
        return f"http://{host}:{port}"


@dataclass
class WrapperResult:
    returncode: int
    lines: list[str]
    stderr: str
    checkpoints_acked: int


def _spawn_wrapper(
    *,
    base_url: str | None = None,
    extra_env: dict[str, str] | None = None,
    user_message: str = "hello",
) -> subprocess.Popen[str]:
    env = os.environ.copy()
    env.update(
        {
            "ANTHROPIC_API_KEY": "test-anthropic-key",
            "PYTHONUNBUFFERED": "1",
            "TAS_CHECKPOINT_ACK": "1",
            "TAS_RUN_STARTED_AT": "2026-08-30T12:00:00.000Z",
            "NO_PROXY": "127.0.0.1,localhost",
        }
    )
    if base_url is not None:
        env["ANTHROPIC_BASE_URL"] = base_url
    if extra_env:
        env.update(extra_env)
    return subprocess.Popen(
        [sys.executable, str(WRAPPER), "--fmt", "json", "--user-message", user_message],
        cwd=API_ROOT,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )


def _run_wrapper(
    spec: dict[str, Any],
    *,
    base_url: str,
    extra_env: dict[str, str] | None = None,
    timeout: float = 15,
) -> WrapperResult:
    process = _spawn_wrapper(base_url=base_url, extra_env=extra_env)
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None

    lines: list[str] = []
    stderr_parts: list[str] = []
    checkpoints_acked = 0

    def read_stdout() -> None:
        nonlocal checkpoints_acked
        assert process.stdout is not None
        assert process.stdin is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip("\r\n")
            lines.append(line)
            if line.startswith(CHECKPOINT):
                try:
                    process.stdin.write("checkpoint\n")
                    process.stdin.flush()
                    checkpoints_acked += 1
                except BrokenPipeError:
                    return

    def read_stderr() -> None:
        assert process.stderr is not None
        stderr_parts.append(process.stderr.read())

    stdout_thread = threading.Thread(target=read_stdout, daemon=True)
    stderr_thread = threading.Thread(target=read_stderr, daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    process.stdin.write(json.dumps({"spec_content": json.dumps(spec)}) + "\n")
    process.stdin.flush()
    try:
        returncode = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
        raise
    finally:
        stdout_thread.join(timeout=5)
        stderr_thread.join(timeout=5)

    return WrapperResult(returncode, lines, "".join(stderr_parts), checkpoints_acked)


def _payloads(lines: list[str], sentinel: str) -> list[Any]:
    return [json.loads(line.removeprefix(sentinel)) for line in lines if line.startswith(sentinel)]


def _plain_output(lines: list[str]) -> list[str]:
    return [line for line in lines if line and not line.startswith("__TAS_")]


def test_happy_path_stream_and_terminal_summaries() -> None:
    with FakeAnthropic([ResponsePlan(body=_text_stream("hello from provider"))]) as server:
        result = _run_wrapper(BASE_SPEC, base_url=server.base_url)

    assert result.returncode == 0, result.stderr
    assert result.checkpoints_acked >= 1
    assert "hello from provider" in "".join(
        payload["t"] for payload in _payloads(result.lines, DELTA)
    )
    assert _plain_output(result.lines) == ["hello from provider"]

    steps = _payloads(result.lines, STEPS)
    assert len(steps) == 1
    assert steps[0] == [
        {
            "step": 0,
            "summary": "hello from provider",
            "input_tokens": 4,
            "output_tokens": 2,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "tool_calls": [],
        }
    ]
    assert _payloads(result.lines, USAGE) == [
        {
            "input_tokens": 4,
            "output_tokens": 2,
            "total_tokens": 6,
            "requests": 1,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
        }
    ]
    assert len(server.requests) == 1


def test_tool_call_round_trip_emits_live_and_terminal_tool_data() -> None:
    tools_module = """
def echo(message: str) -> str:
    \"\"\"Echo a message for the protocol test.\"\"\"
    return f\"echoed: {message}\"

tools = [echo]
"""
    spec = {**BASE_SPEC, "tools_module": "agent_tools.py"}
    with FakeAnthropic(
        [
            ResponsePlan(body=_tool_call_stream()),
            ResponsePlan(body=_text_stream("tool complete", input_tokens=9, output_tokens=2)),
        ]
    ) as server:
        result = _run_wrapper(
            spec,
            base_url=server.base_url,
            extra_env={"TAS_TOOLS_MODULE_CONTENT": tools_module},
        )

    assert result.returncode == 0, result.stderr
    assert result.checkpoints_acked >= 2
    progress = _payloads(result.lines, PROGRESS)
    assert any(
        event.get("kind") == "tool_call"
        and event.get("id") == "toolu_echo"
        and event.get("name") == "echo"
        for event in progress
    )
    assert any(
        event.get("kind") == "tool_result"
        and event.get("id") == "toolu_echo"
        and event.get("ok") is True
        for event in progress
    )
    assert _payloads(result.lines, TOOLS) == [
        [{"name": "echo", "ok": True, "error": None}]
    ]

    steps = _payloads(result.lines, STEPS)[0]
    assert len(steps) == 2
    assert steps[0]["tool_calls"] == [
        {"name": "echo", "ok": True, "error": None}
    ]
    assert steps[1]["summary"] == "tool complete"
    assert _plain_output(result.lines) == ["tool complete"]
    assert len(server.requests) == 2
    assert "echoed: hello" in json.dumps(server.requests[1])


def test_provider_error_is_exit_one_with_diagnostic() -> None:
    error = {
        "type": "error",
        "error": {"type": "authentication_error", "message": "fake provider rejected key"},
    }
    plans = [
        ResponsePlan(
            status=401,
            content_type="application/json",
            body=json.dumps(error).encode(),
        )
        for _ in range(3)
    ]
    with FakeAnthropic(plans) as server:
        result = _run_wrapper(BASE_SPEC, base_url=server.base_url)

    assert result.returncode == 1
    assert "fake provider rejected key" in result.stderr
    assert "pydantic-ai run failed" in result.stderr
    assert _payloads(result.lines, USAGE) == []


@pytest.mark.parametrize(
    ("stdin_line", "expected_error"),
    [
        ("{not-json}\n", "failed to parse runner input envelope"),
        (json.dumps({"spec_content": "[]"}) + "\n", "failed to parse spec"),
    ],
)
def test_malformed_input_is_exit_two(stdin_line: str, expected_error: str) -> None:
    process = _spawn_wrapper()
    stdout, stderr = process.communicate(stdin_line, timeout=10)

    assert process.returncode == 2
    assert stdout == ""
    assert expected_error in stderr


@pytest.mark.skipif(sys.platform == "win32", reason="Rust cancellation uses Unix SIGKILL")
def test_cancellation_mid_stream_has_no_terminal_summary() -> None:
    release = threading.Event()
    stream = _text_stream("partial output")
    split_at = stream.index(b"event: content_block_stop")
    plan = ResponsePlan(first_chunk=stream[:split_at], body=stream[split_at:], release=release)

    with FakeAnthropic([plan]) as server:
        process = _spawn_wrapper(base_url=server.base_url)
        assert process.stdin is not None
        assert process.stdout is not None
        assert process.stderr is not None
        process.stdin.write(json.dumps({"spec_content": json.dumps(BASE_SPEC)}) + "\n")
        process.stdin.flush()

        lines: list[str] = []
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            line = process.stdout.readline().rstrip("\r\n")
            if line:
                lines.append(line)
            if line.startswith(CHECKPOINT):
                process.stdin.write("checkpoint\n")
                process.stdin.flush()
            if line.startswith(DELTA):
                break
        else:
            process.kill()
            pytest.fail("wrapper did not stream a delta before the timeout")

        process.kill()
        release.set()
        returncode = process.wait(timeout=5)
        lines.extend(line.rstrip("\r\n") for line in process.stdout)
        stderr = process.stderr.read()

    assert returncode == -signal.SIGKILL, stderr
    assert _payloads(lines, DELTA)
    assert _payloads(lines, STEPS) == []
    assert _payloads(lines, USAGE) == []
