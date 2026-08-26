"""Pydantic AI runner wrapper invoked by api/src/runs/pydantic.rs.

Reads a one-line JSON launch envelope (AgentSpec plus optional typed message
history) from stdin, runs the agent against the user message passed on the CLI,
and prints the result to stdout. After that first line stdin becomes the
checkpoint acknowledgement channel. Mirrors the cargo-ai shellout shape so the
Rust runner has parallel knobs for both frameworks.

Auth: provider API keys come in via environment variables the
caller sets before spawn (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.).
pydantic-ai picks them up from the provider's SDK conventionally —
no constructor wiring needed.

Composio connections: when the spec declares `connections:` and
TAS_COMPOSIO_API_KEY + TAS_COMPOSIO_USER_ID are present in the
environment, we ask Composio for a Tool Router session scoped to the
declared toolkits and attach it to the Agent as an MCP toolset.
That's how slack / google-sheets / etc. become callable.

stdout protocol: free-form agent output, followed by a single
sentinel line `__TAS_USAGE__:{...json...}` carrying usage counts
when pydantic-ai reports them. The Rust runner strips the
sentinel before writing the user-facing transcript and feeds the
JSON into the run row's token columns.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
from datetime import datetime, timezone
import hashlib
import inspect
import json
import os
import sys
import tempfile
import traceback
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import httpx
import yaml

from pydantic_ai import Agent, ModelMessagesTypeAdapter, capture_run_messages
from pydantic_ai.usage import RunUsage, UsageLimits


USAGE_SENTINEL = "__TAS_USAGE__:"
TOOLS_SENTINEL = "__TAS_TOOLS__:"
STEPS_SENTINEL = "__TAS_STEPS__:"
# Live-streaming sentinels: emitted DURING the run (flushed immediately) so the
# runner can show partial output on the run page. DELTA carries incremental
# final-answer text; PROGRESS carries tool-call activity. Both are stripped
# from the final transcript (the authoritative output is printed at the end).
DELTA_SENTINEL = "__TAS_DELTA__:"
PROGRESS_SENTINEL = "__TAS_PROGRESS__:"
CHECKPOINT_SENTINEL = "__TAS_CHECKPOINT__:"

# Cap on a tool-call error message we persist for the run-step timeline. Long
# enough to keep a real error useful (API bodies, validation dumps, short
# tracebacks) now that the UI shows it expandably; bounded so one giant tool
# error can't bloat the row. Only the stored/displayed copy is capped — the
# model still sees the full retry-prompt content.
MAX_TOOL_ERROR_CHARS = 4000

# Sidecar Python tools: the agent's `tools_module:` sibling source, read
# from the repo by the web layer and handed to us via env. We exec it and
# expose its `tools = [...]` export to the agent as callable functions —
# deterministic work the model supervises instead of paying tokens for.
TOOLS_MODULE_ENV = "TAS_TOOLS_MODULE_CONTENT"

# Agent Skills: the files of the skills the agent opts into (`skills:`), keyed
# by repo path (e.g. "skills/pdf/SKILL.md"), JSON-encoded by the web layer. We
# materialize them to a temp dir and mount pydantic-ai-skills so the model can
# load_skill / read_skill_resource / run_skill_script — all local, in-process,
# any model. No Anthropic code-execution container involved.
SKILLS_ENV = "TAS_SKILLS_CONTENT"
RUN_STARTED_AT_ENV = "TAS_RUN_STARTED_AT"
FALLBACK_RUN_STARTED_AT = datetime.now(timezone.utc)


def get_run_datetime(timezone_name: str = "UTC") -> dict[str, str]:
    """Return this run's stable start date and time in an IANA timezone.

    Use this tool whenever a task depends on today's date, a relative date
    window, or a date-based deduplication key. The returned instant is frozen at
    the start of the run, so repeated calls cannot drift across a date boundary.
    `timezone_name` accepts IANA names such as `UTC` or `America/Los_Angeles`.
    """
    raw_started_at = os.environ.get(RUN_STARTED_AT_ENV)
    try:
        started_at = (
            datetime.fromisoformat(raw_started_at.replace("Z", "+00:00"))
            if raw_started_at
            else FALLBACK_RUN_STARTED_AT
        )
    except ValueError as e:
        raise ValueError(f"invalid {RUN_STARTED_AT_ENV} value: {raw_started_at!r}") from e
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    started_at = started_at.astimezone(timezone.utc)

    try:
        requested_timezone = ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError) as e:
        raise ValueError(
            f"unknown IANA timezone {timezone_name!r}; use a name such as "
            "'UTC' or 'America/Los_Angeles'"
        ) from e

    local = started_at.astimezone(requested_timezone)
    return {
        "run_started_at": started_at.isoformat().replace("+00:00", "Z"),
        "timezone": timezone_name,
        "local_datetime": local.isoformat(),
        "local_date": local.date().isoformat(),
        "local_time": local.time().isoformat(),
    }


def build_skills_toolset():
    """Materialize TAS_SKILLS_CONTENT to a temp dir and mount it.

    Returns a `SkillsToolset` (pydantic-ai-skills) pointed at the directory
    that holds the agent's opted-in skill folders, or None when no skills are
    declared / the package is unavailable. Files arrive keyed by repo path
    ("skills/<name>/SKILL.md"); we write them under a temp root and point the
    toolset at "<tmp>/skills" (the dir containing the skill folders). Skills
    run locally and in-process — no Anthropic container.
    """
    raw = os.environ.get(SKILLS_ENV)
    if not raw:
        return None
    try:
        files = json.loads(raw)
    except (ValueError, TypeError) as e:
        sys.stderr.write(f"[tas] skills: ignoring bad {SKILLS_ENV} json: {e}\n")
        return None
    if not isinstance(files, dict) or not files:
        return None

    try:
        from pydantic_ai_skills import SkillsToolset
    except ImportError:
        sys.stderr.write(
            "[tas] skills: pydantic-ai-skills not installed; running without "
            "the declared skills\n"
        )
        return None

    tmp = tempfile.mkdtemp(prefix="tas-skills-")
    for relpath, content in files.items():
        # Keep every write sandboxed under tmp — drop anything that escapes.
        safe = os.path.normpath(str(relpath)).lstrip("/")
        if safe.startswith(".."):
            continue
        dest = os.path.join(tmp, safe)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(content if isinstance(content, str) else str(content))

    skills_dir = os.path.join(tmp, "skills")
    if not os.path.isdir(skills_dir):
        return None
    names = sorted(
        n for n in os.listdir(skills_dir)
        if os.path.isdir(os.path.join(skills_dir, n))
    )
    if not names:
        return None
    sys.stderr.write(f"[tas] mounted {len(names)} skill(s): {names}\n")
    return SkillsToolset(directories=[skills_dir])


def load_tools_module(source: str) -> list:
    """Exec a sidecar tools module and return its `tools` export.

    The module must define a top-level `tools = [...]` list of callables;
    pydantic-ai derives each tool's JSON schema from the function
    signature + docstring. We expose only that explicit list — private
    helpers in the module stay private. The source is customer-owned repo
    code (lands via the same PR review as the spec) and runs single-tenant
    on the customer's server, so executing it is no more privileged than
    the agent itself. Raises ValueError with an actionable message so a
    bad module surfaces as a clear run failure.
    """
    # Make `import tas_tools` resolve to the helper shipped next to this
    # wrapper (the connection-credential bridge for tool I/O).
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)

    module_globals: dict = {"__name__": "tas_agent_tools"}
    try:
        code = compile(source, "<tas_tools_module>", "exec")
        # Trusted, customer-authored repo code — see docstring.
        exec(code, module_globals)  # noqa: S102
    except Exception as e:
        raise ValueError(f"failed to import tools_module: {e}") from e
    tools = module_globals.get("tools")
    if not isinstance(tools, list) or not tools:
        raise ValueError(
            "tools_module must define a non-empty top-level `tools = [...]` "
            "list of functions"
        )
    non_callable = [t for t in tools if not callable(t)]
    if non_callable:
        raise ValueError(
            "every entry in the tools_module `tools` list must be callable; "
            f"found {len(non_callable)} non-callable entry(ies)"
        )
    return tools


def tool_calls_payload(messages) -> list[dict]:
    """Extract the tool calls (name + outcome) from a run's message history.

    Works on both success and failure — `capture_run_messages` populates the
    list up to the point the run stopped, so a run that died before calling a
    tool simply won't list it. We classify by `part_kind`:
      - *-tool-call  → a call (capture its tool_call_id + name, in order)
      - retry-prompt → that call errored (the model got a retry)
      - *-tool-return → that call succeeded
    A call with no matching return is `ok: None` (the run ended first). We
    record only name + outcome — never args or results (secrets/PII/bloat).
    """
    calls: list[tuple[str, str]] = []  # (tool_call_id, name) in call order
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
                outcomes[cid] = {"ok": False, "error": str(content)[:MAX_TOOL_ERROR_CHARS]}
            elif kind.endswith("tool-return"):
                outcomes.setdefault(cid, {"ok": True, "error": None})
    out: list[dict] = []
    for cid, name in calls[:200]:
        o = outcomes.get(cid)
        if o is None:
            out.append({"name": name, "ok": None})
        else:
            out.append({"name": name, "ok": o["ok"], "error": o.get("error")})
    return out


def _usage_field(usage_obj, *names):
    """First non-None of `names` off a usage object, across version skew.

    pydantic-ai 1.x exposes input_tokens/output_tokens/cache_*; older releases
    used request_tokens/response_tokens. We read whatever is present.
    """
    if usage_obj is None:
        return None
    for n in names:
        val = getattr(usage_obj, n, None)
        if val is not None:
            return val
    return None


def _uncached_input(usage_obj):
    """Genuinely-new (uncached) input tokens.

    pydantic-ai's `input_tokens` is the TOTAL input — it INCLUDES the prompt-cache
    halves (cache reads + cache writes). The cost estimate prices cache reads at
    0.1x and writes at 1.25x SEPARATELY, so the recorded `input_tokens` must
    EXCLUDE them; otherwise every cached token is billed twice — once at the full
    input rate (inside input_tokens) and once at the cache rate. (For a long
    agentic run the cached prefix is re-sent every step, so this otherwise
    inflates the cost several-fold.) Returns None when no input is reported;
    clamps at 0.
    """
    total = _usage_field(usage_obj, "input_tokens", "request_tokens")
    if total is None:
        return None
    cr = _usage_field(usage_obj, "cache_read_tokens") or 0
    cw = _usage_field(usage_obj, "cache_write_tokens") or 0
    return max(0, total - cr - cw)


def steps_payload(messages) -> list[dict]:
    """Per model-request usage + the tool calls that request emitted.

    One ModelResponse == one LLM request (a "step"). Each carries its own usage
    and the ToolCallParts the model produced that turn; the call OUTCOMES
    (ok/error) arrive in the following request's tool-return / retry-prompt
    parts, keyed by tool_call_id — same classification as tool_calls_payload.
    Token attribution is per step, not per individual tool_use: a step can emit
    several tool calls that share the request's tokens. input_tokens are
    cumulative-by-nature (each request resends the history); output_tokens are
    what the model generated that step.
    """
    outcomes: dict[str, dict] = {}
    for msg in messages or []:
        for part in getattr(msg, "parts", None) or []:
            kind = getattr(part, "part_kind", "") or ""
            cid = getattr(part, "tool_call_id", None)
            if not cid:
                continue
            if kind == "retry-prompt":
                content = getattr(part, "content", "")
                outcomes[cid] = {"ok": False, "error": str(content)[:MAX_TOOL_ERROR_CHARS]}
            elif kind.endswith("tool-return"):
                outcomes.setdefault(cid, {"ok": True, "error": None})

    steps: list[dict] = []
    idx = 0
    for msg in messages or []:
        # ModelResponse.kind == "response"; ModelRequest is "request". Only
        # responses are LLM steps with usage.
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
            o = outcomes.get(cid) if cid else None
            if o is None:
                tools.append({"name": name, "ok": None})
            else:
                tools.append({"name": name, "ok": o["ok"], "error": o.get("error")})
        # The model's text for this step: a short "what I'm doing" line on
        # tool-calling steps (see OUTPUT_DISCIPLINE), or the final answer on the
        # last step. Both render inline in the run's step timeline, so capture
        # all of it — tool-step narration stays short; the final answer is kept
        # whole (just bounded so one runaway can't bloat the row).
        summary = " ".join(text_parts).strip() or None
        if summary is not None:
            summary = summary[:280] if tools else summary[:50_000]
        steps.append(
            {
                "step": idx,
                "summary": summary,
                "input_tokens": _uncached_input(usage_obj),
                "output_tokens": _usage_field(usage_obj, "output_tokens", "response_tokens"),
                "cache_read_tokens": _usage_field(usage_obj, "cache_read_tokens"),
                "cache_write_tokens": _usage_field(usage_obj, "cache_write_tokens"),
                "tool_calls": tools[:200],
            }
        )
        idx += 1
    return steps[:500]


def _emit_stream_line(sentinel: str, payload: dict) -> None:
    """Write a streaming sentinel line and flush immediately. Stdout is
    block-buffered when piped, so without the flush the runner wouldn't see
    deltas until the buffer fills (or the process exits) — defeating streaming.
    Best-effort: a broken pipe / serialization error must not fail the run."""
    try:
        sys.stdout.write(f"{sentinel}{json.dumps(payload)}\n")
        sys.stdout.flush()
    except Exception:
        pass


def _emit_checkpoint(messages) -> None:
    """Send a durable message-history checkpoint and wait for Postgres.

    The Rust parent acknowledges only after it has handled the checkpoint line.
    This tiny stdout/stdin handshake prevents the agent graph from advancing to
    the next node while the only copy of the completed node is still in memory.
    """
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
    except Exception as e:
        # Checkpointing is part of durable execution, but serialization should
        # never hide the agent's actual result. The parent logs DB failures.
        sys.stderr.write(f"[tas] checkpoint failed: {e}\n")


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
    """Build a pydantic-ai `event_stream_handler`. It's called once per graph
    node with an async stream of that node's events; we forward incremental
    model text (DELTA) + tool-call/result activity (PROGRESS) to stdout as they
    happen so the runner can build the run's step table live. We classify by
    class name to stay robust across pydantic-ai version skew, and step indexing
    matches the end-of-run __TAS_STEPS__ (one step per model request / response):
    model-request nodes carry the Part* events and bump the step counter; the
    following tool node's calls belong to that same step. Every event body is
    guarded — a streaming hiccup must never fail the run."""

    # Mutable across node invocations (each handler call is one node). prev_in /
    # prev_out track cumulative usage so we can emit each step's own usage delta.
    previous_responses = sum(
        1 for message in (message_history or [])
        if getattr(message, "kind", "") == "response"
    )
    prior_usage = _usage_from_history(message_history)
    state = {
        "step": previous_responses - 1,
        "prev_in": prior_usage.input_tokens,
        "prev_out": prior_usage.output_tokens,
    }

    async def handler(_ctx, event_stream) -> None:
        # At handler entry, pydantic-ai has committed the previous graph node to
        # ctx.messages. Persist it before this model/tool node is allowed to run.
        _emit_checkpoint(getattr(_ctx, "messages", None))
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
                    cid = getattr(part, "tool_call_id", None)
                    if tool_name:
                        _emit_stream_line(
                            PROGRESS_SENTINEL,
                            {
                                "kind": "tool_call",
                                "step": max(state["step"], 0),
                                "id": cid,
                                "name": tool_name,
                            },
                        )
                elif name == "FunctionToolResultEvent":
                    res = getattr(event, "part", None) or getattr(event, "result", None)
                    cid = getattr(res, "tool_call_id", None) or getattr(
                        event, "tool_call_id", None
                    )
                    rkind = getattr(res, "part_kind", "") or ""
                    ok = rkind.endswith("tool-return")
                    err = (
                        str(getattr(res, "content", ""))[:MAX_TOOL_ERROR_CHARS]
                        if (not ok and rkind == "retry-prompt")
                        else None
                    )
                    if cid:
                        _emit_stream_line(
                            PROGRESS_SENTINEL,
                            {"kind": "tool_result", "id": cid, "ok": ok, "error": err},
                        )
            except Exception:
                pass
        # A model-request node just finished — emit this step's own token usage
        # (cumulative-so-far minus the previous step) so In/Out fill in live as
        # each step completes, not only at the end. Best-effort: if the run
        # context doesn't expose usage here, the end-of-run __TAS_STEPS__ fills
        # the tokens in instead.
        if node_counted:
            try:
                usage = getattr(_ctx, "usage", None)
                # Report TOTAL input per step (the whole context the request
                # processed) to match the authoritative end-of-run __TAS_STEPS__,
                # which reads per-ModelResponse usage that carries no cache split
                # and so reports total input too. Feeding _uncached_input the
                # CUMULATIVE RunUsage here instead netted out the cached prefix
                # (re-sent every step), so live In showed ~0 until the run ended.
                input_so_far = _usage_field(usage, "input_tokens", "request_tokens")
                output_so_far = _usage_field(usage, "output_tokens", "response_tokens")
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
    """Pull whatever fields pydantic-ai reports into a flat dict.

    The Usage object's exact attribute set has shifted across
    pydantic-ai versions; we read defensively so a minor upstream
    rename doesn't crash the runner — the Rust side treats missing
    fields as None.
    """
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
        # Anthropic/OpenAI prompt-cache counters — the cache write (creation) and
        # read halves, priced separately (~1.25x / ~0.1x of input). The Rust side
        # uses them for the run's cost estimate.
        "cache_read_tokens",
        "cache_write_tokens",
    ):
        val = getattr(usage_obj, attr, None)
        if val is not None:
            out[attr] = val
    # pydantic-ai's input_tokens is the TOTAL input (incl. the cache halves above).
    # Record the UNCACHED input so the cost estimate, which prices cache reads/
    # writes separately, doesn't double-charge cached tokens. See _uncached_input.
    uncached = _uncached_input(usage_obj)
    if uncached is not None:
        out["input_tokens"] = uncached
        out.pop("request_tokens", None)  # old-name fallback is also cache-inclusive
    return out


def _coerce_source(value) -> str:
    """Connection source discriminator:
      - "native-mcp" → the provider's official MCP server
      - "secret"     → a workspace Secret (API key) read by sidecar tools;
                       attaches NO toolset and is invisible to the model
      - "composio"   → default; anything else (typos, older specs) falls
                       back to the well-trodden Composio path
    """
    if value == "native-mcp":
        return "native-mcp"
    if value == "secret":
        return "secret"
    return "composio"


def parse_connections(
    spec: dict,
) -> list[tuple[str, str, list[str], str]]:
    """Extract `connections:` as `[(toolkit, name, [tool_slug, …], source)]`.

    `name` is the user-scoped slot ("default", "work", "personal")
    that determines which row backs the slot at run time. `source`
    selects which substrate handles the connection:
      - "composio"  (default) → workspace_composio_connection +
                                Composio Tool Router
      - "native-mcp"          → workspace_connection + the provider's
                                official MCP server (TAS-managed OAuth)

    An empty tool list means "all tools from this toolkit"; a
    non-empty list narrows the Composio session. (Tool narrowing
    isn't yet honored for native-MCP — every tool the provider's
    MCP server exposes is available.)

    Accepted shapes (loose → most explicit):

        # Loose — slot defaults to "default", source = composio
        connections:
          - slack
          - googlesheets

        # Narrow tools, default slot
        connections:
          - slack: [SLACK_SEND_MESSAGE]
          - googlesheets: { tools: [GOOGLESHEETS_BATCH_GET] }

        # Named slot
        connections:
          - gmail: { name: work }
          - gmail: { name: personal, tools: [GMAIL_SEND_EMAIL] }

        # Native-MCP (TAS-managed OAuth, official provider MCP)
        connections:
          - { type: attio, source: native-mcp }
          - attio: { source: native-mcp, name: work }

        # Verbose form
        connections:
          - { type: slack, name: alt, tools: [SLACK_SEND_MESSAGE] }
    """
    raw = spec.get("connections")
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError(
            "`connections:` must be a list of toolkit slugs "
            "(e.g. `connections: [slack, googlesheets]`)"
        )
    out: list[tuple[str, str, list[str], str]] = []
    for item in raw:
        if isinstance(item, str):
            out.append((item.strip(), "default", [], "composio"))
            continue
        if not isinstance(item, dict):
            raise ValueError(
                f"`connections:` entry must be a string or object, "
                f"got {type(item).__name__}"
            )
        # Verbose form: `{type: slack, name: alt, tools: [...], source: ...}`.
        slug_from_verbose = item.get("type") or item.get("toolkit")
        if isinstance(slug_from_verbose, str):
            name = (
                str(item.get("name")).strip().lower()
                if isinstance(item.get("name"), str) and item.get("name").strip()
                else "default"
            )
            tools = _coerce_tools_value(item.get("tools"))
            source = _coerce_source(item.get("source"))
            out.append((slug_from_verbose.strip(), name, tools, source))
            continue
        # Compact form: `{slack: [...]}` or `{slack: {name, tools, source}}`.
        if len(item) == 1:
            slug, body = next(iter(item.items()))
            name = "default"
            source = "composio"
            if isinstance(body, dict):
                if isinstance(body.get("name"), str) and body.get("name").strip():
                    name = body["name"].strip().lower()
                source = _coerce_source(body.get("source"))
            tools = _coerce_tools_value(body)
            out.append((str(slug).strip(), name, tools, source))
            continue
        raise ValueError(
            f"`connections:` entry has no toolkit slug: {item!r}"
        )
    return [(slug, name, tools, source)
            for (slug, name, tools, source) in out if slug]


def _coerce_tools_value(value) -> list[str]:
    """Accept either a raw list (compact form) or a dict with a
    `tools:` key (verbose form). Anything else means "all tools"."""
    if isinstance(value, list):
        return [str(t).strip() for t in value if isinstance(t, str) and t.strip()]
    if isinstance(value, dict):
        inner = value.get("tools")
        if isinstance(inner, list):
            return [str(t).strip() for t in inner if isinstance(t, str) and t.strip()]
    return []


COMPOSIO_TOOL_USE_PREAMBLE_LOOSE = """\
You are an automated agent running inside Tembo Agent Studio. \
This run was triggered by a user or a schedule — it is not an \
interactive chat. When you reply, your message goes into a run log \
the user reviews later; nobody is on the other end to answer \
follow-up questions in real time.

