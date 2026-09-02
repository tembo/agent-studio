import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Improvement } from "@/lib/improvements-api";

const scheduleAfterResponse = vi.fn();
vi.mock("next/server", () => ({
  after: (callback: () => Promise<void>) => scheduleAfterResponse(callback),
}));

const setImprovementPr = vi.fn();
const setImprovementCommit = vi.fn();
vi.mock("@/lib/improvements-api", () => ({
  setImprovementPr: (...a: unknown[]) => setImprovementPr(...a),
  setImprovementCommit: (...a: unknown[]) => setImprovementCommit(...a),
  IMPROVEMENT_MARKER_PREFIX: "tembo-improvement:",
  improvementMarker: (id: string) => `tembo-improvement:${id}`,
}));

const getWorkspaceRepo = vi.fn();
const getWorkspaceSecretPlaintext = vi.fn();
vi.mock("@/lib/workspace", () => ({
  getWorkspaceRepo: (...a: unknown[]) => getWorkspaceRepo(...a),
  getWorkspaceSecretPlaintext: (...a: unknown[]) =>
    getWorkspaceSecretPlaintext(...a),
}));

vi.mock("@/lib/agent-evals-pr", () => ({
  schedulePrEvals: vi.fn().mockResolvedValue(undefined),
}));

import {
  scanImprovementsForPRs,
  scheduleImprovementScan,
} from "./improvement-scan";

function improvement(over: Partial<Improvement> & { id: string }): Improvement {
  return {
    status: "pr_opened",
    delivery: "pr",
    prNumber: null,
    prUrl: null,
    prState: null,
    commitUrl: null,
    commitSha: null,
    ...over,
  } as unknown as Improvement;
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// The scan holds a module-level per-workspace throttle stamp, so each test
// uses its own workspace id unless it is specifically exercising the throttle.
let wsCounter = 0;
const nextWorkspace = () => `ws-${++wsCounter}`;

beforeEach(() => {
  scheduleAfterResponse.mockReset();
  setImprovementPr.mockReset().mockResolvedValue(undefined);
  setImprovementCommit.mockReset().mockResolvedValue(undefined);
  getWorkspaceRepo.mockReset().mockResolvedValue({ owner: "o", name: "r" });
  getWorkspaceSecretPlaintext.mockReset().mockResolvedValue("token");
});

describe("scanImprovementsForPRs", () => {
  it("makes no network calls when every improvement is terminal", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await scanImprovementsForPRs(nextWorkspace(), [
      improvement({ id: "a", status: "merged" }),
      improvement({ id: "b", status: "closed" }),
    ]);

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("caps concurrent PR fetches so a large backlog can't trip GitHub's secondary rate limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (url: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const number = Number(url.split("/pulls/")[1]);
      return jsonResponse({
        number,
        html_url: `https://github.com/o/r/pull/${number}`,
        state: "open",
        merged_at: null,
        merged: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const improvements = Array.from({ length: 25 }, (_, i) =>
      improvement({ id: `i${i}`, prNumber: i + 1 }),
    );
    await scanImprovementsForPRs(nextWorkspace(), improvements);

    // Every PR still gets checked — the cap bounds the burst, not the work.
    expect(fetchMock).toHaveBeenCalledTimes(25);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
    vi.unstubAllGlobals();
  });

  it("issues the PR fetch and both searches concurrently rather than in series", async () => {
    const seen: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(url);
      await gate;
      if (url.includes("/search/issues")) return jsonResponse({ items: [] });
      if (url.includes("/search/commits")) return jsonResponse({ items: [] });
      return jsonResponse({
        number: 1,
        html_url: "https://github.com/o/r/pull/1",
        state: "open",
        merged_at: null,
        merged: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scan = scanImprovementsForPRs(nextWorkspace(), [
      improvement({ id: "has-pr", prNumber: 1 }),
      improvement({ id: "no-pr", prNumber: null }),
      improvement({
        id: "direct",
        delivery: "direct",
        status: "committed",
        commitUrl: null,
      }),
    ]);

    // All three paths must be in flight while none has resolved. Serialised,
    // only the first would have been issued at this point.
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(seen.some((u) => u.includes("/pulls/1"))).toBe(true);
    expect(seen.some((u) => u.includes("/search/issues"))).toBe(true);
    expect(seen.some((u) => u.includes("/search/commits"))).toBe(true);

    release();
    await scan;
    vi.unstubAllGlobals();
  });

  it("throttles a repeat scan of the same workspace but not of a different one", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        number: 1,
        html_url: "https://github.com/o/r/pull/1",
        state: "open",
        merged_at: null,
        merged: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ws = nextWorkspace();
    const rows = [improvement({ id: "a", prNumber: 1 })];

    await scanImprovementsForPRs(ws, rows);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second render of the same workspace inside the window: no GitHub work.
    const unchanged = await scanImprovementsForPRs(ws, rows);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Callers still get their rows back, just not re-reconciled.
    expect(unchanged).toEqual(rows);

    // A different workspace is unaffected by that stamp.
    await scanImprovementsForPRs(nextWorkspace(), rows);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("resolves an improvement from a marker match in the PR body", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/search/issues")) {
        return jsonResponse({
          items: [
            {
              number: 7,
              html_url: "https://github.com/o/r/pull/7",
              state: "closed",
              pull_request: { merged_at: "2026-08-18T00:00:00Z" },
              body: "fixes tembo-improvement:target",
            },
          ],
        });
      }
      return jsonResponse({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await scanImprovementsForPRs(nextWorkspace(), [
      improvement({ id: "target", prNumber: null, status: "submitted" }),
    ]);

    expect(setImprovementPr).toHaveBeenCalledWith({
      id: "target",
      prUrl: "https://github.com/o/r/pull/7",
      prNumber: 7,
      prState: "merged",
      status: "merged",
    });
    expect(out[0].status).toBe("merged");
    expect(out[0].prNumber).toBe(7);
    vi.unstubAllGlobals();
  });
});

describe("scheduleImprovementScan", () => {
  it("defers GitHub reconciliation until after the response", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        number: 1,
        html_url: "https://github.com/o/r/pull/1",
        state: "open",
        merged_at: null,
        merged: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    scheduleImprovementScan(nextWorkspace(), [
      improvement({ id: "a", prNumber: 1 }),
    ]);

    expect(scheduleAfterResponse).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const callback = scheduleAfterResponse.mock.calls[0][0];
    await callback();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("does not schedule work when every improvement is terminal", () => {
    scheduleImprovementScan(nextWorkspace(), [
      improvement({ id: "a", status: "merged" }),
      improvement({ id: "b", status: "closed" }),
    ]);

    expect(scheduleAfterResponse).not.toHaveBeenCalled();
  });
});
