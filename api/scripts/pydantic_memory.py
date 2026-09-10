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
named people). Pass kind:name ids in entities (person:jane@acme.com,
org:acme). Use returned facts; do not invent from an unavailable result.

memory_card — use before preparing a profile or briefing about a known person,
account, or project. Discover its exact entity_id with memory_entities. Cards
summarize overview, goals, owners, decisions, constraints, and open questions
with claim-level citations. Read the cited evidence before important actions;
use memory_ask for specific questions. Empty sections are not proof that facts
do not exist. Memory creates or refreshes cards on demand; generation can take
up to two minutes. If unavailable, use memory_ask or memory_search and disclose
the limitation. Do not repeatedly request the same card within a task unless
new evidence warrants it.

memory_report — required once per interesting item you inspected, including
ones you did not surface to a worklist. Interesting = a durable fact about
a person, account, deal, decision, deadline, commitment, or ask from a real
person. Never report bulk/marketing, billing/receipts, automated status, or
bare thanks. One concise sentence. actor is person:<email> or person:<name>
for the observed person, not this agent. entities must be kind:name ids or
{id, email} objects — never a bare display name, or Memory stores unknown:
instead of person:. Include source, occurred_at, external_id, and raw_ref
when you have them. Call memory_entities to reuse existing ids.

Do not dump prompts, credentials, full correspondence, or routine output.
A queued receipt means Studio stored the report for later delivery, not
that Memory has learned it. Unavailable Memory is not empty Memory: continue
the task and disclose the limitation. Never claim a failed or simulated
write was saved.
"""

MEMORY_TOOL_NAMES = frozenset({"memory_ask", "memory_search", "memory_entities", "memory_card", "memory_report"})


def memory_report_error(name: str, content) -> str | None:
    """Classify failed Memory writes without persisting report contents."""
    if name != "memory_report":
        return None
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except (TypeError, ValueError):
            return None
    if not isinstance(content, dict):
        return None
    status = content.get("status")
    if status not in ("not_queued", "not_confirmed", "invalid", "unavailable", "blocked"):
        return None
    reason = content.get("reason")
    if reason not in (
        "memory_report_invalid_arguments",
        "memory_report_invalid_invocation",
        "memory_report_payload_too_large",
        "memory_report_forbidden_identity",
        "memory_report_invalid_external_id",
        "memory_report_invalid_timestamp",
        "memory_report_encryption_failed",
        "memory_report_storage_failed",
    ):
        reason = status
    return f"Memory report failed ({reason}); check the run's Memory warning."


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
    from pydantic_connections import MCP_INIT_TIMEOUT_SECONDS

    connection = json.loads(os.environ["TAS_MEMORY_CONNECTION"])
    return MCPToolset(
        connection["url"],
        headers={"Authorization": f"Bearer {connection['token']}"},
        process_tool_call=process_memory_call,
        init_timeout=MCP_INIT_TIMEOUT_SECONDS,
        read_timeout=150,
        id="studio-memory",
    )
