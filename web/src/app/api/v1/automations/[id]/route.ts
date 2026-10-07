import { NextResponse, type NextRequest } from "next/server";

import { authorizeApiRequest } from "@/lib/api-auth";
import { writeAuditEvent } from "@/lib/audit-db";
import { apiError, authErrorResponse } from "@/lib/api-v1/http";
import { serializeAutomation } from "@/lib/api-v1/serializers";
import {
  deleteAutomation,
  getAutomation,
  updateAutomation,
} from "@/lib/automations-api";
import { validateCron } from "@/lib/cron";

// GET    /api/v1/automations/[id] — read one automation (viewer)
// PATCH  /api/v1/automations/[id] — update fields (operator)
// DELETE /api/v1/automations/[id] — remove it (operator)
//
// getAutomation/deleteAutomation aren't workspace-scoped at the lib layer (the
// id is a UUID), so every handler verifies the row belongs to the key's
// workspace before reading or mutating — otherwise a key could touch another
// workspace's automation by id.

export const dynamic = "force-dynamic";

type RouteParams = Promise<{ id: string }>;

export async function GET(
  request: NextRequest,
  { params }: { params: RouteParams },
): Promise<NextResponse> {
  const auth = await authorizeApiRequest(request, "viewer");
  if (!auth.ok) return authErrorResponse(auth);

  const { id } = await params;
  const automation = await getAutomation(id);
  if (!automation || automation.workspaceId !== auth.workspace.id) {
    return apiError(404, "automation not found");
  }
  return NextResponse.json({ automation: serializeAutomation(automation) });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: RouteParams },
): Promise<NextResponse> {
  const auth = await authorizeApiRequest(request, "operator");
  if (!auth.ok) return authErrorResponse(auth);

  const { id } = await params;
  const existing = await getAutomation(id);
  if (!existing || existing.workspaceId !== auth.workspace.id) {
    return apiError(404, "automation not found");
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "request body must be JSON");
  }

  const cron = typeof body.cron === "string" ? body.cron : existing.cron;
  if (typeof body.cron === "string") {
    const v = validateCron(cron, existing.timezone);
    if (!v.ok) return apiError(400, v.error);
  }

  // PATCH semantics: merge provided fields onto the existing record.
  const updated = await updateAutomation({
    id,
    name: typeof body.name === "string" ? body.name : existing.name,
    agentName: typeof body.agent === "string" ? body.agent : existing.agentName,
    cron,
    inputMessage:
      typeof body.inputMessage === "string" ? body.inputMessage : existing.inputMessage,
    enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
    ownerUserId: existing.ownerUserId,
    useDraft: typeof body.useDraft === "boolean" ? body.useDraft : existing.useDraft,
  });
  await writeAuditEvent({
    workspaceId: auth.workspace.id,
    actorUserId: auth.userId,
    source: "human_action",
    kind: "automation.updated",
    targetType: "automation",
    targetId: id,
    agentName: updated.agentName,
    payload: {
      via: auth.surface,
      apiKeyId: auth.apiKeyId,
      name: updated.name,
      cron: updated.cron,
      timezone: updated.timezone,
      enabled: updated.enabled,
    },
  });
  return NextResponse.json({ automation: serializeAutomation(updated) });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: RouteParams },
): Promise<NextResponse> {
  const auth = await authorizeApiRequest(request, "operator");
  if (!auth.ok) return authErrorResponse(auth);

  const { id } = await params;
  const existing = await getAutomation(id);
  if (!existing || existing.workspaceId !== auth.workspace.id) {
    return apiError(404, "automation not found");
  }
  await deleteAutomation(id);
  await writeAuditEvent({
    workspaceId: auth.workspace.id,
    actorUserId: auth.userId,
    source: "human_action",
    kind: "automation.deleted",
    targetType: "automation",
    targetId: id,
    agentName: existing.agentName,
    payload: { via: auth.surface, apiKeyId: auth.apiKeyId, name: existing.name },
  });
  return new NextResponse(null, { status: 204 });
}
