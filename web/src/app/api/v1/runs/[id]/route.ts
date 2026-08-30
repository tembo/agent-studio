import { NextResponse, type NextRequest } from "next/server";

import { authorizeApiRequest } from "@/lib/api-auth";
import { apiError, authErrorResponse } from "@/lib/api-v1/http";
import { serializeRunRecord } from "@/lib/api-v1/serializers";
import { getRun } from "@/lib/runs-api";

// GET /api/v1/runs/[id] — full run record incl. output, live streamedOutput,
// safe failure copy, and token usage. Raw diagnostics are included only for
// workspace admins. Scoped to the key's workspace so one workspace can't read
// another's run by id.

export const dynamic = "force-dynamic";

type RouteParams = Promise<{ id: string }>;

export async function GET(
  request: NextRequest,
  { params }: { params: RouteParams },
): Promise<NextResponse> {
  const auth = await authorizeApiRequest(request, "viewer");
  if (!auth.ok) return authErrorResponse(auth);

  const { id } = await params;
  let run;
  try {
    run = await getRun(id, auth.workspace.id);
  } catch {
    return apiError(502, "could not reach the run service");
  }
  if (!run) return apiError(404, "run not found");

  return NextResponse.json({
    run: serializeRunRecord(run, {
      includeDiagnostics: auth.role === "workspace_admin",
    }),
  });
}
