import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  buildChatEditPrompt,
  buildCreateAgentPrompt,
  buildImprovePrompt,
  createTemboTask,
  validateTemboApiKey,
} from "./cap-api";

describe("validateTemboApiKey", () => {
  beforeEach(() => {
    vi.stubEnv("TEMBO_API_URL", "https://api.tembo.io");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns the Tembo account identity for a valid key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ userId: "user-1", organizationId: "org-1" }), {
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
      "https://api.tembo.io/public-api/auth/context",
      expect.objectContaining({
        headers: { Authorization: "Bearer secret-key" },
        cache: "no-store",
      }),
    );
  });

  it.each([
    { userId: null, organizationId: null },
    { userId: "user-1", orgId: "old-org-field" },
    { principal: "agent", organizationId: "org-1" },
    null,
  ])("rejects responses without a user and organization: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(validateTemboApiKey("bad-key")).resolves.toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it.each([401, 403, 404, 500, 503])("handles HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    await expect(validateTemboApiKey("key")).resolves.toEqual({
      ok: false,
      error: status === 401 || status === 403 ? "invalid" : "network",
      detail: `Tembo returned ${status}`,
    });
  });

  it("handles network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection closed")));
    await expect(validateTemboApiKey("key")).resolves.toEqual({
      ok: false, error: "network", detail: "Connection closed",
    });
  });

  it("rejects malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON")));
    await expect(validateTemboApiKey("key")).resolves.toEqual({
      ok: false, error: "invalid",
    });
  });
});

