import "server-only";

import { after } from "next/server";

// On-demand scan that reconciles each open improvement row's PR state with
// GitHub. Called when the user visits /<workspace>/improvements (and the
// dashboard / inventory). No webhook infra — trades freshness for simplicity.
//
// Paths, by delivery mode:
//   PR mode:
//     1. Improvements that already have a PR number → fetch that PR DIRECTLY
//        (`GET /repos/:o/:r/pulls/:n`). The direct endpoint reports `merged` /
//        `merged_at` reliably; the search API does NOT (its `pull_request.
//        merged_at` is frequently null even for merged PRs, which left merged
//        improvements stuck showing "PR opened").
//     2. Improvements with no PR yet → search the repo body for the marker to
//        discover the PR that Tembo opened.
//   Direct (YOLO) mode:
//     3. Improvements already optimistically 'committed' but with no commit URL
//        yet → search commit messages for the marker to attach the landed
//        commit (sha + html url).

import { schedulePrEvals } from "@/lib/agent-evals-pr";
import {
  setImprovementCommit,
  setImprovementPr,
  type Improvement,
  type ImprovementStatus,
  IMPROVEMENT_MARKER_PREFIX,
  improvementMarker,
} from "@/lib/improvements-api";
import { getWorkspaceRepo, getWorkspaceSecretPlaintext } from "@/lib/workspace";

interface GhSearchResult {
  total_count: number;
  items: Array<{
    number: number;
    title: string;
    html_url: string;
    state: string;
    pull_request?: {
      merged_at: string | null;
    };
    body: string | null;
  }>;
}

interface GhPull {
  number: number;
  html_url: string;
  state: string;
  merged_at: string | null;
  merged: boolean;
}

interface GhCommitSearch {
  items: Array<{
    sha: string;
    html_url: string;
    commit: { message: string };
  }>;
}

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

// Every workspace surface that renders improvement state requests this scan,
// and the scan is several GitHub round trips —
// two of them on the search endpoints, which are capped at ~30 req/min and
// routinely take a second each. Unthrottled, a dashboard refresh pays the
// full cost every time if it waits for the result. Re-scanning at most once per
// window per workspace keeps a merge visible within a minute while making
// repeat views free.
//
// In-process and per-instance on purpose: this throttles redundant work, it
// doesn't guard correctness, so a second web replica scanning once more per
// window is harmless. Restarts just re-scan once.
const SCAN_TTL_MS = 60_000;
const lastScanAt = new Map<string, number>();

// GitHub applies secondary rate limits to bursts of concurrent requests from
// a single token. Fanning out one PR fetch per open improvement at once (a
// workspace can have dozens) draws 403s that fetchPull silently swallows, so
// the scan does the work and throws the answers away. Cap the burst instead.
const PR_FETCH_CONCURRENCY = 8;

