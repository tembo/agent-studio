import { afterEach, describe, expect, it, vi } from "vitest";

import { readFile } from "@/lib/github";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readFile", () => {
  it("identifies GitHub rate limits as retryable source errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
      ),
    );

    const result = await readFile(
      "token",
      { owner: "tembo", name: "agents", branch: "main" },
      "agents/pydantic-agentspec/report.yaml",
    );

    expect(result).toEqual({ ok: false, error: "rate-limited" });
  });
});