You have these Composio tool-router meta-tools available:

- `COMPOSIO_SEARCH_TOOLS` — find specific tools by natural-language \
description.
- `COMPOSIO_GET_TOOL_SCHEMAS` — fetch the input schema for one or more \
tool slugs.
- `COMPOSIO_MULTI_EXECUTE_TOOL` — invoke one or more tools.

Authorized toolkits for this agent: {toolkits}. The workspace has \
already authorized these connections; do not ask the user to authorize \
anything.

Default behaviour: read your agent instructions below, search for the \
tools you need, execute them, and reply with a short summary of what \
happened. Treat any user message (including an empty one) as "go do \
the job"; the instructions below tell you what the job is.

--- Agent instructions ---
"""

COMPOSIO_TOOL_USE_PREAMBLE_DIRECT = """\
You are an automated agent running inside Tembo Agent Studio. \
This run was triggered by a user or a schedule — it is not an \
interactive chat. When you reply, your message goes into a run log \
the user reviews later; nobody is on the other end to answer \
follow-up questions in real time.

The tools you need are already attached to this session — call them \
directly by name.

Authorized toolkits for this agent: {toolkits}. The workspace has \
already authorized these connections; do not ask the user to authorize \
anything.

Default behaviour: read your agent instructions below, call the \
attached tools to do the job, and reply with a short summary of what \
happened. Treat any user message (including an empty one) as "go do \
the job"; the instructions below tell you what the job is.

