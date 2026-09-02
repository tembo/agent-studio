import "server-only";

import {
  parseAgentContent,
  type AgentFileFormat,
} from "@/lib/agent-format";
import {
  evalSidecarCandidates,
  parseEvalContent,
  parseEvalFile,
  scoreAssert,
  specHash,
  type EvalCase,
  type EvalSuite,
} from "@/lib/agent-evals";
import {
  finishEvalRun,
  getEvalRun,
  insertEvalRun,
  markEvalRunning,
  type EvalCaseResult,
  type EvalRunSource,
  type AgentEvalRun,
} from "@/lib/agent-evals-db";
import { scoreJudge } from "@/lib/agent-evals-judge";
import { resolveAgentReader } from "@/lib/agent-source";
import { getPublicOrigin } from "@/lib/config";
import { postCommitStatus } from "@/lib/github";
import {
  findMissingConnections,
  missingConnectionsMessage,
} from "@/lib/connection-checks";
import { createRun, getRun } from "@/lib/runs-api";
import { getWorkspaceById, getWorkspaceRepo, getWorkspaceSecretPlaintext } from "@/lib/workspace";
import {
  resolveAgentForDispatch,
  type ResolvedDispatch,
} from "@/lib/workspace-agents";

const CASE_TIMEOUT_MS = 180_000;
const POLL_MS = 1500;

export type StartEvalInput = {
  workspaceId: string;
  userId: string;
  agent: string;
  version?: "draft" | "stable";
  spec?: string;
  specFormat?: AgentFileFormat;
  eval?: string;
  evalFormat?: AgentFileFormat;
  commitSha?: string | null;
  source: EvalRunSource;
};

export type StartEvalResult =
  | { ok: true; evalRun: AgentEvalRun }
  | { ok: false; status: number; error: string };

export async function startEvalRun(
  input: StartEvalInput,
): Promise<StartEvalResult> {
  const prepared = await prepareEval(input);
  if (!prepared.ok) return prepared;

  const evalRun = await insertEvalRun({
    workspaceId: input.workspaceId,
    agentName: prepared.dispatch.agentName,
    agentVersionId: prepared.dispatch.versionId,
    agentVersionLabel: prepared.dispatch.versionLabel,
    source: input.source,
    commitSha: input.commitSha ?? null,
    specHash: specHash(prepared.dispatch.specContent),
    createdBy: input.userId,
  });

  scheduleEvalRun({
    evalRunId: evalRun.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    dispatch: prepared.dispatch,
    suite: prepared.suite,
  });

  return { ok: true, evalRun };
}

export function scheduleEvalRun(args: {
  evalRunId: string;
  workspaceId: string;
  userId: string;
  dispatch: ResolvedDispatch;
  suite: EvalSuite;
}): void {
  void executeEvalRun(args).catch(async (err) => {
    await finishEvalRun({
      id: args.evalRunId,
      status: "error",
      passedCount: 0,
      failedCount: 0,
      errorMessage: err instanceof Error ? err.message : "Eval runner failed.",
      caseResults: [],
    }).catch(() => undefined);
    await postEvalGithubStatus(args.workspaceId, args.evalRunId).catch(
      () => undefined,
    );
  });
}

async function prepareEval(
  input: StartEvalInput,
): Promise<
  | { ok: true; dispatch: ResolvedDispatch; suite: EvalSuite }
  | { ok: false; status: number; error: string }
