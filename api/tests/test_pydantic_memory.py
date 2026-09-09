from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from pydantic_memory import MEMORY_INSTRUCTIONS, build_memory_toolset, process_memory_call
from pydantic_protocol import steps_payload, tool_calls_payload
from pydantic_ai.messages import ModelRequest, ModelResponse, ToolCallPart, ToolReturnPart


def test_runtime_blurb_requires_ask_and_report():
    assert "does NOT waive Memory" in MEMORY_INSTRUCTIONS
    assert "memory_ask — required" in MEMORY_INSTRUCTIONS
    assert "memory_report — required" in MEMORY_INSTRUCTIONS
    assert "including" in MEMORY_INSTRUCTIONS
    assert "Never report bulk" in MEMORY_INSTRUCTIONS
    assert "person:<email>" in MEMORY_INSTRUCTIONS
    assert "kind:name" in MEMORY_INSTRUCTIONS
    assert "unknown:" in MEMORY_INSTRUCTIONS


def test_disabled_has_no_toolset(monkeypatch):
    monkeypatch.delenv("TAS_MEMORY_CONNECTION", raising=False)
    assert build_memory_toolset() is None


def test_configured_attaches_without_agent_spec(monkeypatch):
    monkeypatch.setenv("TAS_MEMORY_CONNECTION", json.dumps({"url": "http://localhost:8080/memory/mcp", "token": "run-token"}))
    toolset = build_memory_toolset()
    assert toolset is not None
    assert toolset.id == "studio-memory"


@pytest.mark.asyncio
async def test_report_has_stable_identity_on_retry(monkeypatch):
    monkeypatch.delenv("TAS_DRY_RUN", raising=False)
    call = AsyncMock(return_value={"status": "queued"})
    context = SimpleNamespace(tool_call_id="call-123")
    arguments = {"text": "A decision"}
    for _ in range(2):
        await process_memory_call(context, call, "memory_report", arguments)
    assert call.call_args_list[0] == call.call_args_list[1]
    assert call.call_args.args[1]["_studio_invocation_id"] == "call-123"
    assert "_studio_invocation_id" not in arguments


@pytest.mark.asyncio
async def test_dry_run_never_queues(monkeypatch):
    monkeypatch.setenv("TAS_DRY_RUN", "1")
    call = AsyncMock()
    result = await process_memory_call(SimpleNamespace(tool_call_id="call-123"), call, "memory_report", {"text": "Not real"})
    assert result == {"status": "simulated", "queued": False}
    call.assert_not_called()


@pytest.mark.asyncio
async def test_outage_does_not_raise_or_claim_empty_memory():
    call = AsyncMock(side_effect=ConnectionError("secret URL must not be surfaced"))
    result = await process_memory_call(SimpleNamespace(tool_call_id="call-123"), call, "memory_ask", {"question": "What changed?"})
    assert result["status"] == "unavailable"
    assert "secret" not in json.dumps(result)


@pytest.mark.parametrize("encode", [lambda value: value, json.dumps])
@pytest.mark.parametrize("status", ["not_queued", "not_confirmed", "invalid", "unavailable", "blocked"])
def test_failed_memory_reports_are_failed_in_tool_and_step_history(encode, status):
    content = encode({
        "status": status,
        "reason": "memory_report_invalid_timestamp",
        "message": "sensitive report must not be stored",
    })
    messages = [
        ModelResponse(parts=[ToolCallPart("memory_report", {}, tool_call_id="call-123")]),
        ModelRequest(parts=[ToolReturnPart("memory_report", content, tool_call_id="call-123")]),
    ]
    calls = tool_calls_payload(messages)
    assert calls[0]["ok"] is False
    assert "memory_report_invalid_timestamp" in calls[0]["error"]
    assert "sensitive" not in json.dumps(calls)
    assert steps_payload(messages)[0]["tool_calls"] == calls


@pytest.mark.parametrize("status", ["queued", "delivered", "simulated"])
def test_successful_memory_reports_remain_ok(status):
    messages = [
        ModelResponse(parts=[ToolCallPart("memory_report", {}, tool_call_id="call-123")]),
        ModelRequest(parts=[ToolReturnPart("memory_report", {"status": status}, tool_call_id="call-123")]),
    ]
    assert tool_calls_payload(messages)[0]["ok"] is True
    assert steps_payload(messages)[0]["tool_calls"][0]["ok"] is True


def test_failure_classifier_does_not_expose_unknown_reasons_or_affect_other_tools():
    from pydantic_memory import memory_report_error

    result = {"status": "not_queued", "reason": "private database URL", "message": "private report"}
    assert "private" not in memory_report_error("memory_report", result)
    assert memory_report_error("another_tool", result) is None
    assert memory_report_error("memory_report", "not JSON") is None