--- Agent instructions ---
"""

# Appended to EVERY pydantic agent's instructions (connected or not). Agents
# were narrating their steps and echoing raw tool output into replies, which
# burns the output-token budget for no benefit — the reply lands in a run log,
# not a chat. This targets process-narration, NOT the size of the actual
# deliverable: an agent whose job is a long report still writes the report.
OUTPUT_DISCIPLINE = """\
--- Output discipline (applies to every run) ---
Work silently. Do your reasoning and planning internally — do NOT think out \
loud or echo raw tool output / intermediate results. ONE exception: right \
before a batch of tool calls you MAY write a single short line (max ~12 words) \
naming what you're about to do, e.g. "Fetching the pipeline records." — never \
more than one line, never the tool output. Your FINAL reply must contain only \
the result the task calls for, as briefly as the task allows; do not restate \
the task or list your steps there. Output tokens are a finite budget — \
reasoning dumps and progress commentary waste it. If the task produces no \
user-facing result, reply with a single short line saying so."""

# Appended alongside OUTPUT_DISCIPLINE. Agents that fan out many calls to one
# provider (e.g. running an Attio report repeatedly in parallel) get rate-limited
# every time. The model controls parallelism by how many tool calls it emits per
# turn, so the actionable instruction is "go sequential, and back off on 429s".
TOOL_USE_DISCIPLINE = """\
--- Tool use ---
Call tools SEQUENTIALLY, not in parallel — most providers (Attio, HubSpot, etc.) \
rate-limit, and parallel bursts get rejected. Never issue the same tool many \
times at once: make one call, wait for its result, then the next. If a tool \
returns a rate-limit or "retry after" error, do NOT immediately re-issue it — \
do other useful work first, then retry that one call later, once, on its own. \
Never retry the same failing call repeatedly in a tight loop."""


