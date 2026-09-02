import { NextResponse, type NextRequest } from "next/server";

import { authorizeApiRequest } from "@/lib/api-auth";
import { getEvalRun } from "@/lib/agent-evals-db";
import { apiError, authErrorResponse } from "@/lib/api-v1/http";
import { serializeEvalRun } from "@/lib/api-v1/serializers";

export const dynamic = "force-dynamic";

type RouteParams = Promise<{ id: string }>;

export async function GET(
  request: NextRequest,
  { params }: { params: RouteParams },
): Promise<NextResponse> {
  const auth = await authorizeApiRequest(request, "viewer");
  if (!auth.ok) return authErrorResponse(auth);

  const { id } = await params;
  const evalRun = await getEvalRun(auth.workspace.id, id);
  if (!evalRun) return apiError(404, "eval not found");

  return NextResponse.json({ eval: serializeEvalRun(evalRun) });
}
