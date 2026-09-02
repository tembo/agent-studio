import { NextResponse, type NextRequest } from "next/server";

import { authorizeApiRequest } from "@/lib/api-auth";
import { triggerRun } from "@/lib/api-v1/actions";
import { apiError, authErrorResponse } from "@/lib/api-v1/http";
import { serializeRunListItem } from "@/lib/api-v1/serializers";
import {
  RUN_ENVIRONMENTS,
  type RunEnvironment,
} from "@/lib/run-environment";
import {
  listRunsForWorkspace,
  type RunListFilters,
  type RunTrigger,
} from "@/lib/runs-db";

// GET /api/v1/runs — paginated run history for the workspace. Filters via query:
//   ?status=succeeded,failed  ?agent=<name>  ?trigger=manual,schedule
//   ?limit=50  ?before=<ISO timestamp>   (cursor = createdAt of the last row)
// Min role viewer. (POST /api/v1/runs to trigger a run is added in P4.)

export const dynamic = "force-dynamic";

const STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
type RunStatus = (typeof STATUSES)[number];
const TRIGGERS: RunTrigger[] = ["manual", "schedule", "event", "eval"];

function csv(value: string | null): string[] {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authorizeApiRequest(request, "viewer");
  if (!auth.ok) return authErrorResponse(auth);

  const sp = request.nextUrl.searchParams;

  const statuses = csv(sp.get("status")).filter((s): s is RunStatus =>
    (STATUSES as readonly string[]).includes(s),
  );
  const triggerParam = sp.get("trigger");
  const triggers = csv(triggerParam).filter((t): t is RunTrigger =>
    (TRIGGERS as string[]).includes(t),
  );
  const agentName = sp.get("agent") ?? undefined;
  const environments = csv(sp.get("environment")).filter(
    (environment): environment is RunEnvironment =>
      (RUN_ENVIRONMENTS as readonly string[]).includes(environment),
  );

  const filters: RunListFilters = {
    ...(statuses.length ? { statuses } : {}),
    ...(triggers.length ? { triggers } : {}),
    ...(environments.length ? { environments } : {}),
    ...(agentName ? { agentName } : {}),
  };

  const limitRaw = sp.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limitRaw && (!Number.isFinite(limit) || (limit as number) < 1)) {
    return apiError(400, "limit must be a positive integer");
  }

  const beforeRaw = sp.get("before");
  let before: Date | undefined;
  if (beforeRaw) {
    before = new Date(beforeRaw);
    if (Number.isNaN(before.getTime())) {
      return apiError(400, "before must be an ISO 8601 timestamp");
    }
  }

  const runs = await listRunsForWorkspace(auth.workspace.id, filters, {
    ...(limit ? { limit } : {}),
    ...(before ? { before } : {}),
  });

  return NextResponse.json({ runs: runs.map(serializeRunListItem) });
}

// POST /api/v1/runs — trigger a run of an agent, acting as the API key's user
// (so the run uses that user's connections). Body: { agent, message?,
// preferDraft? }. Returns 202 { run_id } once queued. Min role operator.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authorizeApiRequest(request, "operator");
  if (!auth.ok) return authErrorResponse(auth);

  let body: { agent?: unknown; message?: unknown; preferDraft?: unknown };
  try {
    body = await request.json();
  } catch {
    return apiError(400, "request body must be JSON");
  }
  if (typeof body.agent !== "string" || !body.agent.trim()) {
    return apiError(400, "`agent` (string) is required");
  }

  const result = await triggerRun(auth, {
    agent: body.agent,
    message: typeof body.message === "string" ? body.message : undefined,
    preferDraft: body.preferDraft === true,
  });
  if (!result.ok) return apiError(result.status, result.error);

  return NextResponse.json({ run_id: result.runId }, { status: 202 });
}
