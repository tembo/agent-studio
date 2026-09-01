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
from datetime import datetime, timezone
import inspect
import json
import os
import sys
import tempfile
import traceback
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic_ai import Agent, ModelMessagesTypeAdapter, capture_run_messages
from pydantic_ai.usage import UsageLimits

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from pydantic_protocol import (  # noqa: E402
    CHECKPOINT_SENTINEL,
    DELTA_SENTINEL,
    PROGRESS_SENTINEL,
    STEPS_SENTINEL,
    TOOLS_SENTINEL,
    USAGE_SENTINEL,
    _emit_checkpoint,
    _uncached_input,
    _usage_from_history,
    make_stream_handler,
    parse_spec,
    steps_payload,
    tool_calls_payload,
    usage_payload,
)
from pydantic_connections import (  # noqa: E402
    COMPOSIO_TOOL_USE_PREAMBLE_DIRECT,
    COMPOSIO_TOOL_USE_PREAMBLE_LOOSE,
    STALE_CONNECTION_MARKER,
    build_composio_toolset,
    build_native_mcp_toolsets,
    parse_connections,
)
from pydantic_scaledown import (  # noqa: E402
    SCALEDOWN_SENTINEL,
    _make_scaledown_processor,
    _scaledown_key,
    _scaledown_payload,
    _scaledown_settings,
)

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


async def _run_with_managed_toolsets(
    agent: Any,
    toolsets: list,
    prompt: str | None,
    run_kwargs: dict,
) -> Any:
    """Run an agent while keeping cleanup-only failures non-fatal.

    Once ``agent.run`` returns, the user-visible work is complete. Remote MCP
    servers can still reject their session-termination request during
    ``agent.__aexit__``; losing the completed result in that case makes a
    best-effort cleanup failure more expensive than the session it was closing.
    Errors during setup or execution still propagate normally.
    """
    result = None
    run_completed = False
    try:
        async with agent:
            # Diagnostic: list the tools pydantic-ai actually exposes to the
            # model after the MCP context is entered. Lands in the api logs.
            try:
                # Probe each toolset's raw `list_tools()` (the MCP server's
                # full catalog), unwrapping wrappers like FilteredToolset. This
                # is the raw catalog, not the post-`tools:`-narrowing set.
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

            result = await agent.run(prompt, **run_kwargs)
            run_completed = True
    except Exception as e:
        if not run_completed:
            raise
        sys.stderr.write(
            "[tas] MCP session cleanup failed after the agent completed; "
            f"preserving the result: {type(e).__name__}: {e}\n"
        )

    assert result is not None
    return result


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
                result = await _run_with_managed_toolsets(
                    agent,
                    toolsets,
                    None if message_history else user_message,
                    run_kwargs,
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
