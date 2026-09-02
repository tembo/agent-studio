import "server-only";

import { evalSidecarCandidates, parseEvalFile } from "@/lib/agent-evals";
import { getEvalRunByCommitSha } from "@/lib/agent-evals-db";
import { startEvalRun } from "@/lib/agent-evals-run";
import { getPublicOrigin } from "@/lib/config";
import { postCommitStatus, readFile, type RepoRef } from "@/lib/github";
import type { Improvement } from "@/lib/improvements-api";
import {
  getWorkspaceById,
  getWorkspaceRepo,
  getWorkspaceSecretPlaintext,
} from "@/lib/workspace";

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

/**
 * When an authoring PR is open, run the agent's eval suite against the PR
 * head inside TAS (not a customer GitHub Action). Dedupes on commit SHA.
 */
export async function schedulePrEvals(
  workspaceId: string,
  improvements: Improvement[],
): Promise<void> {
  const open = improvements.filter(
    (i) => i.status === "pr_opened" && i.prNumber !== null,
  );
  if (open.length === 0) return;
  await Promise.allSettled(
    open.map((imp) => maybeEvalImprovement(workspaceId, imp)),
  );
}

async function maybeEvalImprovement(
  workspaceId: string,
  imp: Improvement,
): Promise<void> {
  if (imp.prNumber === null) return;
  const repo = await getWorkspaceRepo(workspaceId);
  const token = await getWorkspaceSecretPlaintext(workspaceId, "github_pat");
  if (!repo || !token) return;

  const head = await fetchPullHead(repo.owner, repo.name, imp.prNumber, token);
  if (!head) return;

  const existing = await getEvalRunByCommitSha(
    workspaceId,
    imp.agentName,
    head.sha,
  );
  if (existing) return;

  const ref: RepoRef = { owner: repo.owner, name: repo.name, branch: head.sha };
  const specRead = await readFile(token, ref, imp.agentPath);
  if (!specRead.ok) return;

  let evalContent: string | undefined;
  let evalFormat: "yaml" | "json" | undefined;
  for (const path of evalSidecarCandidates(imp.agentPath)) {
    const read = await readFile(token, ref, path);
    if (!read.ok) continue;
    const parsed = parseEvalFile(path, read.content);
    if (!parsed.ok) return;
    evalContent = read.content;
    evalFormat = parsed.format;
    break;
  }
  if (!evalContent) return;

  const workspace = await getWorkspaceById(workspaceId);
  await postCommitStatus(token, {
    owner: repo.owner,
    name: repo.name,
    sha: head.sha,
    state: "pending",
    context: "tas/evals",
    description: "Running assertions in TAS…",
    targetUrl: workspace
      ? `${getPublicOrigin()}/${workspace.slug}/agents/${encodeURIComponent(imp.agentName)}/versions`
      : undefined,
  });

  await startEvalRun({
    workspaceId,
    userId: imp.createdBy,
    agent: imp.agentName,
    version: "draft",
    spec: specRead.content,
    eval: evalContent,
    evalFormat,
    commitSha: head.sha,
    source: "pr",
  });
}

async function fetchPullHead(
  owner: string,
  name: string,
  number: number,
  token: string,
): Promise<{ sha: string } | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${name}/pulls/${number}`,
    { headers: GH_HEADERS(token), cache: "no-store" },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { head?: { sha?: string } };
  const sha = body.head?.sha;
  return sha ? { sha } : null;
}