> {
  const preferDraft = input.version !== "stable";
  let dispatch: ResolvedDispatch;

  if (input.spec !== undefined) {
    const format =
      input.specFormat ??
      (input.spec.trimStart().startsWith("{") ? "json" : "yaml");
    const parsed = parseAgentContent(input.spec, format);
    if (!parsed.ok) {
      return {
        ok: false,
        status: 400,
        error: parsed.detail ?? `Invalid spec: ${parsed.error}`,
      };
    }
    const existing = await resolveAgentForDispatch(
      input.workspaceId,
      parsed.spec.name,
      { preferDraft: true },
    );
    const model =
      parsed.spec.framework === "cargo-ai"
        ? parsed.spec.model
        : parsed.spec.model;
    if (!model) {
      return { ok: false, status: 400, error: "Spec has no model declared." };
    }
    dispatch = {
      agentName: parsed.spec.name,
      agentPath: existing.ok
        ? existing.resolved.agentPath
        : `agents/${parsed.spec.framework}/${parsed.spec.name}.${format === "json" ? "json" : "yaml"}`,
      framework: parsed.spec.framework,
      model,
      specContent: input.spec,
      specFormat: format,
      versionId: null,
      versionLabel: "draft",
      toolsModuleContent: existing.ok
        ? existing.resolved.toolsModuleContent
        : undefined,
      skillsContent: existing.ok ? existing.resolved.skillsContent : undefined,
      connections:
        parsed.spec.framework === "pydantic-agentspec"
          ? parsed.spec.connections
          : [],
      delivery: parsed.spec.delivery,
    };
  } else {
    const resolved = await resolveAgentForDispatch(
      input.workspaceId,
      input.agent,
      { preferDraft },
    );
    if (!resolved.ok) {
      const status = resolved.error.kind === "not-found" ? 404 : 422;
      return { ok: false, status, error: resolved.error.message };
    }
    dispatch = resolved.resolved;
  }

  if (dispatch.agentName !== input.agent && input.spec === undefined) {
    return { ok: false, status: 404, error: `Agent "${input.agent}" not found.` };
  }

  const suite = await loadSuite(input, dispatch.agentPath);
  if (!suite.ok) return suite;

  const missing = await findMissingConnections(
    input.workspaceId,
    input.userId,
    dispatch.connections,
  );
  if (missing.length > 0) {
    return { ok: false, status: 422, error: missingConnectionsMessage(missing, true) };
  }

  return { ok: true, dispatch, suite: suite.suite };
}

async function loadSuite(
  input: StartEvalInput,
  agentPath: string,
): Promise<
  | { ok: true; suite: EvalSuite }
  | { ok: false; status: number; error: string }
> {
  if (input.eval !== undefined) {
    const format =
      input.evalFormat ??
      (input.eval.trimStart().startsWith("{") ? "json" : "yaml");
    const parsed = parseEvalContent(input.eval, format);
    if (!parsed.ok) {
      return { ok: false, status: 400, error: parsed.detail };
    }
    return { ok: true, suite: parsed.suite };
  }

  const loaded = await readEvalSuite(input.workspaceId, agentPath);
  if (!loaded) {
    return {
      ok: false,
      status: 404,
      error: `No eval file for this agent. Add a sidecar next to the spec (e.g. ${evalSidecarCandidates(agentPath)[0]}).`,
    };
  }
  if (!loaded.ok) {
    return { ok: false, status: 400, error: loaded.detail };
  }
  return { ok: true, suite: loaded.suite };
}

export async function readEvalSuite(
  workspaceId: string,
  agentPath: string,
): Promise<
  | { ok: true; suite: EvalSuite; path: string }
  | { ok: false; error: string; detail: string }
  | null
> {
  const reader = await resolveAgentReader(workspaceId);
  if (!reader) return null;
  for (const path of evalSidecarCandidates(agentPath)) {
    const read = await reader.readFile(path);
    if (!read.ok) continue;
    const parsed = parseEvalFile(path, read.content);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, detail: parsed.detail };
    }
    return { ok: true, suite: parsed.suite, path };
  }
  return null;
}

async function executeEvalRun(args: {
  evalRunId: string;
  workspaceId: string;
  userId: string;
  dispatch: ResolvedDispatch;
  suite: EvalSuite;
}): Promise<void> {
  await markEvalRunning(args.evalRunId);
  const results: EvalCaseResult[] = [];
  try {
    for (const evalCase of args.suite.cases) {
      results.push(
        await runCase({
          workspaceId: args.workspaceId,
          userId: args.userId,
          dispatch: args.dispatch,
          evalCase,
        }),
      );
    }
    const failedCount = results.filter((r) => !r.passed).length;
    const passedCount = results.length - failedCount;
    await finishEvalRun({
      id: args.evalRunId,
      status: failedCount === 0 ? "passed" : "failed",
      passedCount,
      failedCount,
      caseResults: results,
    });
    await postEvalGithubStatus(args.workspaceId, args.evalRunId);
  } catch (err) {
    await finishEvalRun({
      id: args.evalRunId,
      status: "error",
      passedCount: results.filter((r) => r.passed).length,
      failedCount: results.filter((r) => !r.passed).length,
      errorMessage: err instanceof Error ? err.message : "Eval runner failed.",
      caseResults: results,
    });
    await postEvalGithubStatus(args.workspaceId, args.evalRunId);
  }
}

