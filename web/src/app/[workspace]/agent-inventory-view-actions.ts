"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import {
  createAgentInventoryView,
  deleteAgentInventoryView,
  type StoredAgentInventoryView,
} from "@/lib/agent-inventory-views";
import {
  normalizeAgentInventoryFilters,
  type AgentInventoryViewVisibility,
} from "@/lib/agent-inventory-view-types";
import { authorizeWorkspace, DENIED_MESSAGE } from "@/lib/auth-server";
import { meetsMinRole } from "@/lib/rbac";

export type SaveInventoryViewResult =
  | { ok: true; view: StoredAgentInventoryView }
  | { ok: false; error: string };

export async function saveAgentInventoryViewAction(args: {
  workspaceSlug: string;
  name: string;
  visibility: AgentInventoryViewVisibility;
  filters: unknown;
}): Promise<SaveInventoryViewResult> {
  const auth = await authorizeWorkspace(args.workspaceSlug, "viewer");
  if (!auth.ok) {
    if (auth.reason === "denied") return { ok: false, error: DENIED_MESSAGE };
    notFound();
  }

  const name = args.name.trim();
  if (!name) return { ok: false, error: "Give this view a name." };
  if (name.length > 80) {
    return { ok: false, error: "View names must be 80 characters or fewer." };
  }
  if (args.visibility !== "personal" && args.visibility !== "shared") {
    return { ok: false, error: "Choose a valid view visibility." };
  }

  try {
    const view = await createAgentInventoryView({
      workspaceId: auth.workspace.id,
      userId: auth.userId,
      name,
      visibility: args.visibility,
      filters: normalizeAgentInventoryFilters(args.filters),
    });
    revalidatePath(`/${auth.workspace.slug}`);
    return { ok: true, view };
  } catch (error) {
    if (postgresCode(error) === "23505") {
      return {
        ok: false,
        error:
          args.visibility === "personal"
            ? "You already have a personal view with that name."
            : "A shared view with that name already exists.",
      };
    }
    return { ok: false, error: "Couldn’t save this view. Try again." };
  }
}

export async function deleteAgentInventoryViewAction(args: {
  workspaceSlug: string;
  viewId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await authorizeWorkspace(args.workspaceSlug, "viewer");
  if (!auth.ok) {
    if (auth.reason === "denied") return { ok: false, error: DENIED_MESSAGE };
    notFound();
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      args.viewId,
    )
  ) {
    return { ok: false, error: "That saved view is invalid." };
  }

  const deleted = await deleteAgentInventoryView({
    workspaceId: auth.workspace.id,
    userId: auth.userId,
    viewId: args.viewId,
    canManageShared: meetsMinRole(auth.role, "workspace_admin"),
  });
  if (!deleted) {
    return { ok: false, error: "You can’t delete that saved view." };
  }
  revalidatePath(`/${auth.workspace.slug}`);
  return { ok: true };
}

function postgresCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
