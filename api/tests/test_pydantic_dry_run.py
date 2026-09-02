from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from pydantic_dry_run import (
    apply_function_stubs,
    blocked_delivery_tools,
    composio_loose_blocks_tool_call,
    prepare_dry_run,
)


INBOX_DELIVERY = {
    "delivery": {
        "note": "Daily brief",
        "destinations": [
            {
                "key": "inbox",
                "label": "Inbox",
                "evidence": {"type": "inbox_item"},
            }
        ],
    }
}

EMAIL_DELIVERY = {
    "delivery": {
        "note": "Email",
        "destinations": [
            {
                "key": "email",
                "label": "Email",
                "evidence": {"type": "tool_call", "tool": "GMAIL_SEND_EMAIL"},
            }
        ],
    }
}


def test_blocked_tools_include_inbox_and_named_tools() -> None:
    spec = {
        "delivery": {
            "note": "Both",
            "destinations": [
                {
                    "key": "inbox",
                    "label": "Inbox",
                    "evidence": {"type": "inbox_item"},
                },
                {
                    "key": "email",
                    "label": "Email",
                    "evidence": {"type": "tool_call", "tool": "GMAIL_SEND_EMAIL"},
                },
            ],
        }
    }
    assert blocked_delivery_tools(spec) == frozenset(
        {"produce_inbox_item", "GMAIL_SEND_EMAIL"}
    )


def test_loose_composio_blocks_tool_call_delivery() -> None:
    connections = [("gmail", "default", [], "composio")]
    assert composio_loose_blocks_tool_call(EMAIL_DELIVERY, connections) is True
    assert composio_loose_blocks_tool_call(INBOX_DELIVERY, connections) is False


def test_narrowed_composio_allows_tool_call_delivery() -> None:
    connections = [("gmail", "default", ["GMAIL_SEND_EMAIL"], "composio")]
    assert composio_loose_blocks_tool_call(EMAIL_DELIVERY, connections) is False


def test_function_stubs_replace_matching_sidecar_tools() -> None:
    def GMAIL_SEND_EMAIL(to: str) -> str:
        return f"sent to {to}"

    wrapped = apply_function_stubs([GMAIL_SEND_EMAIL], frozenset({"GMAIL_SEND_EMAIL"}))
    assert wrapped[0]("ada@example.com") == (
        "Dry run: delivery tool `GMAIL_SEND_EMAIL` was not executed. "
        "No message was sent and no inbox item was created."
    )


def test_prepare_dry_run_refuses_missing_delivery() -> None:
    with pytest.raises(ValueError, match="delivery"):
        prepare_dry_run({}, [], [], None)


def test_prepare_dry_run_refuses_loose_composio_tool_call() -> None:
    with pytest.raises(ValueError, match="tool router"):
        prepare_dry_run(
            EMAIL_DELIVERY,
            [("gmail", "default", [], "composio")],
            [],
            None,
        )
