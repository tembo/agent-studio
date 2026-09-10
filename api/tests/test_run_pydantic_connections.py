from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from pydantic_connections import (
    MCP_INIT_TIMEOUT_SECONDS,
    MCP_READ_TIMEOUT_SECONDS,
    build_native_mcp_toolsets,
    is_transient_mcp_error,
    retry_transient_await,
    retry_transient_mcp_call,
)


class _Closed(Exception):
    def __init__(self, message: str = "MCP error -32000: Connection closed"):
        super().__init__(message)
        self.code = -32000


def test_connection_closed_is_transient():
    assert is_transient_mcp_error(_Closed())
    assert is_transient_mcp_error(TimeoutError("timed out"))
    assert not is_transient_mcp_error(ValueError("no active connection for stripe"))
    assert not is_transient_mcp_error(RuntimeError("401 Unauthorized"))


def test_retry_await_recovers_after_transient_failure(monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr("pydantic_connections.asyncio.sleep", AsyncMock(side_effect=sleeps.append))
    calls = {"n": 0}

    async def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise _Closed()
        return "ok"

    assert asyncio.run(retry_transient_await(flaky, what="MCP initialize")) == "ok"
    assert calls["n"] == 3
    assert sleeps == [0.5, 1.0]


def test_retry_await_does_not_retry_auth_errors():
    async def boom():
        raise RuntimeError("401 Unauthorized")

    with pytest.raises(RuntimeError, match="401"):
        asyncio.run(retry_transient_await(boom, what="MCP initialize"))


def test_retry_tool_call_retries_connection_closed(monkeypatch):
    monkeypatch.setattr("pydantic_connections.asyncio.sleep", AsyncMock())
    call = AsyncMock(side_effect=[_Closed(), {"rows": 1}])
    result = asyncio.run(
        retry_transient_mcp_call(None, call, "stripe_analytics", {"sql": "select 1"})
    )
    assert result == {"rows": 1}
    assert call.await_count == 2


def test_native_mcp_uses_handshake_timeouts(monkeypatch):
    monkeypatch.setenv(
        "TAS_NATIVE_MCP_CONNECTIONS",
        json.dumps({
            "stripe": {
                "default": {
                    "mcp_url": "https://mcp.stripe.com",
                    "access_token": "tok",
                }
            }
        }),
    )
    captured: dict = {}

    class FakeToolset:
        def __init__(self, url, **kwargs):
            captured["url"] = url
            captured.update(kwargs)

        def filtered(self, _fn):
            return self

    with patch("pydantic_connections._make_mcp_toolset", side_effect=lambda *a, **k: FakeToolset(*a, **k)):
        toolsets = build_native_mcp_toolsets([
            ("stripe", "default", ["stripe_analytics"], "native-mcp"),
        ])

    assert len(toolsets) == 1
    assert captured["url"] == "https://mcp.stripe.com"
    assert captured["headers"]["Authorization"] == "Bearer tok"


def test_make_mcp_toolset_sets_timeouts_and_retry_hook():
    from pydantic_connections import _make_mcp_toolset, retry_transient_mcp_call as hook

    captured: dict = {}

    class FakeBase:
        def __init__(self, url, **kwargs):
            captured["url"] = url
            captured.update(kwargs)

        async def __aenter__(self):
            return self

    with patch("pydantic_ai.mcp.MCPToolset", FakeBase):
        toolset = _make_mcp_toolset("https://mcp.stripe.com", headers={"Authorization": "Bearer x"})

    assert captured["url"] == "https://mcp.stripe.com"
    assert captured["init_timeout"] == MCP_INIT_TIMEOUT_SECONDS
    assert captured["read_timeout"] == MCP_READ_TIMEOUT_SECONDS
    assert captured["process_tool_call"] is hook
    assert type(toolset).__name__ == "RetryingMCPToolset"


def test_retrying_toolset_retries_initialize(monkeypatch):
    from pydantic_connections import _make_mcp_toolset

    monkeypatch.setattr("pydantic_connections.asyncio.sleep", AsyncMock())
    enters = {"n": 0}

    class FakeBase:
        def __init__(self, url, **kwargs):
            pass

        async def __aenter__(self):
            enters["n"] += 1
            if enters["n"] < 2:
                raise _Closed()
            return self

    with patch("pydantic_ai.mcp.MCPToolset", FakeBase):
        toolset = _make_mcp_toolset("https://mcp.stripe.com", headers={})
        result = asyncio.run(toolset.__aenter__())

    assert enters["n"] == 2
    assert result is toolset
