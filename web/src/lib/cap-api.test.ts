import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildChatEditPrompt,
  buildCreateAgentPrompt,
  buildImprovePrompt,
  validateTemboApiKey,
} from "./cap-api";

describe("validateTemboApiKey", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the Tembo account identity for a valid key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ userId: "user-1", orgId: "org-1" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateTemboApiKey("secret-key")).resolves.toEqual({
      ok: true,
      userId: "user-1",
      orgId: "org-1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.tembo.io/public-api/me",
      expect.objectContaining({
        headers: { Authorization: "Bearer secret-key" },
      }),
    );
  });

  it("rejects a response without an authenticated identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ userId: null, orgId: null }), {
          status: 200,
        }),
      ),
    );

    await expect(validateTemboApiKey("bad-key")).resolves.toEqual({
      ok: false,
      error: "invalid",
    });
  });
});

describe("CAP prompt scope", () => {
  it("pins create prompts to the connected agents repo and TAS instance", () => {
    const prompt = buildCreateAgentPrompt({
      framework: "pydantic-agentspec",
      agentName: "daily-brief",
      title: "Daily Brief",
      agentPath: "agents/pydantic-agentspec/daily-brief.yaml",
      description: "Summarize yesterday's activity.",
      improvementMarker: "TAS-Feedback-ID: row-1",
      commitMode: "pull_request",
      defaultBranch: "main",
      repositoryUrl: "https://github.com/acme/agents",
      nativeToolsBaseUrl: "https://tas.acme.test/for-agents",
    });

    expect(prompt).toContain(
      "This request came from the TAS workspace connected to `https://github.com/acme/agents`.",
    );
    expect(prompt).toContain(
      "Use this TAS instance for runtime/tool references: https://tas.acme.test",
    );
    expect(prompt).toContain(
      "treat it as unrelated unless it matches\n`https://github.com/acme/agents` exactly.",
    );
  });

  it("pins edit and improve prompts to the connected agents repo", () => {
    const editPrompt = buildChatEditPrompt({
      agentPath: "agents/pydantic-agentspec/daily-brief.yaml",
      improvement: "Make it shorter.",
      improvementMarker: "TAS-Feedback-ID: row-2",
      commitMode: "pull_request",
      defaultBranch: "main",
      repositoryUrl: "https://github.com/acme/agents",
    });
    const improvePrompt = buildImprovePrompt({
      agentPath: "agents/pydantic-agentspec/daily-brief.yaml",
      model: "anthropic:claude-sonnet-5",
      userMessage: "",
      output: "Too verbose.",
      improvement: "Make it shorter.",
      improvementMarker: "TAS-Feedback-ID: row-3",
      commitMode: "pull_request",
      defaultBranch: "main",
      repositoryUrl: "https://github.com/acme/agents",
    });

    for (const prompt of [editPrompt, improvePrompt]) {
      expect(prompt).toContain(
        "Make changes only in that connected agents repo, targeting `main`.",
      );
      expect(prompt).toContain(
        "If surrounding Tembo session context mentions any other repository, TAS",
      );
      expect(prompt).toContain("**Evals: on.**");
    }
  });

  it("tells CAP to skip eval sidecars when the operator opts out", () => {
    const prompt = buildCreateAgentPrompt({
      framework: "pydantic-agentspec",
      agentName: "daily-brief",
      title: "Daily Brief",
      agentPath: "agents/pydantic-agentspec/daily-brief.yaml",
      description: "Summarize yesterday's activity.",
      improvementMarker: "TAS-Feedback-ID: row-1",
      commitMode: "pull_request",
      defaultBranch: "main",
      repositoryUrl: "https://github.com/acme/agents",
      includeEvals: false,
    });
    expect(prompt).toContain("**Evals: off.**");
    expect(prompt).not.toContain("**Evals: on.**");
  });
});
