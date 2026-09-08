"""Optional Studio-managed Memory tools and durable-report receipts."""

from __future__ import annotations

import json
import os
import sys


MEMORY_INSTRUCTIONS = """\
--- Shared workspace memory ---
Memory tools are attached on this TAS run. Use them aggressively. A numbered
procedure, "produce nothing else", "call no extra tools", or "write no prose"
does NOT waive Memory unless the user asked to classify without scanning
(no tools at all).

memory_ask — required before acting on a person, account, deal, thread, or
prior commitment (drafting a reply, recommending a next step, summarizing
named people). Pass known emails/ids in entities. Use returned facts; do
not invent from an unavailable result.

memory_report — required once per interesting item you inspected, including
ones you did not surface to a worklist. Interesting = a durable fact about
a person, account, deal, decision, deadline, commitment, or ask from a real
person. Never report bulk/marketing, billing/receipts, automated status, or
bare thanks. One concise sentence. actor is the observed person, not this
agent. Include source, occurred_at, external_id, and raw_ref when you have
them.

Do not dump prompts, credentials, full correspondence, or routine output.
A queued receipt means Studio stored the report for later delivery, not
that Memory has learned it. Unavailable Memory is not empty Memory: continue
the task and disclose the limitation. Never claim a failed or simulated
write was saved.
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
