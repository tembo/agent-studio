"""Line protocol shared by the Pydantic wrapper and its Rust host process.

This module owns serialization only: live stream events, durable checkpoints,
terminal tool/step/usage summaries, and AgentSpec parsing. Provider setup and
the agent run loop stay in ``run_pydantic.py``.
"""

from __future__ import annotations

import json
import os
import sys

import yaml
from pydantic_ai import ModelMessagesTypeAdapter
from pydantic_ai.usage import RunUsage


USAGE_SENTINEL = "__TAS_USAGE__:"
TOOLS_SENTINEL = "__TAS_TOOLS__:"
STEPS_SENTINEL = "__TAS_STEPS__:"
DELTA_SENTINEL = "__TAS_DELTA__:"
PROGRESS_SENTINEL = "__TAS_PROGRESS__:"
CHECKPOINT_SENTINEL = "__TAS_CHECKPOINT__:"

MAX_TOOL_ERROR_CHARS = 4000


def tool_calls_payload(messages) -> list[dict]:
    """Extract tool names and outcomes from a run's message history."""
    calls: list[tuple[str, str]] = []
    outcomes: dict[str, dict] = {}
    for msg in messages or []:
        for part in getattr(msg, "parts", None) or []:
            kind = getattr(part, "part_kind", "") or ""
            cid = getattr(part, "tool_call_id", None)
            name = getattr(part, "tool_name", None)
            if not cid or not name:
                continue
            if kind.endswith("tool-call"):
                calls.append((cid, name))
            elif kind == "retry-prompt":
                content = getattr(part, "content", "")
                outcomes[cid] = {
                    "ok": False,
                    "error": str(content)[:MAX_TOOL_ERROR_CHARS],
                }
            elif kind.endswith("tool-return"):
                outcomes.setdefault(cid, {"ok": True, "error": None})
    out: list[dict] = []
    for cid, name in calls[:200]:
        outcome = outcomes.get(cid)
        if outcome is None:
            out.append({"name": name, "ok": None})
        else:
            out.append(
                {"name": name, "ok": outcome["ok"], "error": outcome.get("error")}
            )
    return out


def _usage_field(usage_obj, *names):
    """Return the first non-None usage field across pydantic-ai versions."""
    if usage_obj is None:
        return None
    for name in names:
        value = getattr(usage_obj, name, None)
        if value is not None:
            return value
    return None


def _uncached_input(usage_obj):
    """Return genuinely-new input tokens without prompt-cache halves."""
    total = _usage_field(usage_obj, "input_tokens", "request_tokens")
    if total is None:
        return None
    cache_read = _usage_field(usage_obj, "cache_read_tokens") or 0
    cache_write = _usage_field(usage_obj, "cache_write_tokens") or 0
    return max(0, total - cache_read - cache_write)


def steps_payload(messages) -> list[dict]:
    """Build per-model-request usage and tool-call summaries."""
    outcomes: dict[str, dict] = {}
    for msg in messages or []:
        for part in getattr(msg, "parts", None) or []:
            kind = getattr(part, "part_kind", "") or ""
            cid = getattr(part, "tool_call_id", None)
            if not cid:
                continue
            if kind == "retry-prompt":
                content = getattr(part, "content", "")
                outcomes[cid] = {
                    "ok": False,
                    "error": str(content)[:MAX_TOOL_ERROR_CHARS],
                }
            elif kind.endswith("tool-return"):
                outcomes.setdefault(cid, {"ok": True, "error": None})

    steps: list[dict] = []
    index = 0
    for msg in messages or []:
        if getattr(msg, "kind", "") != "response":
            continue
        usage_obj = getattr(msg, "usage", None)
        tools: list[dict] = []
        text_parts: list[str] = []
        for part in getattr(msg, "parts", None) or []:
            kind = getattr(part, "part_kind", "") or ""
            if kind == "text":
                content = getattr(part, "content", None)
                if isinstance(content, str) and content.strip():
                    text_parts.append(content.strip())
                continue
            if not kind.endswith("tool-call"):
                continue
            name = getattr(part, "tool_name", None)
            if not name:
                continue
            cid = getattr(part, "tool_call_id", None)
            outcome = outcomes.get(cid) if cid else None
            if outcome is None:
                tools.append({"name": name, "ok": None})
            else:
                tools.append(
                    {
                        "name": name,
                        "ok": outcome["ok"],
                        "error": outcome.get("error"),
                    }
                )
        summary = " ".join(text_parts).strip() or None
        if summary is not None:
            summary = summary[:280] if tools else summary[:50_000]
        steps.append(
            {
                "step": index,
                "summary": summary,
                "input_tokens": _uncached_input(usage_obj),
                "output_tokens": _usage_field(
                    usage_obj, "output_tokens", "response_tokens"
                ),
                "cache_read_tokens": _usage_field(usage_obj, "cache_read_tokens"),
                "cache_write_tokens": _usage_field(usage_obj, "cache_write_tokens"),
                "tool_calls": tools[:200],
            }
        )
        index += 1
    return steps[:500]


def _emit_stream_line(sentinel: str, payload: dict) -> None:
    """Write and immediately flush one best-effort streaming event."""
    try:
        sys.stdout.write(f"{sentinel}{json.dumps(payload)}\n")
        sys.stdout.flush()
    except Exception:
        pass