/** Refresh stored GitHub state without holding the current page response open. */
export function scheduleImprovementScan(
  workspaceId: string,
  improvements: Improvement[],
): void {
  const hasOpen = improvements.some(
    (improvement) =>
      improvement.status !== "merged" && improvement.status !== "closed",
  );
  if (!hasOpen) return;

  after(async () => {
    await scanImprovementsForPRs(workspaceId, improvements);
  });
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

export async function scanImprovementsForPRs(
  workspaceId: string,
  improvements: Improvement[],
): Promise<Improvement[]> {
  // Only improvements that haven't reached a terminal state need
  // checking. "merged" + "closed" are final.
  const open = improvements.filter(
    (i) => i.status !== "merged" && i.status !== "closed",
  );
  if (open.length === 0) return improvements;

  // Stamped before the scan rather than after so concurrent renders of the
  // same workspace don't all pass the check and pile onto GitHub together.
  const now = Date.now();
  if (now - (lastScanAt.get(workspaceId) ?? 0) < SCAN_TTL_MS) {
    return improvements;
  }
  lastScanAt.set(workspaceId, now);

  const repo = await getWorkspaceRepo(workspaceId);
  if (!repo) return improvements;
  const token = await getWorkspaceSecretPlaintext(workspaceId, "github_pat");
  if (!token) return improvements;

  const updates = new Map<string, Improvement>();

  // Direct-commit improvements never have a PR; they're reconciled by commit
  // search (Path 3). Everything else follows the PR paths.
  const prImprovements = open.filter((i) => i.delivery !== "direct");
  const directImprovements = open.filter(
    (i) => i.delivery === "direct" && i.commitUrl === null,
  );

  // The three paths read disjoint improvement sets and write disjoint rows,
  // so they run concurrently. Serialising them put two of GitHub's slowest
  // endpoints (the search APIs) back-to-back on the render path.

  // ── Path 1: improvements with a known PR number — fetch each PR directly
  // so merged/closed is detected reliably. ───────────────────────────────
  const withPr = prImprovements.filter((i) => i.prNumber !== null);
  const scanKnownPrs = async (): Promise<void> => {
    await mapWithConcurrency(withPr, PR_FETCH_CONCURRENCY, async (imp) => {
      const pr = await fetchPull(repo.owner, repo.name, imp.prNumber!, token);
      if (!pr) return;
      const mergedAt = pr.merged_at ?? (pr.merged ? new Date(0).toISOString() : null);
      const status = derivePrStatus(pr.state, mergedAt);
      const newState = derivePrState(pr.state, mergedAt);
      if (
        imp.prUrl === pr.html_url &&
        imp.prState === newState &&
        imp.status === status
      ) {
        updates.set(imp.id, imp);
        return;
      }
      await setImprovementPr({
        id: imp.id,
        prUrl: pr.html_url,
        prNumber: pr.number,
        prState: newState,
        status,
      });
      updates.set(imp.id, {
        ...imp,
        prUrl: pr.html_url,
        prNumber: pr.number,
        prState: newState,
        status,
      });
    });
  };

  // ── Path 2: improvements with no PR yet — discover via body search. ─────
  const withoutPr = prImprovements.filter((i) => i.prNumber === null);
  const discoverPrs = async (): Promise<void> => {
    if (withoutPr.length === 0) return;
    // GitHub's search API caps `in:body` queries by length. Ask for ALL PRs
    // mentioning the marker prefix; match by id client-side. Capped at 100.
    const q = `repo:${repo.owner}/${repo.name} is:pr "${IMPROVEMENT_MARKER_PREFIX}" in:body`;
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100`;
    const res = await fetch(url, { headers: GH_HEADERS(token), cache: "no-store" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log(
        "[improvement-scan] github search failed",
        res.status,
        body.slice(0, 300),
      );
      return;
    }
    const search = (await res.json()) as GhSearchResult;
    const byId = new Map(withoutPr.map((i) => [i.id, i]));
    const writes: Promise<void>[] = [];
    for (const pr of search.items) {
      const body = pr.body ?? "";
      for (const [id, existing] of byId) {
        if (!body.includes(improvementMarker(id))) continue;
        // An improvement is claimed by exactly one PR. Drop it from the pool
        // so later search hits don't re-match an id already resolved.
        byId.delete(id);
        const mergedAt = pr.pull_request?.merged_at ?? null;
        const status = derivePrStatus(pr.state, mergedAt);
        const newState = derivePrState(pr.state, mergedAt);
        writes.push(
          setImprovementPr({
            id,
            prUrl: pr.html_url,
            prNumber: pr.number,
            prState: newState,
            status,
          }).then(() => {
            updates.set(id, {
              ...existing,
              prUrl: pr.html_url,
              prNumber: pr.number,
              prState: newState,
              status,
            });
          }),
        );
      }
    }
    await Promise.all(writes);
  };

  // ── Path 3: direct-commit improvements — find the marker commit on the
  // default branch and attach it. ────────────────────────────────────────
  const attachCommits = async (): Promise<void> => {
    if (directImprovements.length === 0) return;
    const q = `repo:${repo.owner}/${repo.name} "${IMPROVEMENT_MARKER_PREFIX}"`;
    const url = `https://api.github.com/search/commits?q=${encodeURIComponent(q)}&per_page=100`;
    const res = await fetch(url, { headers: GH_HEADERS(token), cache: "no-store" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log(
        "[improvement-scan] github commit search failed",
        res.status,
        body.slice(0, 300),
      );
      return;
    }
    const search = (await res.json()) as GhCommitSearch;
    const byId = new Map(directImprovements.map((i) => [i.id, i]));
    const writes: Promise<void>[] = [];
    for (const c of search.items) {
      const message = c.commit?.message ?? "";
      for (const [id, existing] of byId) {
        if (!message.includes(improvementMarker(id))) continue;
        byId.delete(id);
        writes.push(
          setImprovementCommit({
            id,
            commitSha: c.sha,
            commitUrl: c.html_url,
          }).then(() => {
            updates.set(id, {
              ...existing,
              commitSha: c.sha,
              commitUrl: c.html_url,
              status: "committed",
            });
          }),
        );
      }
    }
    await Promise.all(writes);
  };

  await Promise.all([scanKnownPrs(), discoverPrs(), attachCommits()]);

  // Return improvements with updated rows folded in.
  const next = improvements.map((i) => updates.get(i.id) ?? i);
  await schedulePrEvals(workspaceId, next).catch(() => undefined);
  return next;
}

async function fetchPull(
  owner: string,
  name: string,
  number: number,
  token: string,
): Promise<GhPull | null> {
  const url = `https://api.github.com/repos/${owner}/${name}/pulls/${number}`;
  const res = await fetch(url, { headers: GH_HEADERS(token), cache: "no-store" });
  if (!res.ok) {
    if (res.status !== 404) {
      console.log("[improvement-scan] pr fetch failed", number, res.status);
    }
    return null;
  }
  return (await res.json()) as GhPull;
}

function derivePrStatus(
  ghState: string,
  mergedAt: string | null,
): ImprovementStatus {
  if (mergedAt) return "merged";
  if (ghState === "closed") return "closed";
  return "pr_opened";
}

function derivePrState(
  ghState: string,
  mergedAt: string | null,
): "merged" | "closed" | "open" {
  if (mergedAt) return "merged";
  if (ghState === "closed") return "closed";
  return "open";
}
