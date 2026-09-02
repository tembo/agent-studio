"""Dry-run delivery blocking for Pydantic agent runs."""

from __future__ import annotations

import inspect
import os
import sys
from typing import Any

INBOX_TOOL = "produce_inbox_item"
DRY_RUN_ENV = "TAS_DRY_RUN"

DRY_RUN_NOTICE = """\
--- Dry run ---
This is a TAS dry run. Declared delivery tools are stubbed and will not \
send, write, or create inbox items. Other tools may still make real \
changes. Do the job, then summarize what you would have delivered."""


def is_dry_run() -> bool:
    return os.environ.get(DRY_RUN_ENV) == "1"


def has_delivery_declaration(spec: dict) -> bool:
    delivery = spec.get("delivery")
    if not isinstance(delivery, dict):
        return False
    destinations = delivery.get("destinations")
    return isinstance(destinations, list) and len(destinations) > 0


def blocked_delivery_tools(spec: dict) -> frozenset[str]:
    blocked: set[str] = set()
    delivery = spec.get("delivery")
    if not isinstance(delivery, dict):
        return frozenset()
    destinations = delivery.get("destinations")
    if not isinstance(destinations, list):
        return frozenset()
    for destination in destinations:
        if not isinstance(destination, dict):
            continue
        evidence = destination.get("evidence")
        if not isinstance(evidence, dict):
            continue
        if evidence.get("type") == "inbox_item":
            blocked.add(INBOX_TOOL)
        elif evidence.get("type") == "tool_call":
            tool = evidence.get("tool")
            if isinstance(tool, str) and tool.strip():
                blocked.add(tool.strip())
    return frozenset(blocked)


def _has_tool_call_delivery(spec: dict) -> bool:
    delivery = spec.get("delivery")
    if not isinstance(delivery, dict):
        return False
    destinations = delivery.get("destinations")
    if not isinstance(destinations, list):
        return False
    for destination in destinations:
        if not isinstance(destination, dict):
            continue
        evidence = destination.get("evidence")
        if isinstance(evidence, dict) and evidence.get("type") == "tool_call":
            return True
    return False


def composio_loose_blocks_tool_call(
    spec: dict,
    connections: list[tuple[str, str, list[str], str]],
) -> bool:
    if not _has_tool_call_delivery(spec):
        return False
    return any(source == "composio" and not tools for (_tk, _n, tools, source) in connections)


def make_stub(name: str, original: Any | None = None):
    if original is not None:
        try:
            sig = inspect.signature(original)
        except (TypeError, ValueError):
            sig = inspect.Signature(
                [inspect.Parameter("kwargs", inspect.Parameter.VAR_KEYWORD)]
            )
        doc = inspect.getdoc(original) or ""
    else:
        sig = inspect.Signature(
            [inspect.Parameter("kwargs", inspect.Parameter.VAR_KEYWORD)]
        )
        doc = ""

    def stub(*_args, **_kwargs) -> str:
        return (
            f"Dry run: delivery tool `{name}` was not executed. "
            "No message was sent and no inbox item was created."
        )

    stub.__name__ = name
    stub.__doc__ = (
        (doc + "\n\n" if doc else "")
        + "Dry-run stub: TAS blocks this delivery tool and does not execute it."
    )
    stub.__signature__ = sig  # type: ignore[attr-defined]
    return stub


def apply_function_stubs(tools: list | None, blocked: frozenset[str]) -> list:
    existing = list(tools or [])
    names = {getattr(fn, "__name__", "") for fn in existing}
    wrapped = []
    for fn in existing:
        name = getattr(fn, "__name__", "")
        wrapped.append(make_stub(name, fn) if name in blocked else fn)
    for name in sorted(blocked):
        if name not in names:
            wrapped.append(make_stub(name))
    return wrapped


def filter_blocked_toolsets(toolsets: list, blocked: frozenset[str]) -> list:
    if not blocked:
        return toolsets
    out = []
    for toolset in toolsets:
        if hasattr(toolset, "filtered"):
            toolset = toolset.filtered(
                lambda _ctx, td, _blocked=blocked: getattr(td, "name", "") not in _blocked
            )
        out.append(toolset)
    return out


def prepare_dry_run(
    spec: dict,
    connections: list[tuple[str, str, list[str], str]],
    toolsets: list,
    tools: list | None,
) -> tuple[list, list | None, frozenset[str]]:
    if not has_delivery_declaration(spec):
        raise ValueError(
            "Dry run requires a delivery: declaration so TAS can tell "
            "which tools to block."
        )
    if composio_loose_blocks_tool_call(spec, connections):
        raise ValueError(
            "Dry run is not available because this agent uses the Composio "
            "tool router, so TAS cannot block only the declared delivery tools."
        )
    blocked = blocked_delivery_tools(spec)
    if not blocked:
        raise ValueError(
            "Dry run requires at least one identifiable delivery tool to block."
        )
    sys.stderr.write(
        f"[tas] dry run: blocking delivery tools {sorted(blocked)}\n"
    )
    return (
        filter_blocked_toolsets(toolsets, blocked),
        apply_function_stubs(tools, blocked),
        blocked,
    )