# ── ScaleDown prompt compression ─────────────────────────────────────────────
# Optional: when the workspace set a ScaleDown key (TAS_SCALEDOWN_API_KEY) AND
# the agent opts in via `scaledown:` in its spec, route bulky prompt/context
# through ScaleDown (https://scaledown.ai) before frontier-model calls to cut
# tokens. Best-effort end to end — any error/timeout falls back to the original
# text so a run never breaks.
#
# Modes (spec `scaledown:` — string shorthand, bool, or object):
#   off (default) — no compression.
#   prompt        — compress the static instructions ONCE at startup. Safe and
#                   cache-friendly: identical compressed instructions every turn,
#                   so Anthropic prompt caching still hits.
#   aggressive    — also compress large history blocks (tool outputs, user
#                   context) via a history processor, COMPRESS-ONCE-AND-FREEZE:
#                   each block is compressed the first time it's seen and the
#                   result memoized for the rest of the run, so bytes stay stable
#                   across turns and the prefix re-stabilizes for prompt caching
#                   instead of thrashing it. The most recent message is left
#                   verbatim (it's the live prompt and the churning cache tail).
SCALEDOWN_API_URL = os.environ.get("SCALEDOWN_API_URL", "https://api.scaledown.xyz")
# Only compress text bigger than this (~4 chars/token) — below it a network
# round-trip isn't worth the savings.
SCALEDOWN_DEFAULT_MIN_CHARS = 1600
# Only compress completed tool-return content — the bulky, already-consumed
# outputs that are re-sent every turn. We deliberately leave user/system prompts
# (the task + instructions) and the model's own TextParts intact, and never
# touch tool-call args or tool_use/tool_result pairing.
SCALEDOWN_COMPRESSIBLE_PARTS = {"tool-return"}
# Emitted once at end of run so the run row can show what compression saved.
SCALEDOWN_SENTINEL = "__TAS_SCALEDOWN__:"
# Run-level totals across every compression (each unique block counts once — the
# processor memoizes — plus the one-time instructions compression).
_SCALEDOWN_TOTALS = {"original_tokens": 0, "compressed_tokens": 0, "blocks": 0}


def _scaledown_payload() -> dict | None:
    """The run's compression totals for the end-of-run sentinel, or None if
    nothing was compressed."""
    return dict(_SCALEDOWN_TOTALS) if _SCALEDOWN_TOTALS["blocks"] > 0 else None


def _scaledown_key() -> str | None:
    k = os.environ.get("TAS_SCALEDOWN_API_KEY")
    return k if isinstance(k, str) and k.strip() else None


def _scaledown_settings(spec: dict) -> tuple[bool, str, int]:
    """(enabled, rate, min_chars) from the agent's `scaledown:` field.

    The only real knobs are on/off, the compression `rate` (ScaleDown's lever),
    and `min_tokens` (how big the history must be before we bother). Accepted:
      scaledown: off|false        → disabled (default)
      scaledown: auto|true|on     → enabled, rate=auto
      scaledown: 0.5              → enabled, rate=0.5 (target ~50% of tokens)
      scaledown: { rate: auto|0.5, min_tokens: 400 }
    Lenient: any other non-off string (e.g. legacy "prompt"/"aggressive") enables
    at rate=auto, so existing specs keep working."""
    raw = spec.get("scaledown")
    rate, min_chars = "auto", SCALEDOWN_DEFAULT_MIN_CHARS
    if raw is None or raw is False:
        return False, rate, min_chars
    if raw is True:
        return True, rate, min_chars
    if isinstance(raw, (int, float)):  # numeric rate, e.g. 0.5
        return True, str(raw), min_chars
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in ("off", "false", "no", "none", "disabled", ""):
            return False, rate, min_chars
        try:
            float(s)  # numeric string rate
            rate = s
        except ValueError:
            pass  # "auto"/"on"/legacy "prompt"/"aggressive" → enabled at auto
        return True, rate, min_chars
    if isinstance(raw, dict):
        if str(raw.get("mode", "")).strip().lower() in ("off", "false", "disabled"):
            return False, rate, min_chars
        if raw.get("enabled") is False:
            return False, rate, min_chars
        r = raw.get("rate")
        if isinstance(r, (str, int, float)) and not isinstance(r, bool):
            rate = str(r)
        if isinstance(raw.get("min_tokens"), int):
            min_chars = raw["min_tokens"] * 4
        elif isinstance(raw.get("min_chars"), int):
            min_chars = raw["min_chars"]
        return True, rate, max(1, min_chars)
    return False, rate, min_chars


def _scaledown_compress(context: str, prompt: str, rate: str) -> str:
    """Optimize one model-request prompt via ScaleDown's /compress/raw/.

    Per the API ref: `context` is the OLD/background text (conversation history)
    ScaleDown compresses; `prompt` is the NEW step's input, kept intact to
    preserve intent. Both required, non-empty. Returns `compressed_prompt` (the
    optimized prompt). Best-effort: returns `context` unchanged on any
    error/missing key/empty prompt so a run never breaks. Synchronous — call via
    asyncio.to_thread from async contexts."""
    key = _scaledown_key()
    if not key or not isinstance(context, str) or not context.strip():
        return context
    if not (isinstance(prompt, str) and prompt.strip()):
        return context  # ScaleDown requires a non-empty prompt; skip this step
    url = f"{SCALEDOWN_API_URL}/compress/raw/"
    try:
        print(
            f"[scaledown] POST {url} (context={len(context)}c prompt={len(prompt)}c)",
            file=sys.stderr,
        )
        resp = httpx.post(
            url,
            headers={"x-api-key": key, "Content-Type": "application/json"},
            json={
                "context": context,
                "prompt": prompt,
                "scaledown": {"rate": rate},
            },
            timeout=30,
        )
        print(f"[scaledown] -> HTTP {resp.status_code}", file=sys.stderr)
        resp.raise_for_status()
        data = resp.json() or {}
        # The API has shipped both flat and nested ({results:{...}}) shapes.
        results = data.get("results") if isinstance(data.get("results"), dict) else data
        compressed = results.get("compressed_prompt")
        if not (isinstance(compressed, str) and compressed.strip()):
            print(
                "[scaledown] no compressed_prompt in response; keys="
                + repr(list(data.keys())[:10])
                + " body=" + json.dumps(data)[:400],
                file=sys.stderr,
            )
        if isinstance(compressed, str) and compressed.strip():
            orig = data.get("original_prompt_tokens") or results.get("original_prompt_tokens")
            comp = data.get("compressed_prompt_tokens") or results.get("compressed_prompt_tokens")
            print(
                f"[scaledown] ok orig={orig} comp={comp} "
                f"context={len(context)}c out={len(compressed)}c head={compressed[:200]!r}",
                file=sys.stderr,
            )
            if isinstance(orig, int) and isinstance(comp, int) and orig > 0:
                _SCALEDOWN_TOTALS["original_tokens"] += orig
                _SCALEDOWN_TOTALS["compressed_tokens"] += comp
                _SCALEDOWN_TOTALS["blocks"] += 1
            return compressed
    except Exception as e:  # noqa: BLE001 — best-effort, never break a run
        print(f"[scaledown] compress failed, using original: {e}", file=sys.stderr)
    return context