describe("createTemboTask", () => {
  const input = {
    prompt: "Create the daily brief agent",
    repositoryUrl: "https://github.com/acme/agents",
    targetBranch: "main",
    branchName: "agent/daily-brief",
  };
  const repository = { id: "123e4567-e89b-42d3-a456-426614174000", url: input.repositoryUrl };
  const session = {
    id: "session-1",
    title: "Daily brief",
    state: { current: "inProgress" },
    htmlUrl: "https://app.tembo.io/sessions/session-1",
  };
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("resolves the exact repository across pages and sends the v1 session contract", async () => {
    vi.stubEnv("TEMBO_API_URL", "https://api.tembo.io");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        items: [{ id: "wrong-repo", url: "https://github.com/other/agents" }],
        nextCursor: "page-2",
      }))
      .mockResolvedValueOnce(response({
        items: [{ ...repository, url: `${repository.url}.git/` }], nextCursor: null,
      }))
      .mockResolvedValueOnce(response(session, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createTemboTask({ apiKey: "secret-key", input })).resolves.toEqual({
      ok: true,
      result: { taskId: session.id, title: session.title, status: "inProgress", htmlUrl: session.htmlUrl },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.tembo.io/public-api/v1/repositories?limit=100",
      "https://api.tembo.io/public-api/v1/repositories?limit=100&cursor=page-2",
      "https://api.tembo.io/public-api/v1/sessions",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers.Authorization).toBe("Bearer secret-key");
      expect(init.cache).toBe("no-store");
    }
    const post = fetchMock.mock.calls[2][1];
    expect(post.method).toBe("POST");
    expect(post.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(post.body)).toEqual({
      description: input.prompt,
      codeRepositoryIds: [repository.id],
      targetBranch: "main",
      branchName: "agent/daily-brief",
      queueRightAway: true,
    });
  });

  it.each(["direct", "pull_request"] as const)(
    "submits a %s chat edit to the strict session API (#579)",
    async (commitMode) => {
      // Supported fields used by Studio, from the public POST /v1/sessions
      // contract: https://docs.tembo.io/api/v1/sessions/create-a-session.
      // additionalProperties: false rejects legacy autoDetectRepositories.
      const sessionRequest = z.strictObject({
        description: z.string().min(1).max(1_000_000),
        codeRepositoryIds: z.array(z.uuid()).max(100).optional(),
        targetBranch: z.string().min(1).max(500).nullable().optional(),
        branchName: z.string().min(1).max(500).nullable().optional(),
        queueRightAway: z.boolean().optional(),
      });
      const prompt = buildChatEditPrompt({
        agentPath: "agents/pydantic-agentspec/daily-brief.yaml",
        improvement: "test",
        improvementMarker: "TAS-Improvement-ID: edit-579",
        commitMode,
        defaultBranch: input.targetBranch,
        repositoryUrl: input.repositoryUrl,
      });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(response({ items: [repository], nextCursor: null }))
        .mockImplementationOnce(async (_url: string, init: RequestInit) => {
          const parsed = sessionRequest.safeParse(JSON.parse(init.body as string));
          return parsed.success
            ? response(session, 201)
            : response({ error: "Invalid request" }, 400);
        });
      vi.stubGlobal("fetch", fetchMock);

      await expect(createTemboTask({
        apiKey: "key",
        input: { prompt, repositoryUrl: input.repositoryUrl, targetBranch: input.targetBranch },
      })).resolves.toMatchObject({ ok: true, result: { taskId: session.id } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        description: prompt,
        codeRepositoryIds: [repository.id],
        targetBranch: input.targetBranch,
        queueRightAway: true,
      });
    },
  );

  it("preserves a self-hosted API prefix and omits unspecified branch overrides", async () => {
    vi.stubEnv("TEMBO_API_URL", "https://tembo.example.com/api/public-api/");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ items: [repository], nextCursor: null }))
      .mockResolvedValueOnce(response({ ...session, state: {} }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createTemboTask({
      apiKey: "key", input: { prompt: input.prompt, repositoryUrl: input.repositoryUrl },
    });
    expect(result).toMatchObject({ ok: true, result: { status: "queued" } });
    expect(fetchMock.mock.calls[0][0]).toBe("https://tembo.example.com/api/public-api/v1/repositories?limit=100");
    expect(fetchMock.mock.calls[1][0]).toBe("https://tembo.example.com/api/public-api/v1/sessions");
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body).not.toHaveProperty("targetBranch");
    expect(body).not.toHaveProperty("branchName");
  });

  it("does not dispatch when the connected repository is unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      items: [{ id: "wrong-repo", url: `${repository.url}-other` }], nextCursor: null,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createTemboTask({ apiKey: "key", input })).resolves.toEqual({
      ok: false, error: { kind: "repository_not_found" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 500])("stops on repository lookup HTTP %s", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(response({ error: "lookup failed" }, status));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createTemboTask({ apiKey: "key", input })).resolves.toMatchObject({
      ok: false, error: { kind: "http", status, method: "GET" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns session errors without logging sensitive response content or retrying", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ items: [repository], nextCursor: null }))
      .mockResolvedValueOnce(response({ error: input.prompt }, 400));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createTemboTask({ apiKey: "secret-key", input })).resolves.toMatchObject({
      ok: false, error: { kind: "http", status: 400, method: "POST", body: JSON.stringify({ error: input.prompt }) },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain(input.prompt);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-key");
  });

  it.each(["lookup", "create"])("handles network failures during %s", async (stage) => {
    const fetchMock = vi.fn();
    if (stage === "create") fetchMock.mockResolvedValueOnce(response({ items: [repository], nextCursor: null }));
    fetchMock.mockRejectedValueOnce(new Error("Connection closed"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createTemboTask({ apiKey: "key", input })).resolves.toEqual({
      ok: false, error: { kind: "network", message: "Connection closed" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(stage === "create" ? 2 : 1);
  });
});

describe("Tembo API URL overrides", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    [undefined, "https://api.tembo.io/public-api"],
    ["https://api.tembo.io/", "https://api.tembo.io/public-api"],
    ["https://staging.example.com/", "https://staging.example.com/public-api"],
    ["https://tembo.example.com/api/", "https://tembo.example.com/api/public-api"],
    ["https://tembo.example.com/api/public-api/", "https://tembo.example.com/api/public-api"],
  ])("uses the same public mount for every route with %s", async (baseUrl, expected) => {
    vi.stubEnv("TEMBO_API_URL", baseUrl);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ userId: "user-1", organizationId: "org-1" }))
      .mockResolvedValueOnce(Response.json({
        items: [{ id: "repo-1", url: "https://github.com/acme/agents" }], nextCursor: null,
      }))
      .mockResolvedValueOnce(Response.json({
        id: "session-1", title: "Task", state: { current: "queued" },
        htmlUrl: "https://app.tembo.io/sessions/session-1",
      }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateTemboApiKey("key")).resolves.toEqual({
      ok: true, userId: "user-1", orgId: "org-1",
    });
    await expect(createTemboTask({
      apiKey: "key", input: { prompt: "Task", repositoryUrl: "https://github.com/acme/agents" },
    })).resolves.toMatchObject({ ok: true, result: { taskId: "session-1" } });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${expected}/auth/context`,
      `${expected}/v1/repositories?limit=100`,
      `${expected}/v1/sessions`,
    ]);
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
    expect(prompt).toContain("**Tembo Memory (TAS runtime).**");
    expect(prompt).toContain("memory_ask");
    expect(prompt).toContain("memory_report");
    expect(prompt).toContain("`tembo-memory` connection");
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
      expect(prompt).toContain("**Tembo Memory (TAS runtime).**");
      expect(prompt).toContain("memory_report");
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


describe("exact inline edits", () => {
  it("keeps delivery instructions without generating or forbidding eval edits", () => {
    const prompt = buildChatEditPrompt({
      agentPath: "agents/pydantic-agentspec/hello.yaml",
      improvement: "Write this exact file",
      improvementMarker: "TAS-Improvement-ID: inline",
      commitMode: "pull_request",
      defaultBranch: "main",
      repositoryUrl: "https://github.com/acme/agents",
      exactFileEdit: true,
    });
    expect(prompt).toContain("Write this exact file");
    expect(prompt).toContain("TAS-Improvement-ID: inline");
    expect(prompt).not.toContain("**Evals: on.**");
    expect(prompt).not.toContain("**Evals: off.**");
  });
});
