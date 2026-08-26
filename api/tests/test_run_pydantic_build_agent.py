from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest
from pydantic_ai import Agent, ModelMessagesTypeAdapter
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai.usage import RequestUsage

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts import run_pydantic


@pytest.fixture(autouse=True)
def provider_api_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-anthropic-key")
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")


@pytest.mark.parametrize(
    "spec",
    [
        {
            "name": "anthropic-basic",
            "model": "anthropic:claude-sonnet-4-5",
            "instructions": "Reply briefly.",
        },
        {
            "name": "openai-basic",
            "model": "openai:gpt-5-mini",
            "instructions": "Reply briefly.",
        },
        {
            "name": "anthropic-settings",
            "model": "anthropic:claude-sonnet-4-5",
            "instructions": "Reply briefly.",
            "model_settings": {
                "temperature": 0,
                "parallel_tool_calls": True,
            },
        },
    ],
)
def test_build_agent_constructs_provider_models(spec: dict) -> None:
    agent = run_pydantic.build_agent(spec)

    assert isinstance(agent, Agent)
    assert "get_run_datetime" in agent._function_toolset.tools


def test_anthropic_adapter_handles_temperature_with_current_sdk() -> None:
    """Exercise the provider request boundary without calling Anthropic.

    Anthropic 1.0 removed sampling kwargs from `messages.create`; older
    Pydantic AI adapters raised TypeError before making the request. The current
    adapter moves them into the request body instead.
    """
    import httpx2
    from anthropic import AsyncAnthropic
    from pydantic_ai.models import ModelRequestParameters
    from pydantic_ai.models.anthropic import AnthropicModel
    from pydantic_ai.providers.anthropic import AnthropicProvider

    async def exercise_request() -> None:
        request_body: dict = {}

        async def handler(request: httpx2.Request) -> httpx2.Response:
            request_body.update(json.loads(request.content))
            return httpx2.Response(
                200,
                json={
                    "id": "msg_test",
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "ok"}],
                    "model": "claude-sonnet-4-5",
                    "stop_reason": "end_turn",
                    "stop_sequence": None,
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                },
                headers={"x-request-id": "req_test"},
            )

        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(handler)
        ) as http_client:
            client = AsyncAnthropic(
                api_key="test-anthropic-key",
                http_client=http_client,
                max_retries=0,
            )
            model = AnthropicModel(
                "claude-sonnet-4-5",
                provider=AnthropicProvider(anthropic_client=client),
            )
            await model.request(
                [ModelRequest(parts=[UserPromptPart("hello")])],
                {"temperature": 0.2},
                ModelRequestParameters(),
            )

        assert request_body["temperature"] == 0.2

    asyncio.run(exercise_request())


def test_build_agent_constructs_with_tools_module() -> None:
    tools = run_pydantic.load_tools_module(
        """
def echo(message: str) -> str:
    \"\"\"Return the provided message.\"\"\"
    return message

tools = [echo]
"""
    )

    agent = run_pydantic.build_agent(
        {
            "name": "openai-tools",
            "model": "openai:gpt-5-mini",
            "instructions": "Use the echo tool when helpful.",
            "tools_module": "agent_tools.py",
        },
        tools=tools,
    )

    assert isinstance(agent, Agent)
    assert set(agent._function_toolset.tools) == {"get_run_datetime", "echo"}


