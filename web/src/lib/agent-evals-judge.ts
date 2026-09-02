import "server-only";

import { getWorkspaceSecretPlaintext } from "@/lib/workspace";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const JUDGE_MODEL = "claude-haiku-4-5";

const SYSTEM = [
  "You score one AI agent eval case.",
  "Read the rubric and the agent output.",
  "Reply with exactly one line: PASS: <short reason> or FAIL: <short reason>.",
  "No preamble, no markdown.",
].join(" ");

export async function scoreJudge(
  workspaceId: string,
  output: string,
  rubric: string,
): Promise<{ passed: boolean; reason: string }> {
  let apiKey: string | null = null;
  try {
    apiKey = await getWorkspaceSecretPlaintext(workspaceId, "anthropic_api_key");
  } catch {
    apiKey = null;
  }
  if (!apiKey) {
    return {
      passed: false,
      reason: "LLM judge needs an Anthropic API key in Settings → LLM Providers.",
    };
  }

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      cache: "no-store",
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 200,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              "Rubric:",
              rubric.slice(0, 4000),
              "",
              "Agent output:",
              output.slice(0, 8000),
            ].join("\n"),
          },
        ],
      }),
    });
    if (!res.ok) {
      return { passed: false, reason: `Judge model returned HTTP ${res.status}.` };
    }
    const data = (await res.json()) as {
      content?: { type?: string; text?: string }[];
    };
    const text =
      data.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim() ?? "";
    const line = text.split("\n").find((l) => l.trim()) ?? "";
    if (/^PASS\b/i.test(line)) {
      return {
        passed: true,
        reason: line.replace(/^PASS\s*:?\s*/i, "").trim() || "judge passed",
      };
    }
    if (/^FAIL\b/i.test(line)) {
      return {
        passed: false,
        reason: line.replace(/^FAIL\s*:?\s*/i, "").trim() || "judge failed",
      };
    }
    return { passed: false, reason: "Judge did not return PASS or FAIL." };
  } catch (err) {
    return {
      passed: false,
      reason: err instanceof Error ? err.message : "Judge request failed.",
    };
  }
}