def _msg_text(msg) -> str:
    """Concatenate one message's content for the old-context vs new-turn split.
    Includes string parts (system/user/tool-return text + model text) AND
    stringified structured tool-return content (e.g. a tool that returns a
    list/dict) — that structured output is usually the bulkiest thing in an
    agentic history, so it's exactly what's worth compressing."""
    chunks: list[str] = []
    for part in getattr(msg, "parts", None) or []:
        content = getattr(part, "content", None)
        if isinstance(content, str):
            if content.strip():
                chunks.append(content)
        elif content is not None:
            try:
                chunks.append(json.dumps(content, default=str))
            except Exception:
                chunks.append(str(content))
    return "\n\n".join(chunks)


def _first_user_text(messages: list) -> str:
    """The agent's task — the first user-prompt text in the history. Used as the
    ScaleDown `prompt` (the intent to preserve when compressing old context).
    Stable across the run, so compression is deterministic + cache-friendly."""
    for msg in messages:
        for part in getattr(msg, "parts", None) or []:
            if getattr(part, "part_kind", "") == "user-prompt":
                content = getattr(part, "content", None)
                if isinstance(content, str) and content.strip():
                    return content
    return "Complete the user's task using the prior context."


def _make_scaledown_processor(rate: str, min_chars: int):
    """A pydantic-ai history processor that compresses bulky OLD tool outputs in
    place. Per ScaleDown's model: each big completed tool-result is the `context`
    to compress; the agent's task is the `prompt` (intent to preserve).

    STRUCTURALLY SAFE: it only rewrites the *content* of `tool-return` parts in
    earlier turns (never removes/reorders messages, never touches tool-call args
    or the newest turn) — so tool_use/tool_result pairing stays intact. Compress-
    once-and-freeze (memoized per original content) keeps bytes stable so
    Anthropic prompt caching still hits. Best-effort end to end."""
    memo: dict[str, str] = {}

    async def _shrink(text: str, prompt: str) -> str:
        if not isinstance(text, str) or len(text) < min_chars:
            return text
        try:
            h = hashlib.sha256(text.encode("utf-8")).hexdigest()
            if h not in memo:
                memo[h] = await asyncio.to_thread(
                    _scaledown_compress, text, prompt, rate
                )
            return memo[h]
        except Exception:  # noqa: BLE001 — optimization, never break a run
            return text

    async def process(messages: list) -> list:
        # Hard guarantee: ScaleDown is an optimization, never a dependency. Any
        # failure falls back to the original history so the run never breaks.
        try:
            if not _scaledown_key() or len(messages) < 2:
                return messages
            prompt = _first_user_text(messages)
            out = list(messages)
            # Leave the newest turn intact; compress big tool-returns in earlier
            # turns. Only `content` is swapped — message/part structure is kept.
            for i in range(len(out) - 1):
                msg = out[i]
                parts = getattr(msg, "parts", None)
                if not parts:
                    continue
                new_parts = list(parts)
                changed = False
                for j, part in enumerate(new_parts):
                    if getattr(part, "part_kind", "") not in SCALEDOWN_COMPRESSIBLE_PARTS:
                        continue
                    content = getattr(part, "content", None)
                    if isinstance(content, str):
                        text = content
                    elif content is not None:
                        try:
                            text = json.dumps(content, default=str)
                        except Exception:
                            continue
                    else:
                        continue
                    shrunk = await _shrink(text, prompt)
                    if shrunk != text:
                        try:
                            new_parts[j] = dataclasses.replace(part, content=shrunk)
                            changed = True
                        except Exception:
                            pass  # not a dataclass — leave untouched
                if changed:
                    try:
                        out[i] = dataclasses.replace(msg, parts=new_parts)
                    except Exception:
                        out[i] = msg
            return out
        except Exception as e:  # noqa: BLE001 — never let compression fail a run
            print(
                f"[scaledown] history processor error, using original history: {e}",
                file=sys.stderr,
            )
            return messages

    return process


def _build_capabilities(spec: dict) -> list:
    """Translate the AgentSpec `capabilities:` list into pydantic-ai capability
    objects, passed to `Agent(capabilities=[...])`.

    Today this wires `WebSearch` -> pydantic-ai's provider-adaptive WebSearch
    capability: it uses the provider's native web search where available (e.g.
    Anthropic's `web_search` on Claude, OpenAI's), with a local fallback
    otherwise. Each entry is either a bare name (`WebSearch`) or a single-key map
    (`WebSearch: { ...config }`) — the map's config is forwarded to the
    capability when it accepts those kwargs. Unknown/uninwired capabilities
    (e.g. `Thinking`, handled via model_settings) are logged and skipped — a typo
    or an unsupported capability must never break agent construction.
    """
    caps = spec.get("capabilities")
    if not isinstance(caps, list) or not caps:
        return []
    out: list = []
    for entry in caps:
        if isinstance(entry, str):
            name, cfg = entry, {}
        elif isinstance(entry, dict) and len(entry) == 1:
            name, cfg = next(iter(entry.items()))
            if not isinstance(cfg, dict):
                cfg = {}
        else:
            print(
                f"[capabilities] skipping unrecognized entry: {entry!r}",
                file=sys.stderr,
            )
            continue
        key = name.strip().lower() if isinstance(name, str) else ""
        if key in ("websearch", "web_search"):
            try:
                from pydantic_ai.capabilities import WebSearch
            except Exception as e:  # noqa: BLE001 — version skew must not be fatal
                print(
                    f"[capabilities] WebSearch unavailable in this pydantic-ai "
                    f"build: {e}",
                    file=sys.stderr,
                )
                continue
            try:
                out.append(WebSearch(**cfg) if cfg else WebSearch())
            except TypeError as e:
                # A config key the capability doesn't accept — fall back to the
                # default rather than failing the whole run.
                print(
                    f"[capabilities] WebSearch config {cfg!r} rejected ({e}); "
                    f"using defaults",
                    file=sys.stderr,
                )
                out.append(WebSearch())
            print("[capabilities] enabled WebSearch", file=sys.stderr)
        else:
            print(
                f"[capabilities] '{name}' is not wired as a capability; ignoring",
                file=sys.stderr,
            )
    return out