def _emit_checkpoint(messages) -> None:
    """Send typed message history and wait for the host's acknowledgement."""
    if not messages:
        return
    try:
        payload = ModelMessagesTypeAdapter.dump_json(messages).decode()
        sys.stdout.write(f"{CHECKPOINT_SENTINEL}{payload}\n")
        sys.stdout.flush()
        if os.environ.get("TAS_CHECKPOINT_ACK") == "1":
            ack = sys.stdin.readline().strip()
            if ack != "checkpoint":
                raise RuntimeError("checkpoint acknowledgement channel closed")
    except Exception as error:
        sys.stderr.write(f"[tas] checkpoint failed: {error}\n")


def _usage_from_history(messages) -> RunUsage:
    """Seed run usage from checkpointed responses for limits and final cost."""
    usage = RunUsage()
    for message in messages or []:
        if getattr(message, "kind", "") != "response":
            continue
        request_usage = getattr(message, "usage", None)
        if request_usage is not None:
            usage.incr(request_usage)
        usage.requests += 1
    return usage


def make_stream_handler(message_history=None):
    """Build the event handler that emits live deltas, tool activity, and usage."""
    previous_responses = sum(
        1
        for message in (message_history or [])
        if getattr(message, "kind", "") == "response"
    )
    prior_usage = _usage_from_history(message_history)
    state = {
        "step": previous_responses - 1,
        "prev_in": prior_usage.input_tokens,
        "prev_out": prior_usage.output_tokens,
    }

    async def handler(ctx, event_stream) -> None:
        _emit_checkpoint(getattr(ctx, "messages", None))
        node_counted = False
        async for event in event_stream:
            try:
                name = type(event).__name__
                if name in ("PartStartEvent", "PartDeltaEvent", "FinalResultEvent"):
                    if not node_counted:
                        state["step"] += 1
                        node_counted = True
                    step = state["step"]
                    if name == "PartDeltaEvent":
                        delta = getattr(event, "delta", None)
                        content = getattr(delta, "content_delta", None)
                        if isinstance(content, str) and content:
                            _emit_stream_line(DELTA_SENTINEL, {"t": content, "step": step})
                    elif name == "PartStartEvent":
                        part = getattr(event, "part", None)
                        content = getattr(part, "content", None)
                        if isinstance(content, str) and content:
                            _emit_stream_line(DELTA_SENTINEL, {"t": content, "step": step})
                elif name == "FunctionToolCallEvent":
                    part = getattr(event, "part", None)
                    tool_name = getattr(part, "tool_name", None)
                    call_id = getattr(part, "tool_call_id", None)
                    if tool_name:
                        _emit_stream_line(
                            PROGRESS_SENTINEL,
                            {
                                "kind": "tool_call",
                                "step": max(state["step"], 0),
                                "id": call_id,
                                "name": tool_name,
                            },
                        )
                elif name == "FunctionToolResultEvent":
                    result = getattr(event, "part", None) or getattr(
                        event, "result", None
                    )
                    call_id = getattr(result, "tool_call_id", None) or getattr(
                        event, "tool_call_id", None
                    )
                    result_kind = getattr(result, "part_kind", "") or ""
                    ok = result_kind.endswith("tool-return")
                    error = (
                        str(getattr(result, "content", ""))[:MAX_TOOL_ERROR_CHARS]
                        if (not ok and result_kind == "retry-prompt")
                        else None
                    )
                    if call_id:
                        _emit_stream_line(
                            PROGRESS_SENTINEL,
                            {
                                "kind": "tool_result",
                                "id": call_id,
                                "ok": ok,
                                "error": error,
                            },
                        )
            except Exception:
                pass
        if node_counted:
            try:
                usage = getattr(ctx, "usage", None)
                input_so_far = _usage_field(
                    usage, "input_tokens", "request_tokens"
                )
                output_so_far = _usage_field(
                    usage, "output_tokens", "response_tokens"
                )
                if input_so_far is not None or output_so_far is not None:
                    input_so_far = input_so_far or 0
                    output_so_far = output_so_far or 0
                    _emit_stream_line(
                        PROGRESS_SENTINEL,
                        {
                            "kind": "step_usage",
                            "step": state["step"],
                            "input_tokens": input_so_far - state["prev_in"],
                            "output_tokens": output_so_far - state["prev_out"],
                        },
                    )
                    state["prev_in"] = input_so_far
                    state["prev_out"] = output_so_far
            except Exception:
                pass

    return handler


def parse_spec(content: str, fmt: str) -> dict:
    if fmt == "yaml":
        loaded = yaml.safe_load(content)
    elif fmt == "json":
        loaded = json.loads(content)
    else:
        raise ValueError(f"unsupported spec format: {fmt!r}")
    if not isinstance(loaded, dict):
        raise ValueError("AgentSpec must parse to a top-level object")
    return loaded


def usage_payload(usage_obj) -> dict:
    """Normalize the usage fields reported across pydantic-ai versions."""
    if usage_obj is None:
        return {}
    out = {}
    for attr in (
        "input_tokens",
        "output_tokens",
        "request_tokens",
        "response_tokens",
        "total_tokens",
        "requests",
        "cache_read_tokens",
        "cache_write_tokens",
    ):
        value = getattr(usage_obj, attr, None)
        if value is not None:
            out[attr] = value
    uncached = _uncached_input(usage_obj)
    if uncached is not None:
        out["input_tokens"] = uncached
        out.pop("request_tokens", None)
    return out
