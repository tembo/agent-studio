import "server-only";

import type { ApiCtx, ActionFailure } from "./actions";
import { findMissingConnections, missingConnectionsMessage } from "@/lib/connection-checks";
import { createRun } from "@/lib/runs-api";
import { resolveAgentForDispatch } from "@/lib/workspace-agents";
import { buildOutputReuseKey, outputReuseSchema } from "@/lib/output-reuse";
import type { OutputReuseOptions } from "@/lib/output-reuse";

export type TriggerRunInput = {
  agent: string;
  message?: string;
  preferDraft?: boolean;
  outputReuse?: OutputReuseOptions;
  /** The orchestrator run that triggered this sub-agent through /mcp. */
  orchestratorRunId?: string;
};

export async function triggerRun(
  ctx: ApiCtx,
  input: TriggerRunInput,
): Promise<{ ok: true; runId: string; reusedFromRunId?: string | null } | ActionFailure> {
  if (input.outputReuse !== undefined) {
    const parsed = outputReuseSchema.safeParse(input.outputReuse);
    if (!parsed.success) return { ok: false, status: 400, error: "Invalid outputReuse: require reportType and maxAgeSeconds (0–604800)." };
    input = { ...input, outputReuse: parsed.data };
  }
  const dispatch = await resolveAgentForDispatch(ctx.workspace.id, input.agent, {
    preferDraft: input.preferDraft ?? false,
  });
  if (!dispatch.ok) {
    const status = dispatch.error.kind === "not-found" ? 404 : 422;
    return { ok: false, status, error: dispatch.error.message };
  }
  const r = dispatch.resolved;

  // Same pre-flight the UI's Run-now uses: block a run the acting user can't
  // complete (a declared connection they haven't authorized) with an
  // actionable message rather than a mid-run traceback.
  const missing = await findMissingConnections(
    ctx.workspace.id,
    ctx.userId,
    r.connections,
  );
  if (missing.length > 0) {
    return { ok: false, status: 422, error: missingConnectionsMessage(missing, true) };
  }

  // Scope lookup failure is a cache miss: it must never block normal execution.
  let reuseKey: string | undefined;
  if (input.outputReuse && r.versionId && r.versionLabel !== "draft") {
    try {
      reuseKey = await buildOutputReuseKey(ctx, r, input.message ?? "", input.outputReuse.reportType);
    } catch {
      console.warn("[output-reuse] scope lookup failed; running normally");
    }
  }
  try {
    const res = await createRun({
      workspaceId: ctx.workspace.id,
      userId: ctx.userId,
      agentName: r.agentName,
      agentPath: r.agentPath,
      model: r.model,
      framework: r.framework,
      specContent: r.specContent,
      specFormat: r.specFormat,
      toolsModuleContent: r.toolsModuleContent,
      skillsContent: r.skillsContent,
      userMessage: input.message ?? "",
      trigger: "manual",
      agentVersionId: r.versionId,
      agentVersionLabel: r.versionLabel,
      orchestratorRunId: input.orchestratorRunId,
      delivery: r.delivery,
      outputReuse: reuseKey && input.outputReuse ? {
        key: reuseKey,
        reportType: input.outputReuse.reportType,
        maxAgeSeconds: input.outputReuse.requireFresh ? 0 : input.outputReuse.maxAgeSeconds,
      } : undefined,
    });
    // Not audited explicitly: the run row projects into the audit timeline as a
    // run.* event attributed to ctx.userId (see auditApiMutation note).
    return { ok: true, runId: res.runId, reusedFromRunId: res.reusedFromRunId };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : "Couldn't queue the run.",
    };
  }
}

