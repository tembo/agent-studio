from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from pydantic_memory import build_memory_toolset, process_memory_call


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
