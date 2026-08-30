"""Optional ScaleDown prompt compression for Pydantic agent runs."""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import json
import os
import sys

import httpx

# ── ScaleDown prompt compression ─────────────────────────────────────────────
# Optional: when the workspace set a ScaleDown key (TAS_SCALEDOWN_API_KEY) AND
# the agent opts in via `scaledown:` in its spec, route bulky prompt/context
# through ScaleDown (https://scaledown.ai) before frontier-model calls to cut
# tokens. Best-effort end to end — any error/timeout falls back to the original
# text so a run never breaks.
#
# Modes (spec `scaledown:` — string shorthand, bool, or object):
#   off (default) — no compression.
#   prompt        — compress the static instructions ONCE at startup. Safe and
#                   cache-friendly: identical compressed instructions every turn,
#                   so Anthropic prompt caching still hits.
#   aggressive    — also compress large history blocks (tool outputs, user
#                   context) via a history processor, COMPRESS-ONCE-AND-FREEZE:
#                   each block is compressed the first time it's seen and the
#                   result memoized for the rest of the run, so bytes stay stable
#                   across turns and the prefix re-stabilizes for prompt caching
#                   instead of thrashing it. The most recent message is left
#                   verbatim (it's the live prompt and the churning cache tail).
SCALEDOWN_API_URL = os.environ.get("SCALEDOWN_API_URL", "https://api.scaledown.xyz")
# Only compress text bigger than this (~4 chars/token) — below it a network
# round-trip isn't worth the savings.
SCALEDOWN_DEFAULT_MIN_CHARS = 1600
# Only compress completed tool-return content — the bulky, already-consumed
# outputs that are re-sent every turn. We deliberately leave user/system prompts
# (the task + instructions) and the model's own TextParts intact, and never
# touch tool-call args or tool_use/tool_result pairing.
SCALEDOWN_COMPRESSIBLE_PARTS = {"tool-return"}
# Emitted once at end of run so the run row can show what compression saved.
SCALEDOWN_SENTINEL = "__TAS_SCALEDOWN__:"
# Run-level totals across every compression (each unique block counts once — the
# processor memoizes — plus the one-time instructions compression).
_SCALEDOWN_TOTALS = {"original_tokens": 0, "compressed_tokens": 0, "blocks": 0}


def _scaledown_payload() -> dict | None:
    """The run's compression totals for the end-of-run sentinel, or None if
    nothing was compressed."""
    return dict(_SCALEDOWN_TOTALS) if _SCALEDOWN_TOTALS["blocks"] > 0 else None


def _scaledown_key() -> str | None:
    k = os.environ.get("TAS_SCALEDOWN_API_KEY")
    return k if isinstance(k, str) and k.strip() else None


def _scaledown_settings(spec: dict) -> tuple[bool, str, int]:
    """(enabled, rate, min_chars) from the agent's `scaledown:` field.

    The only real knobs are on/off, the compression `rate` (ScaleDown's lever),
    and `min_tokens` (how big the history must be before we bother). Accepted:
      scaledown: off|false        → disabled (default)
      scaledown: auto|true|on     → enabled, rate=auto
      scaledown: 0.5              → enabled, rate=0.5 (target ~50% of tokens)
      scaledown: { rate: auto|0.5, min_tokens: 400 }
    Lenient: any other non-off string (e.g. legacy "prompt"/"aggressive") enables
    at rate=auto, so existing specs keep working."""
    raw = spec.get("scaledown")
    rate, min_chars = "auto", SCALEDOWN_DEFAULT_MIN_CHARS
    if raw is None or raw is False:
        return False, rate, min_chars
    if raw is True:
        return True, rate, min_chars
    if isinstance(raw, (int, float)):  # numeric rate, e.g. 0.5
        return True, str(raw), min_chars
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in ("off", "false", "no", "none", "disabled", ""):
            return False, rate, min_chars
        try:
            float(s)  # numeric string rate
            rate = s
        except ValueError:
            pass  # "auto"/"on"/legacy "prompt"/"aggressive" → enabled at auto
        return True, rate, min_chars
    if isinstance(raw, dict):
        if str(raw.get("mode", "")).strip().lower() in ("off", "false", "disabled"):
            return False, rate, min_chars
        if raw.get("enabled") is False:
            return False, rate, min_chars
        r = raw.get("rate")
        if isinstance(r, (str, int, float)) and not isinstance(r, bool):
            rate = str(r)
        if isinstance(raw.get("min_tokens"), int):
            min_chars = raw["min_tokens"] * 4
        elif isinstance(raw.get("min_chars"), int):
            min_chars = raw["min_chars"]
        return True, rate, max(1, min_chars)
    return False, rate, min_chars


