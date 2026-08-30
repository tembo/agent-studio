import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-source", () => ({
  resolveAgentReader: vi.fn(),
}));

vi.mock("@/lib/agent-versions", () => ({
  getStableVersion: vi.fn(),
  setAgentOwner: vi.fn(),
}));

import { resolveAgentReader, type AgentReader } from "@/lib/agent-source";
import { getStableVersion } from "@/lib/agent-versions";
import type { ListDirectoryResult } from "@/lib/github";
import { resolveAgentForDispatch } from "@/lib/workspace-agents";

const mockResolveAgentReader = vi.mocked(resolveAgentReader);
const mockGetStableVersion = vi.mocked(getStableVersion);

function readerWithListing(result: ListDirectoryResult): AgentReader {
  return {
    listDirectory: vi.fn().mockResolvedValue(result),
    readFile: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetStableVersion.mockResolvedValue(null);
});

describe("resolveAgentForDispatch source failures", () => {
  it("keeps a GitHub rate limit distinct from a missing agent", async () => {
    mockResolveAgentReader.mockResolvedValue(
      readerWithListing({ ok: false, error: "rate-limited" }),
    );

    const result = await resolveAgentForDispatch("ws-1", "daily-report");

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "source-unavailable",
        message:
          "Could not read the connected agent repository: GitHub rate-limited the request.",
        sourceError: "rate-limited",
        retryable: true,
      },
    });
  });

  it("preserves a retryable network failure and its detail", async () => {
    mockResolveAgentReader.mockResolvedValue(
      readerWithListing({
        ok: false,
        error: "network",
        detail: "GitHub returned 502",
      }),
    );

    const result = await resolveAgentForDispatch("ws-1", "daily-report");

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "source-unavailable",
        message:
          "Could not read the connected agent repository: GitHub returned 502.",
        sourceError: "network",
        retryable: true,
      },
    });
  });

  it("reports not-found only after a successful repository listing", async () => {
    mockResolveAgentReader.mockResolvedValue(
      readerWithListing({ ok: true, entries: [], missing: true }),
    );

    const result = await resolveAgentForDispatch("ws-1", "daily-report");

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "not-found",
        message: 'Agent "daily-report" is no longer in the connected repo.',
      },
    });
  });
});
