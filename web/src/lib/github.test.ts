import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFile,
  listDirectory,
  readFile,
  resetGithubHeadCacheForTests,
} from "@/lib/github";

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetGithubHeadCacheForTests();
});

const REF = { owner: "tembo", name: "agents", branch: "main" } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockGithub(opts: {
  headSha: string | ((url: string) => string);
  contents?: Record<string, unknown>;
  contentsStatus?: Record<string, number>;
  onPut?: (url: string) => Response;
}): { fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "PUT") {
      return opts.onPut?.(url) ?? jsonResponse({ commit: { sha: "newhead" } });
    }
    if (url.includes("/commits/")) {
      const sha =
        typeof opts.headSha === "function" ? opts.headSha(url) : opts.headSha;
      return jsonResponse({ sha });
    }
    const refMatch = /[?&]ref=([^&]+)/.exec(url);
    const sha = refMatch ? decodeURIComponent(refMatch[1]) : "";
    const pathMatch = /\/contents\/([^?]+)/.exec(url);
    const path = pathMatch ? decodeURIComponent(pathMatch[1]) : "";
    const key = `${sha}:${path}`;
    const status = opts.contentsStatus?.[key];
    if (status) return new Response(null, { status });
    const body = opts.contents?.[key];
    if (body === undefined) return new Response(null, { status: 404 });
    return jsonResponse(body);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch };
}

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
      REF,
      "agents/pydantic-agentspec/report.yaml",
    );

    expect(result).toEqual({ ok: false, error: "rate-limited" });
  });

  it("reads Contents at the current HEAD sha, not the branch name", async () => {
    const encoded = Buffer.from("name: report\n", "utf8").toString("base64");
    const { fetch } = mockGithub({
      headSha: "abc123",
      contents: {
        "abc123:agents/pydantic-agentspec/report.yaml": {
          content: encoded,
          encoding: "base64",
          sha: "blob1",
        },
      },
    });

    const result = await readFile(
      "token",
      REF,
      "agents/pydantic-agentspec/report.yaml",
    );

    expect(result).toEqual({
      ok: true,
      content: "name: report\n",
      sha: "blob1",
    });
    const urls = fetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain(
      "https://api.github.com/repos/tembo/agents/commits/main",
    );
    expect(urls.some((url) => url.includes("ref=abc123"))).toBe(true);
    expect(urls.some((url) => url.includes("ref=main"))).toBe(false);
  });

  it("sees a file that 404'd at the previous HEAD once HEAD advances", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let head = "sha-old";
    mockGithub({
      headSha: () => head,
      contentsStatus: {
        "sha-old:agents/pydantic-agentspec/new-agent.yaml": 404,
      },
      contents: {
        "sha-new:agents/pydantic-agentspec/new-agent.yaml": {
          content: Buffer.from("name: new-agent\n", "utf8").toString("base64"),
          encoding: "base64",
          sha: "blob-new",
        },
      },
    });

    const missing = await readFile(
      "token",
      REF,
      "agents/pydantic-agentspec/new-agent.yaml",
    );
    expect(missing).toEqual({ ok: false, error: "not-found" });

    head = "sha-new";
    now += 6_000;
    const found = await readFile(
      "token",
      REF,
      "agents/pydantic-agentspec/new-agent.yaml",
    );
    expect(found).toMatchObject({ ok: true, content: "name: new-agent\n" });
  });
});

describe("listDirectory", () => {
  it("coalesces parallel HEAD lookups on the same repo", async () => {
    const { fetch } = mockGithub({
      headSha: "abc123",
      contents: {
        "abc123:agents/pydantic-agentspec": [
          {
            type: "file",
            name: "report.yaml",
            path: "agents/pydantic-agentspec/report.yaml",
            size: 12,
            sha: "blob1",
            download_url: null,
          },
        ],
      },
    });

    await Promise.all([
      listDirectory("token", REF, "agents/pydantic-agentspec"),
      listDirectory("token", REF, "agents/cargo-ai"),
    ]);

    const headCalls = fetch.mock.calls.filter((call) =>
      String(call[0]).includes("/commits/main"),
    );
    expect(headCalls).toHaveLength(1);
  });
});

describe("createFile", () => {
  it("pins later reads at the write's commit sha", async () => {
    const encoded = Buffer.from("name: created\n", "utf8").toString("base64");
    const { fetch } = mockGithub({
      headSha: "should-not-refetch",
      contents: {
        "commit-after-create:agents/pydantic-agentspec/created.yaml": {
          content: encoded,
          encoding: "base64",
          sha: "blob-created",
        },
      },
      onPut: () => jsonResponse({ commit: { sha: "commit-after-create" } }),
    });

    const created = await createFile(
      "token",
      REF,
      "agents/pydantic-agentspec/created.yaml",
      { content: "name: created\n", message: "add created" },
    );
    expect(created).toEqual({ ok: true, commitSha: "commit-after-create" });

    const read = await readFile(
      "token",
      REF,
      "agents/pydantic-agentspec/created.yaml",
    );
    expect(read).toMatchObject({ ok: true, content: "name: created\n" });
    const headCalls = fetch.mock.calls.filter((call) =>
      String(call[0]).includes("/commits/main"),
    );
    expect(headCalls).toHaveLength(0);
  });
});
