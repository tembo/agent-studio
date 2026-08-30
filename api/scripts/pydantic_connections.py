"""Connection parsing and toolset construction for Pydantic agent runs."""

from __future__ import annotations

import json
import os
import sys

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
