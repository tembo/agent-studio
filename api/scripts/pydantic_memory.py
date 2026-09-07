"""Optional Studio-managed Memory tools and durable-report receipts."""

from __future__ import annotations

import json
import os
import sys


MEMORY_INSTRUCTIONS = """\
--- Shared workspace memory ---
Use memory_ask or memory_search before work that may depend on prior decisions,
people, accounts, or repositories. File durable observations, decisions, and
constraints using memory_report, with source pointers and original event times.
Do not dump prompts, credentials, full correspondence, or routine output into memory.
The actor is the person observed, not the filing agent. A queued receipt means
Studio stored the report for asynchronous delivery, not that Memory has learned it.
Memory unavailability is not evidence that no relevant facts exist: continue the
task and disclose the limitation. Never claim a failed or simulated write was saved.
"""

MEMORY_TOOL_NAMES = frozenset({"memory_ask", "memory_search", "memory_entities", "memory_report"})


def memory_enabled() -> bool:
    return bool(os.environ.get("TAS_MEMORY_CONNECTION"))


async def process_memory_call(ctx, call_tool, name: str, arguments: dict):
    if name == "memory_report":
        if os.environ.get("TAS_DRY_RUN") == "1":
            return {"status": "simulated", "queued": False}
        if not ctx.tool_call_id:
            return {"status": "not_queued", "message": "Stable tool invocation identity is unavailable."}
        arguments = {**arguments, "_studio_invocation_id": ctx.tool_call_id}
    try:
        return await call_tool(name, arguments)
    except Exception:
        print("[memory] tool unavailable; continuing without a confirmed result", file=sys.stderr)
        return {
            "status": "not_confirmed" if name == "memory_report" else "unavailable",
            "message": "Memory operation could not be confirmed. Continue with a warning; do not claim a write succeeded or that no facts exist.",
        }


def build_memory_toolset():
    if not memory_enabled():
        return None
    from pydantic_ai.mcp import MCPToolset

    connection = json.loads(os.environ["TAS_MEMORY_CONNECTION"])
    return MCPToolset(
        connection["url"],
        headers={"Authorization": f"Bearer {connection['token']}"},
        process_tool_call=process_memory_call,
        read_timeout=40,
        id="studio-memory",
    )