def build_agent(
    spec: dict,
    toolsets: list | None = None,
    connections: list[str] | None = None,
    direct_tools: bool = False,
    tools: list | None = None,
) -> Agent:
    """Construct a pydantic_ai.Agent from a TAS AgentSpec dict.

    pydantic-ai 1.x has no `Agent.from_spec` / `from_file` factory
    (despite some upstream docs still referencing it), so we hand-map
    the AgentSpec fields onto the Agent(...) constructor kwargs.

    This hand-mapping is an explicit allow-list, and that is a
    load-bearing contract: we read only the keys below and never
    `Agent(**spec)`. Unknown top-level keys are ignored by design, which
    is what lets TAS carry its own extension metadata in the spec file
    (e.g. `labels:` for inventory grouping + Slack-app scoping) without it
    reaching a pydantic `extra="forbid"` boundary. See
    context/shipped/0.1/AGENT_FORMAT.md -> "TAS extension fields". If you
    ever switch to a strict spec loader, keep TAS fields allow-listed or
    labelled agents will fail at run time.

    `toolsets` is the Composio MCP toolset list when the agent
    declared `connections:`; otherwise None (no tools). When
    connections are present, we prepend an explanatory preamble to
    the agent's instructions so the model knows the Composio meta
    tools exist and how to use them — without this, models tend to
    hedge ("just say the word") because the agent's own
    instructions reference services in natural language and the
    model can't connect them to the tool surface.

    `capabilities:` is translated to pydantic-ai capabilities by
    `_build_capabilities` — currently `WebSearch` -> the provider-adaptive
    WebSearch capability. Other capabilities (e.g. `Thinking`) aren't wired here
    yet.

    Out of scope for this MVP path:
      - output_schema (would need to dynamically build a Pydantic
        model from the JSON schema; defaulting to str output)
      - deps_schema (deps come from the caller; runtime supplies none)
    """
    model = spec.get("model")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("AgentSpec is missing a non-empty `model` string")

    kwargs = {}
    instructions = spec.get("instructions")
    if isinstance(instructions, str) and instructions.strip():
        if connections:
            template = (
                COMPOSIO_TOOL_USE_PREAMBLE_DIRECT
                if direct_tools
                else COMPOSIO_TOOL_USE_PREAMBLE_LOOSE
            )
            preamble = template.format(toolkits=", ".join(connections))
            base = preamble + instructions
        else:
            base = instructions
    else:
        base = ""
    # Append the global output- + tool-use discipline to whatever the agent
    # declared (or send them alone when the agent has no instructions). Applies
    # to every pydantic run so agents stop narrating/dumping output and stop
    # hammering rate-limited providers with parallel calls.
    kwargs["instructions"] = (
        (base + "\n\n" if base else "")
        + OUTPUT_DISCIPLINE
        + "\n\n"
        + TOOL_USE_DISCIPLINE
    )
    name = spec.get("name")
    if isinstance(name, str) and name.strip():
        kwargs["name"] = name
    # Provider-adaptive capabilities from `capabilities:` (e.g. WebSearch).
    # Built before model settings because WebSearch changes which settings are
    # legal (see below).
    capabilities = _build_capabilities(spec)
    has_web_search = any(type(c).__name__ == "WebSearch" for c in capabilities)

    # Default to SEQUENTIAL tool calls. parallel_tool_calls=False is a real,
    # API-level limiter (OpenAI parallel_tool_calls / Anthropic
    # disable_parallel_tool_use): the model emits one tool call per turn instead
    # of fanning out many at once, which is what was getting Attio (and other
    # providers) rate-limited. An agent that genuinely needs parallel calls can
    # opt back in with model_settings.parallel_tool_calls: true in its spec.
    # EXCEPT WebSearch on Anthropic: the current web_search tool runs with
    # server-side programmatic tool calling, and the API rejects
    # `tool_choice.disable_parallel_tool_use: true` combined with it (400) as
    # soon as the agent also has any client/MCP tool. Skip the default there —
    # pydantic-ai only emits disable_parallel_tool_use when the key is present.
    anthropic_web_search = (
        has_web_search and isinstance(model, str) and model.startswith("anthropic:")
    )
    model_settings = spec.get("model_settings")
    ms = dict(model_settings) if isinstance(model_settings, dict) else {}
    if not anthropic_web_search:
        ms.setdefault("parallel_tool_calls", False)
    elif "parallel_tool_calls" in ms:
        print(
            "[capabilities] WebSearch on Anthropic is incompatible with the "
            "parallel_tool_calls setting (programmatic tool calling); "
            "dropping it for this run",
            file=sys.stderr,
        )
        ms.pop("parallel_tool_calls", None)
    # Anthropic prompt caching. An agentic run re-sends the whole prompt every
    # step; without caching the big static prefix — system instructions + the
    # MCP/Composio tool schemas — is re-billed at full input rate on each of the
    # (often 10+) steps. These breakpoints let Anthropic charge the repeated
    # prefix at the cache-read rate (~0.1x) after the first step, with a small
    # one-time write surcharge (~1.25x). `anthropic_cache` adds an auto-rolling
    # breakpoint that follows the growing conversation; pydantic-ai trims to stay
    # within Anthropic's 4-slot limit. Default 5m TTL fits a single run's burst.
    # Anthropic-only settings — applying them to OpenAI models would error, so
    # gate on the provider prefix. A spec can still override via model_settings.
    if isinstance(model, str) and model.startswith("anthropic:"):
        ms.setdefault("anthropic_cache_instructions", True)
        ms.setdefault("anthropic_cache_tool_definitions", True)
        ms.setdefault("anthropic_cache", True)
        # Long streaming turns need more than the provider default. Keep this in
        # Pydantic AI's provider-neutral settings so its Anthropic adapter can
        # translate the value for the SDK's current transport (`httpx` before
        # Anthropic 1.0, `httpx2` after) instead of constructing a client with a
        # transport-specific Timeout object here.
        ms.setdefault("timeout", 300.0)
    kwargs["model_settings"] = ms
    retries = spec.get("retries")
    if isinstance(retries, int):
        kwargs["retries"] = retries
    if toolsets:
        kwargs["toolsets"] = toolsets
    # Sidecar Python functions from the agent's `tools_module:`. These
    # coexist with MCP/Composio toolsets — pydantic-ai exposes both to
    # the model. Schemas are derived from each function's signature +
    # docstring, so well-documented functions get good tool schemas.
    # Every TAS run gets a deterministic clock without requiring an external
    # connection. Sidecar tools remain additive to this built-in surface.
    kwargs["tools"] = [get_run_datetime, *(tools or [])]

    # Capabilities were built up top (before model settings); attach them here.
    if capabilities:
        kwargs["capabilities"] = capabilities

    # `instrument: true` — pydantic-ai 2.x replaced Agent(instrument=...) with
    # the Instrumentation capability.
    if spec.get("instrument") is True:
        from pydantic_ai.capabilities import Instrumentation

        kwargs.setdefault("capabilities", []).append(Instrumentation())

    # ScaleDown prompt compression — opt-in per agent via `scaledown:`, and only
    # when the workspace set a key. Any non-`off` mode attaches a history
    # processor that optimizes each model request (old history = context to
    # compress, new turn = prompt kept intact). Wrapped so a bad `scaledown:`
    # value can never fail agent construction — the agent just runs uncompressed.
    try:
        sd_enabled, sd_rate, sd_min_chars = _scaledown_settings(spec)
        # Always log the resolved config so a missing/ignored compression is
        # diagnosable from the run/container logs.
        print(
            f"[scaledown] config: raw={spec.get('scaledown')!r} "
            f"enabled={sd_enabled} rate={sd_rate} min_chars={sd_min_chars} "
            f"key={'set' if _scaledown_key() else 'missing'}",
            file=sys.stderr,
        )
        if sd_enabled and _scaledown_key():
            from pydantic_ai.capabilities import ProcessHistory

            kwargs.setdefault("capabilities", []).append(
                ProcessHistory(_make_scaledown_processor(sd_rate, sd_min_chars))
            )
    except Exception as e:  # noqa: BLE001 — never block a run on compression setup
        print(f"[scaledown] setup skipped: {e}", file=sys.stderr)

    return Agent(model, **kwargs)


def build_composio_toolset(
    connections: list[tuple[str, str, list[str], str]],
):
    """Create a Composio Tool Router session for the declared toolkits
    and wrap it in an MCPToolset so pydantic-ai can call the tools.
    (Streamable HTTP is `MCPToolset`'s default transport for HTTP URLs.)

    Only entries with source="composio" are folded into the session;
    native-MCP entries are handled by `build_native_mcp_toolsets`
    instead. Returns `(mcp, used_direct_tools)`.

    `used_direct_tools` is True when every declared composio toolkit
    narrowed its tool list — in that case we use the DIRECT_TOOLS
    preset, preload only those tool schemas, and skip the
    search/execute meta-tools entirely (much cheaper per run).
    Otherwise we fall back to the default Tool Router with the
    search + multi-execute meta-tools (cheap input context, but the
    model spends extra round trips discovering tools).

    Returns `(None, False)` when no composio entries are declared.
    """
    connections = [
        (tk, name, tools, source)
        for (tk, name, tools, source) in connections
        if source == "composio"
    ]
    if not connections:
        return (None, False)

    api_key = os.environ.get("TAS_COMPOSIO_API_KEY")
    user_id = os.environ.get("TAS_COMPOSIO_USER_ID")
    if not api_key:
        raise ValueError(
            "Agent declares `connections:` but no Composio API key is "
            "set for this workspace. Add it under Settings → Composio API key."
        )
    if not user_id:
        raise ValueError(
            "Agent declares `connections:` but the Composio user_id was "
            "not provided by the runner (TAS_COMPOSIO_USER_ID missing)."
        )

    # Imports are deferred so workspaces that never use connections
    # don't pay the import cost (and so a broken composio install
    # doesn't crash agents that don't need it).
    from composio import Composio
    from pydantic_ai.mcp import MCPToolset

    # The Rust runner pre-resolves the workspace's active connections
    # from workspace_composio_connection and ships them as a JSON map
    # `{toolkit_slug: composio_connection_id}`. Composio's Tool Router
    # session does NOT auto-discover the user's active connections
    # when manage_connections=False — passing `connected_accounts`
    # explicitly is what makes them show up as is_active in the
    # session and therefore exposes their tools to the agent.
    # Rust runner ships the nested map `{toolkit: {name: connection_id}}`.
    # Each declared (toolkit, name) slot resolves to a specific
    # connection_id below. Composio's Tool Router needs the explicit
    # connected_accounts pass when manage_connections=false; otherwise
    # the session reports the toolkits inactive even when the user
    # authorized them.
    accounts_json = os.environ.get("TAS_COMPOSIO_CONNECTED_ACCOUNTS")
    nested: dict[str, dict[str, str]] = {}
    if accounts_json:
        try:
            parsed = json.loads(accounts_json)
            if isinstance(parsed, dict):
                for tk, inner in parsed.items():
                    if isinstance(inner, dict):
                        nested[str(tk)] = {
                            str(k): str(v)
                            for k, v in inner.items()
                            if isinstance(v, str)
                        }
        except json.JSONDecodeError:
            pass

    resolved: dict[str, str] = {}
    missing: list[str] = []
    for (toolkit, name, _tools, _source) in connections:
        inner = nested.get(toolkit, {})
        cid = inner.get(name)
        # Single-connection fallback (mirrors build_native_mcp_toolsets and the
        # sidebar's isAgentConnectionMissing): the agent pins a slot by name but
        # the user authorized this toolkit under exactly one differently-named
        # connection — use it regardless of the declared name.
        if cid is None and len(inner) == 1:
            cid = next(iter(inner.values()))
        if cid is None:
            slot_label = toolkit if name == "default" else f"{toolkit}/{name}"
            missing.append(slot_label)
        else:
            resolved[toolkit] = cid
    if missing:
        raise ValueError(
            "Agent declares connections "
            f"{missing!r} but the run's acting user has no active "
            "Composio connection for them. Authorize them under "
            "Settings → Connections and try again."
        )

    # Narrowed tools per toolkit — only included when the agent
    # specified explicit slugs. When every slot is narrowed we flip
    # to DIRECT_TOOLS so only those schemas land in the model's
    # context (no search/execute meta-tools, no extra round trip).
    tools_param: dict[str, list[str]] = {
        toolkit: tools for (toolkit, _name, tools, _source) in connections if tools
    }
    all_narrowed = bool(connections) and all(
        bool(tools) for (_, _, tools, _source) in connections
    )

    composio = Composio(api_key=api_key)
    create_kwargs: dict = {
        "user_id": user_id,
        "toolkits": sorted({tk for (tk, _, _, _) in connections}),
        "connected_accounts": resolved,
        "manage_connections": False,
        "workbench": {"enable": False},
    }
    if tools_param:
        create_kwargs["tools"] = tools_param
    if all_narrowed:
        from composio import SESSION_PRESET_DIRECT_TOOLS
        create_kwargs["session_preset"] = SESSION_PRESET_DIRECT_TOOLS

    try:
        session = composio.create(**create_kwargs)
    except Exception as exc:
        _maybe_emit_stale_connection_marker(exc, connections, resolved)
        raise
    mcp = MCPToolset(
        session.mcp.url,
        headers={"x-api-key": api_key},
    )
    return (mcp, all_narrowed)