async function postEvalGithubStatus(
  workspaceId: string,
  evalRunId: string,
): Promise<void> {
  const evalRun = await getEvalRun(workspaceId, evalRunId);
  if (!evalRun?.commitSha) return;
  const repo = await getWorkspaceRepo(workspaceId);
  const token = await getWorkspaceSecretPlaintext(workspaceId, "github_pat");
  if (!repo || !token) return;
  const workspace = await getWorkspaceById(workspaceId);
  const state =
    evalRun.status === "passed"
      ? "success"
      : evalRun.status === "failed"
        ? "failure"
        : "error";
  const description =
    evalRun.status === "passed"
      ? `${evalRun.passedCount} assertion${evalRun.passedCount === 1 ? "" : "s"} passed`
      : evalRun.status === "failed"
        ? `${evalRun.failedCount} assertion${evalRun.failedCount === 1 ? "" : "s"} failed`
        : (evalRun.errorMessage ?? "Eval error").slice(0, 140);
  await postCommitStatus(token, {
    owner: repo.owner,
    name: repo.name,
    sha: evalRun.commitSha,
    state,
    context: "tas/evals",
    description,
    targetUrl: workspace
      ? `${getPublicOrigin()}/${workspace.slug}/agents/${encodeURIComponent(evalRun.agentName)}/versions`
      : undefined,
  });
}

async function runCase(args: {
  workspaceId: string;
  userId: string;
  dispatch: ResolvedDispatch;
  evalCase: EvalCase;
}): Promise<EvalCaseResult> {
  const { dispatch, evalCase } = args;
  let runId: string | null = null;
  try {
    const created = await createRun({
      workspaceId: args.workspaceId,
      userId: args.userId,
      agentName: dispatch.agentName,
      agentPath: dispatch.agentPath,
      model: dispatch.model,
      framework: dispatch.framework,
      specContent: dispatch.specContent,
      specFormat: dispatch.specFormat,
      toolsModuleContent: dispatch.toolsModuleContent,
      skillsContent: dispatch.skillsContent,
      userMessage: evalCase.input,
      trigger: "eval",
      agentVersionId: dispatch.versionId,
      agentVersionLabel: dispatch.versionLabel,
      delivery: dispatch.delivery,
    });
    runId = created.runId;
    const run = await waitForRun(runId, args.workspaceId);
    if (!run) {
      return fail(evalCase, "Run disappeared before it finished.", runId);
    }
    if (run.status !== "succeeded") {
      return fail(
        evalCase,
        run.failureSummary ?? run.errorMessage ?? `Run ${run.status}.`,
        runId,
        run.output || null,
      );
    }
    const output = run.output ?? "";
    const reasons: string[] = [];
    let assertPassed: boolean | null = null;
    let gateFailed = false;
    if (evalCase.assert) {
      const scored = scoreAssert(output, evalCase.assert);
      assertPassed = scored.passed;
      if (!scored.passed) gateFailed = true;
      reasons.push(scored.reason);
    }
    let judgePassed: boolean | null = null;
    if (evalCase.judge) {
      const judged = await scoreJudge(
        args.workspaceId,
        output,
        evalCase.judge.rubric,
      );
      judgePassed = judged.passed;
      reasons.push(`judge: ${judged.reason}`);
    }
    return {
      name: evalCase.name,
      input: evalCase.input,
      passed: !gateFailed,
      assertPassed,
      judgePassed,
      reason: reasons.join(" · "),
      output,
      runId,
    };
  } catch (err) {
    return fail(
      evalCase,
      err instanceof Error ? err.message : "Couldn't queue the eval run.",
      runId,
    );
  }
}

function fail(
  evalCase: EvalCase,
  reason: string,
  runId: string | null,
  output: string | null = null,
): EvalCaseResult {
  return {
    name: evalCase.name,
    input: evalCase.input,
    passed: false,
    assertPassed: false,
    judgePassed: null,
    reason,
    output,
    runId,
  };
}

async function waitForRun(runId: string, workspaceId: string) {
  const deadline = Date.now() + CASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = await getRun(runId, workspaceId);
    if (
      run &&
      (run.status === "succeeded" ||
        run.status === "failed" ||
        run.status === "cancelled")
    ) {
      return run;
    }
    await sleep(POLL_MS);
  }
  return getRun(runId, workspaceId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