def test_get_run_datetime_returns_stable_local_run_date(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TAS_RUN_STARTED_AT", "2026-07-28T07:15:30.123Z")

    pacific = run_pydantic.get_run_datetime("America/Los_Angeles")
    utc = run_pydantic.get_run_datetime()

    assert pacific == {
        "run_started_at": "2026-07-28T07:15:30.123000Z",
        "timezone": "America/Los_Angeles",
        "local_datetime": "2026-07-28T00:15:30.123000-07:00",
        "local_date": "2026-07-28",
        "local_time": "00:15:30.123000",
    }
    assert utc["run_started_at"] == pacific["run_started_at"]
    assert utc["local_date"] == "2026-07-28"


def test_get_run_datetime_rejects_unknown_timezone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TAS_RUN_STARTED_AT", "2026-07-28T07:15:30Z")

    with pytest.raises(ValueError, match="unknown IANA timezone"):
        run_pydantic.get_run_datetime("Pacific/Atlantis")


def test_build_capabilities_maps_websearch() -> None:
    from pydantic_ai.capabilities import WebSearch

    # Bare-name form and single-key-map form both map to the WebSearch capability.
    for caps in (["WebSearch"], [{"WebSearch": {}}], ["web_search"]):
        built = run_pydantic._build_capabilities({"capabilities": caps})
        assert len(built) == 1
        assert isinstance(built[0], WebSearch)


def test_build_capabilities_ignores_unknown_and_empty() -> None:
    # Unwired capabilities (handled elsewhere) and absent/empty lists yield none,
    # and never raise — a typo must not break agent construction.
    assert run_pydantic._build_capabilities({}) == []
    assert run_pydantic._build_capabilities({"capabilities": []}) == []
    assert run_pydantic._build_capabilities({"capabilities": ["Thinking"]}) == []
    assert run_pydantic._build_capabilities({"capabilities": "WebSearch"}) == []


def test_build_agent_attaches_websearch_capability() -> None:
    agent = run_pydantic.build_agent(
        {
            "name": "searcher",
            "model": "anthropic:claude-sonnet-4-5",
            "instructions": "Search the web when current info is needed.",
            "capabilities": ["WebSearch"],
        }
    )
    assert isinstance(agent, Agent)


def test_websearch_on_anthropic_skips_parallel_tool_calls_setting() -> None:
    # Anthropic's web_search tool uses server-side programmatic tool calling,
    # which the API rejects in combination with disable_parallel_tool_use
    # (400 as soon as the agent also has a client/MCP tool). The sequential
    # default must not apply — and an explicit spec value must be dropped —
    # for WebSearch agents on Anthropic, while non-WebSearch agents keep it.
    ws = run_pydantic.build_agent(
        {
            "name": "searcher",
            "model": "anthropic:claude-sonnet-5",
            "instructions": "Search.",
            "capabilities": ["WebSearch"],
        }
    )
    assert "parallel_tool_calls" not in ws.model_settings

    ws_explicit = run_pydantic.build_agent(
        {
            "name": "searcher-explicit",
            "model": "anthropic:claude-sonnet-5",
            "instructions": "Search.",
            "capabilities": ["WebSearch"],
            "model_settings": {"parallel_tool_calls": False},
        }
    )
    assert "parallel_tool_calls" not in ws_explicit.model_settings

    plain = run_pydantic.build_agent(
        {
            "name": "plain",
            "model": "anthropic:claude-sonnet-5",
            "instructions": "Reply.",
        }
    )
    assert plain.model_settings["parallel_tool_calls"] is False


def test_build_agent_with_scaledown_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    # scaledown attaches its compressor as a ProcessHistory capability
    # (pydantic-ai 2.x dropped Agent(history_processors=...)).
    monkeypatch.setenv("TAS_SCALEDOWN_API_KEY", "test-scaledown-key")
    agent = run_pydantic.build_agent(
        {
            "name": "compressed",
            "model": "anthropic:claude-sonnet-4-5",
            "instructions": "Reply briefly.",
            "scaledown": {"mode": "on"},
        }
    )
    assert isinstance(agent, Agent)


def test_build_agent_with_instrument_true() -> None:
    # `instrument: true` maps to the Instrumentation capability in 2.x.
    agent = run_pydantic.build_agent(
        {
            "name": "instrumented",
            "model": "anthropic:claude-sonnet-4-5",
            "instructions": "Reply briefly.",
            "instrument": True,
        }
    )
    assert isinstance(agent, Agent)


def test_uncached_input_excludes_cache_halves() -> None:
    from types import SimpleNamespace

    # The real run that overstated cost ~6x: input_tokens is the TOTAL incl. cache.
    u = SimpleNamespace(
        input_tokens=940477, cache_read_tokens=938547, cache_write_tokens=1929
    )
    assert run_pydantic._uncached_input(u) == 940477 - 938547 - 1929  # == 1

    # No caching reported → uncached == input.
    assert run_pydantic._uncached_input(
        SimpleNamespace(input_tokens=5000)
    ) == 5000

    # Clamp at 0; None input → None.
    assert run_pydantic._uncached_input(
        SimpleNamespace(input_tokens=100, cache_read_tokens=200)
    ) == 0
    assert run_pydantic._uncached_input(SimpleNamespace()) is None


def test_checkpoint_round_trips_typed_messages_and_seeds_usage(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("TAS_CHECKPOINT_ACK", raising=False)
    messages = [
        ModelRequest(parts=[UserPromptPart("do the work")]),
        ModelResponse(
            parts=[TextPart("done")],
            usage=RequestUsage(input_tokens=12, output_tokens=3),
            model_name="test",
        ),
    ]

    run_pydantic._emit_checkpoint(messages)

    line = capsys.readouterr().out.strip()
    payload = line.removeprefix(run_pydantic.CHECKPOINT_SENTINEL)
    restored = ModelMessagesTypeAdapter.validate_json(payload)
    assert restored == messages
    usage = run_pydantic._usage_from_history(restored)
    assert usage.requests == 1
    assert usage.input_tokens == 12
    assert usage.output_tokens == 3