def _scaledown_compress(context: str, prompt: str, rate: str) -> str:
    """Optimize one model-request prompt via ScaleDown's /compress/raw/.

    Per the API ref: `context` is the OLD/background text (conversation history)
    ScaleDown compresses; `prompt` is the NEW step's input, kept intact to
    preserve intent. Both required, non-empty. Returns `compressed_prompt` (the
    optimized prompt). Best-effort: returns `context` unchanged on any
    error/missing key/empty prompt so a run never breaks. Synchronous — call via
    asyncio.to_thread from async contexts."""
    key = _scaledown_key()
    if not key or not isinstance(context, str) or not context.strip():
        return context
    if not (isinstance(prompt, str) and prompt.strip()):
        return context  # ScaleDown requires a non-empty prompt; skip this step
    url = f"{SCALEDOWN_API_URL}/compress/raw/"
    try:
        print(
            f"[scaledown] POST {url} (context={len(context)}c prompt={len(prompt)}c)",
            file=sys.stderr,
        )
        resp = httpx.post(
            url,
            headers={"x-api-key": key, "Content-Type": "application/json"},
            json={
                "context": context,
                "prompt": prompt,
                "scaledown": {"rate": rate},
            },
            timeout=30,
        )
        print(f"[scaledown] -> HTTP {resp.status_code}", file=sys.stderr)
        resp.raise_for_status()
        data = resp.json() or {}
        # The API has shipped both flat and nested ({results:{...}}) shapes.
        results = data.get("results") if isinstance(data.get("results"), dict) else data
        compressed = results.get("compressed_prompt")
        if not (isinstance(compressed, str) and compressed.strip()):
            print(
                "[scaledown] no compressed_prompt in response; keys="
                + repr(list(data.keys())[:10])
                + " body=" + json.dumps(data)[:400],
                file=sys.stderr,
            )
        if isinstance(compressed, str) and compressed.strip():
            orig = data.get("original_prompt_tokens") or results.get("original_prompt_tokens")
            comp = data.get("compressed_prompt_tokens") or results.get("compressed_prompt_tokens")
            print(
                f"[scaledown] ok orig={orig} comp={comp} "
                f"context={len(context)}c out={len(compressed)}c head={compressed[:200]!r}",
                file=sys.stderr,
            )
            if isinstance(orig, int) and isinstance(comp, int) and orig > 0:
                _SCALEDOWN_TOTALS["original_tokens"] += orig
                _SCALEDOWN_TOTALS["compressed_tokens"] += comp
                _SCALEDOWN_TOTALS["blocks"] += 1
            return compressed
    except Exception as e:  # noqa: BLE001 — best-effort, never break a run
        print(f"[scaledown] compress failed, using original: {e}", file=sys.stderr)
    return context


def _msg_text(msg) -> str:
    """Concatenate one message's content for the old-context vs new-turn split.
    Includes string parts (system/user/tool-return text + model text) AND
    stringified structured tool-return content (e.g. a tool that returns a
    list/dict) — that structured output is usually the bulkiest thing in an
    agentic history, so it's exactly what's worth compressing."""
    chunks: list[str] = []
    for part in getattr(msg, "parts", None) or []:
        content = getattr(part, "content", None)
        if isinstance(content, str):
            if content.strip():
                chunks.append(content)
        elif content is not None:
            try:
                chunks.append(json.dumps(content, default=str))
            except Exception:
                chunks.append(str(content))
    return "\n\n".join(chunks)


def _first_user_text(messages: list) -> str:
    """The agent's task — the first user-prompt text in the history. Used as the
    ScaleDown `prompt` (the intent to preserve when compressing old context).
    Stable across the run, so compression is deterministic + cache-friendly."""
    for msg in messages:
        for part in getattr(msg, "parts", None) or []:
            if getattr(part, "part_kind", "") == "user-prompt":
                content = getattr(part, "content", None)
                if isinstance(content, str) and content.strip():
                    return content
    return "Complete the user's task using the prior context."


def _make_scaledown_processor(rate: str, min_chars: int):
    """A pydantic-ai history processor that compresses bulky OLD tool outputs in
    place. Per ScaleDown's model: each big completed tool-result is the `context`
    to compress; the agent's task is the `prompt` (intent to preserve).

    STRUCTURALLY SAFE: it only rewrites the *content* of `tool-return` parts in
    earlier turns (never removes/reorders messages, never touches tool-call args
    or the newest turn) — so tool_use/tool_result pairing stays intact. Compress-
    once-and-freeze (memoized per original content) keeps bytes stable so
    Anthropic prompt caching still hits. Best-effort end to end."""
    memo: dict[str, str] = {}

    async def _shrink(text: str, prompt: str) -> str:
        if not isinstance(text, str) or len(text) < min_chars:
            return text
        try:
            h = hashlib.sha256(text.encode("utf-8")).hexdigest()
            if h not in memo:
                memo[h] = await asyncio.to_thread(
                    _scaledown_compress, text, prompt, rate
                )
            return memo[h]
        except Exception:  # noqa: BLE001 — optimization, never break a run
            return text

    async def process(messages: list) -> list:
        # Hard guarantee: ScaleDown is an optimization, never a dependency. Any
        # failure falls back to the original history so the run never breaks.
        try:
            if not _scaledown_key() or len(messages) < 2:
                return messages
            prompt = _first_user_text(messages)
            out = list(messages)
            # Leave the newest turn intact; compress big tool-returns in earlier
            # turns. Only `content` is swapped — message/part structure is kept.
            for i in range(len(out) - 1):
                msg = out[i]
                parts = getattr(msg, "parts", None)
                if not parts:
                    continue
                new_parts = list(parts)
                changed = False
                for j, part in enumerate(new_parts):
                    if getattr(part, "part_kind", "") not in SCALEDOWN_COMPRESSIBLE_PARTS:
                        continue
                    content = getattr(part, "content", None)
                    if isinstance(content, str):
                        text = content
                    elif content is not None:
                        try:
                            text = json.dumps(content, default=str)
                        except Exception:
                            continue
                    else:
                        continue
                    shrunk = await _shrink(text, prompt)
                    if shrunk != text:
                        try:
                            new_parts[j] = dataclasses.replace(part, content=shrunk)
                            changed = True
                        except Exception:
                            pass  # not a dataclass — leave untouched
                if changed:
                    try:
                        out[i] = dataclasses.replace(msg, parts=new_parts)
                    except Exception:
                        out[i] = msg
            return out
        except Exception as e:  # noqa: BLE001 — never let compression fail a run
            print(
                f"[scaledown] history processor error, using original history: {e}",
                file=sys.stderr,
            )
            return messages

    return process