# Sentinel the runner watches for on stderr. When Composio rejects
# session.create with `ToolRouterV2_InvalidConnectedAccountIds`, the
# cached `composio_connection_id` in our DB no longer matches a
# connection that user actually owns on Composio's side (revoked,
# deleted in their dashboard, replaced by a fresher account). The
# wrapper itself can't reach Postgres — it emits a structured marker
# and the Rust runner translates that into a clean failure message +
# flips the local row's status so the sidebar surfaces a Connect
# alert.
STALE_CONNECTION_MARKER = "__TAS_STALE_CONNECTION__"


def build_native_mcp_toolsets(
    connections: list[tuple[str, str, list[str], str]],
) -> list:
    """One MCPToolset per declared (provider, name) native-MCP entry,
    with the user's bearer token in the Authorization header. Returns
    [] if no native entries are declared. (`MCPToolset` is the v1.x
    replacement for the deprecated `MCPServerStreamableHTTP`;
    streamable HTTP is its default transport for HTTP URLs.)

    Honors `tools:` narrowing on a native-mcp entry by wrapping the
    raw MCP toolset in a FilteredToolset (via `.filtered(...)`) so
    only the named tools land in the model's context. Slug match is
    exact — case + separators are provider-determined (Attio uses
    kebab-case, others may not), so the caller is expected to copy
    slugs verbatim from the Tools tab. Empty/absent tools list ⇒ no
    filter, every tool the MCP server exposes is available.

    Credentials come in via env var TAS_NATIVE_MCP_CONNECTIONS as
    nested JSON `{provider: {name: {mcp_url, access_token}}}`. The
    Rust runner builds it after decrypting each row's credentials —
    we do no DB work here.

    A declared slot with no matching row in the env JSON is a hard
    failure: the runner already filters to ACTIVE rows for the
    acting user, so a missing slot means the user never authorized
    that provider (or the connection went stale and was deleted).
    """
    native = [
        (provider, name, tools)
        for (provider, name, tools, source) in connections
        if source == "native-mcp"
    ]
    if not native:
        return []

    raw = os.environ.get("TAS_NATIVE_MCP_CONNECTIONS")
    nested: dict[str, dict[str, dict[str, str]]] = {}
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                for provider, inner in parsed.items():
                    if isinstance(inner, dict):
                        nested[str(provider)] = {
                            str(name): {str(k): str(v) for k, v in entry.items()}
                            for name, entry in inner.items()
                            if isinstance(entry, dict)
                        }
        except json.JSONDecodeError:
            pass

    # Deferred import — agents that don't use native MCP don't pay
    # the import cost (matches the composio-side pattern).
    from pydantic_ai.mcp import MCPToolset

    toolsets: list = []
    missing: list[str] = []
    for provider, name, tools in native:
        provider_slots = nested.get(provider, {})
        entry = provider_slots.get(name)
        # Slot-name fallback: agents pin a connection by slot name, but users
        # routinely have the provider connected under a different name (e.g.
        # `tembo` vs `default`). When the named slot is absent but the user has
        # exactly ONE connection for this provider, use it — so the spec doesn't
        # have to match the slot name exactly. Ambiguous (2+ slots) still fails.
        if not entry and len(provider_slots) == 1:
            entry = next(iter(provider_slots.values()))
        if not entry or not entry.get("mcp_url") or not entry.get("access_token"):
            slot_label = (
                provider if name == "default" else f"{provider}/{name}"
            )
            missing.append(slot_label)
            continue
        headers = {"Authorization": f"Bearer {entry['access_token']}"}
        # Tag trigger_run calls to TAS's own MCP with this run's id, so the
        # runs it spawns are recorded as our children (parent-run cost rollup).
        # Only for the self provider — never leak the run id to third parties.
        run_id = os.environ.get("TAS_RUN_ID")
        if provider == "tembo-agent-studio" and run_id:
            headers["X-Tas-Parent-Run"] = run_id
        mcp = MCPToolset(entry["mcp_url"], headers=headers)
        if tools:
            # Capture the allowed set in a default-argument so the
            # closure doesn't late-bind to the loop variable. The
            # filter runs per tool-name lookup; AbstractToolset's
            # `.filtered(...)` returns a FilteredToolset wrapper that
            # gates which definitions reach the model.
            allowed = frozenset(tools)
            mcp = mcp.filtered(
                lambda ctx, td, _allowed=allowed: td.name in _allowed
            )
        toolsets.append(mcp)
    if missing:
        raise ValueError(
            "Agent declares native-MCP connections "
            f"{missing!r} but the run's acting user has no active "
            "connection for them. Open Connections and click Connect "
            "for the missing provider, then try again."
        )
    return toolsets


def _maybe_emit_stale_connection_marker(
    exc: Exception,
    connections: list[tuple[str, str, list[str], str]],
    resolved: dict[str, str],
) -> None:
    msg = str(exc)
    if "ToolRouterV2_InvalidConnectedAccountIds" not in msg:
        return
    # Composio names the failing connected_account_id in the error
    # message. Find it in the resolved map so we know which (toolkit,
    # name) slot to flag.
    stale_id: str | None = None
    import re as _re
    m = _re.search(r"(ca_[A-Za-z0-9_-]+)", msg)
    if m:
        stale_id = m.group(1)
    flagged: list[dict[str, str]] = []
    for toolkit, name, _tools, _source in connections:
        cid = resolved.get(toolkit)
        if cid and (stale_id is None or cid == stale_id):
            flagged.append({
                "toolkit": toolkit,
                "name": name,
                "connection_id": cid,
            })
    if not flagged:
        return
    print(
        f"{STALE_CONNECTION_MARKER}:{json.dumps(flagged)}",
        file=sys.stderr,
        flush=True,
    )


