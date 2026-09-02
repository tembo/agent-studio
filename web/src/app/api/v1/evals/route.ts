import { NextResponse, type NextRequest } from "next/server";

import { authorizeApiRequest } from "@/lib/api-auth";
import { getLatestEvalRun, listEvalRuns } from "@/lib/agent-evals-db";
import { startEvalRun } from "@/lib/agent-evals-run";
import { apiError, authErrorResponse } from "@/lib/api-v1/http";
import { serializeEvalRun } from "@/lib/api-v1/serializers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authorizeApiRequest(request, "viewer");
  if (!auth.ok) return authErrorResponse(auth);

  const agent = request.nextUrl.searchParams.get("agent")?.trim();
  if (!agent) return apiError(400, "`agent` query parameter is required");

  const latestOnly = request.nextUrl.searchParams.get("latest") === "true";
  if (latestOnly) {
    const latest = await getLatestEvalRun(auth.workspace.id, agent);
    return NextResponse.json({
      eval: latest ? serializeEvalRun(latest) : null,
    });
  }

  const evals = await listEvalRuns(auth.workspace.id, agent);
  return NextResponse.json({ evals: evals.map(serializeEvalRun) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authorizeApiRequest(request, "operator");
  if (!auth.ok) return authErrorResponse(auth);

  let body: {
    agent?: unknown;
    version?: unknown;
    spec?: unknown;
    specFormat?: unknown;
    eval?: unknown;
    evalFormat?: unknown;
    commitSha?: unknown;
    source?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return apiError(400, "request body must be JSON");
  }
  if (typeof body.agent !== "string" || !body.agent.trim()) {
    return apiError(400, "`agent` (string) is required");
  }
  const version = body.version === "stable" ? "stable" : "draft";
  const source =
    body.source === "ci" ||
    body.source === "manual" ||
    body.source === "api" ||
    body.source === "pr"
      ? body.source
      : "api";
  const specFormat =
    body.specFormat === "yaml" || body.specFormat === "json"
      ? body.specFormat
      : undefined;
  const evalFormat =
    body.evalFormat === "yaml" || body.evalFormat === "json"
      ? body.evalFormat
      : undefined;

  const result = await startEvalRun({
    workspaceId: auth.workspace.id,
    userId: auth.userId,
    agent: body.agent.trim(),
    version,
    spec: typeof body.spec === "string" ? body.spec : undefined,
    specFormat,
    eval: typeof body.eval === "string" ? body.eval : undefined,
    evalFormat,
    commitSha: typeof body.commitSha === "string" ? body.commitSha : null,
    source,
  });
  if (!result.ok) return apiError(result.status, result.error);

  return NextResponse.json(
    { eval_id: result.evalRun.id, eval: serializeEvalRun(result.evalRun) },
    { status: 202 },
  );
}