async def run(spec: dict, user_message: str, message_history=None) -> None:
    connections = parse_connections(spec)
    toolsets: list = []

    composio_mcp, used_direct_tools = build_composio_toolset(connections)
    if composio_mcp is not None:
        toolsets.append(composio_mcp)

    native_toolsets = build_native_mcp_toolsets(connections)
    toolsets.extend(native_toolsets)

    # Agent Skills the agent opts into (`skills:`). Mounted as a local toolset
    # (load_skill / run_skill_script); composes with the connection toolsets
    # above and works with any model.
    skills_toolset = build_skills_toolset()
    if skills_toolset is not None:
        toolsets.append(skills_toolset)

    # Preamble framing: if every connection's tools are attached
    # directly (composio in DIRECT_TOOLS mode, or any native-MCP
    # entry — native MCPs always expose tools by name), use the
    # direct-tools preamble. Otherwise fall back to the loose
    # preamble that teaches the model about Composio's meta-tools.
    # Native MCP doesn't add meta-tools, so it doesn't change the
    # decision — only Composio's loose mode does.
    direct_mode = (composio_mcp is None or used_direct_tools)
    # `secret` connections attach no toolset and are invisible to the model
    # (their value reaches sidecar tools via TAS_SECRETS), so they never
    # belong in the tool-use preamble's list of available services.
    preamble_labels = (
        sorted({slug for (slug, _n, _t, src) in connections if src != "secret"})
        if toolsets
        else None
    )

    # Sidecar tools module (the agent's `tools_module:`), if declared.
    # A parse/validation failure here propagates out of run() and marks
    # the run failed — the spec asked for these tools, so silently
    # dropping them would change the agent's behavior.
    tools_src = os.environ.get(TOOLS_MODULE_ENV)
    direct_tools_fns = load_tools_module(tools_src) if tools_src else None
    if direct_tools_fns:
        sys.stderr.write(
            f"[tas] loaded {len(direct_tools_fns)} sidecar tool function(s) "
            f"from tools_module: "
            f"{[getattr(f, '__name__', '?') for f in direct_tools_fns]}\n"
        )

    agent = build_agent(
        spec,
        toolsets=toolsets or None,
        connections=preamble_labels,
        direct_tools=direct_mode,
        tools=direct_tools_fns,
    )

    # MCP toolsets are async context managers — pydantic-ai keeps the
    # connection to Composio's MCP server alive for the duration of
    # the run, then tears it down on exit.
    #
    # capture_run_messages() collects the run's message history even when
    # agent.run() raises, so we can emit the tool-call list (TOOLS_SENTINEL)
    # on both the success and failure paths — the failure case is exactly
    # where "which tools did it actually call?" is most useful.
    # Live streaming: pass an event_stream_handler so the model's text + tool
    # calls flow to stdout as they happen. Guard on the kwarg actually being
    # supported (version skew) so an older pydantic-ai still runs — just
    # without streaming, falling back to the end-of-run capture.
    run_kwargs: dict = {}
    request_limit = spec.get("request_limit")
    run_kwargs["usage_limits"] = UsageLimits(
        request_limit=(
            request_limit
            if type(request_limit) is int and request_limit > 0
            else 50
        )
    )
    if message_history:
        run_kwargs["message_history"] = message_history
        run_kwargs["usage"] = _usage_from_history(message_history)
    try:
        if "event_stream_handler" in inspect.signature(agent.run).parameters:
            run_kwargs["event_stream_handler"] = make_stream_handler(message_history)
    except (ValueError, TypeError):
        pass

    with capture_run_messages() as _messages:
        try:
            if toolsets:
                async with agent:
                    # Diagnostic: list the tools pydantic-ai actually
                    # exposes to the model after the MCP context is entered.
                    # Lands in the api container logs.
                    try:
                        # We probe each toolset's raw `list_tools()` (the
                        # MCP server's full catalog), unwrapping wrappers
                        # like FilteredToolset — so this is the RAW catalog,
                        # NOT the post-`tools:`-narrowing set the model sees.
                        tool_names: list[str] = []
                        filtered_notes: list[str] = []
                        for ts in toolsets:
                            inner = ts
                            wrapper_chain: list[str] = []
                            while hasattr(inner, "wrapped"):
                                wrapper_chain.append(type(inner).__name__)
                                inner = inner.wrapped  # type: ignore[attr-defined]
                            if hasattr(inner, "list_tools"):
                                listed = await inner.list_tools()
                                names = [
                                    getattr(t, "name", None)
                                    or (t.get("name") if isinstance(t, dict) else None)
                                    for t in listed
                                ]
                                names = [n for n in names if n]
                                tool_names.extend(names)
                                if wrapper_chain:
                                    filtered_notes.append(
                                        f"{type(ts).__name__}({'/'.join(wrapper_chain)})"
                                        f" over {len(names)} server tools"
                                    )
                        sys.stderr.write(
                            f"[tas] MCP server catalogs total {len(tool_names)} "
                            f"tools (before the agent's `tools:` narrowing — the "
                            f"model only sees the declared subset): "
                            f"{tool_names[:10]}{'…' if len(tool_names) > 10 else ''}\n"
                        )
                        if filtered_notes:
                            sys.stderr.write(
                                f"[tas] narrowed toolsets (model sees only the "
                                f"declared `tools:` from each): {filtered_notes}\n"
                            )
                    except Exception as e:
                        sys.stderr.write(f"[tas] list_tools probe failed: {e}\n")
                    result = await agent.run(
                        None if message_history else user_message,
                        **run_kwargs,
                    )
            else:
                result = await agent.run(
                    None if message_history else user_message,
                    **run_kwargs,
                )
        finally:
            # The last node has no following handler to checkpoint it at entry.
            _emit_checkpoint(_messages)
            # Emit the tool-call list on BOTH success and failure (messages
            # were captured either way), so a failed/truncated run still
            # records the tools it did call.
            tool_calls = tool_calls_payload(_messages)
            if tool_calls:
                sys.stdout.write(f"{TOOLS_SENTINEL}{json.dumps(tool_calls)}\n")
            # Per-step usage (one row per model request) — emitted on both
            # paths so a failed run still shows the tokens it burned.
            steps = steps_payload(_messages)
            if steps:
                sys.stdout.write(f"{STEPS_SENTINEL}{json.dumps(steps)}\n")
            # ScaleDown compression totals (if any) — emitted on both paths so a
            # failed run still records what it compressed.
            sd = _scaledown_payload()
            if sd:
                sys.stdout.write(f"{SCALEDOWN_SENTINEL}{json.dumps(sd)}\n")

    sys.stdout.write(str(result.output))
    sys.stdout.write("\n")
    usage = usage_payload(getattr(result, "usage", None))
    if usage:
        sys.stdout.write(f"{USAGE_SENTINEL}{json.dumps(usage)}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a Pydantic AI AgentSpec.")
    parser.add_argument(
        "--fmt",
        choices=("yaml", "json"),
        required=True,
        help="Spec content format (the Rust caller knows this from the file extension).",
    )
    parser.add_argument(
        "--user-message",
        default="",
        help="Freeform user input to pass as the agent's prompt.",
    )
    args = parser.parse_args()

    try:
        envelope = json.loads(sys.stdin.readline())
        content = envelope["spec_content"]
        raw_history = envelope.get("message_history")
        message_history = (
            ModelMessagesTypeAdapter.validate_python(raw_history)
            if raw_history
            else None
        )
    except Exception as e:
        sys.stderr.write(f"failed to parse runner input envelope: {e}\n")
        return 2

    try:
        spec = parse_spec(content, args.fmt)
    except Exception as e:
        sys.stderr.write(f"failed to parse spec: {e}\n")
        return 2

    # Pydantic AI's run loop wants a non-empty prompt. When the user
    # didn't supply one (manual "Run now" with empty dialog, or a
    # scheduled automation that has no input message), send a
    # directive instead of "Hello." — models treat "Hello." as an
    # invitation to greet and chat. A neutral execution directive
    # nudges them to read their instructions and act.
    prompt = (
        args.user_message
        if args.user_message
        else "Execute the job described in your instructions."
    )

    try:
        asyncio.run(run(spec, prompt, message_history))
    except Exception as e:
        # Print the traceback to stderr so the run row's
        # error_message has actionable context, then exit non-zero
        # so the Rust runner marks the run as failed.
        traceback.print_exc(file=sys.stderr)
        sys.stderr.write(f"\npydantic-ai run failed: {e}\n")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
