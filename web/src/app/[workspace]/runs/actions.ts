"use server";

import { notFound } from "next/navigation";

import {
  listRunsForWorkspace,
  type RunListFilters,
} from "@/lib/runs-db";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug, userIsMember } from "@/lib/workspace";

import { toLoaded, type LoadedRun } from "./shape";

// Fetch a page of runs for the workspace given filters + a cursor.
// The cursor is the createdAt of the last loaded row, sent as an ISO
// string from the client; we coerce back to Date here. Client uses
// this for "Load more" — initial render is server-side from
// /<workspace>/runs/page.tsx so the first paint isn't a spinner.

export type LoadRunsArgs = {
  workspaceSlug: string;
  filters: {
    statuses?: RunListFilters["statuses"];
    agentName?: string;
    triggers?: RunListFilters["triggers"];
    environments?: RunListFilters["environments"];
    search?: string;
  };
  beforeIso?: string;
};

export async function loadRunsAction(args: LoadRunsArgs): Promise<LoadedRun[]> {
  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(args.workspaceSlug);
  if (!workspace) notFound();

  const isMember = await userIsMember(workspace.id, session.user.id);
  if (!isMember) notFound();

  const rows = await listRunsForWorkspace(workspace.id, args.filters, {
    before: args.beforeIso ? new Date(args.beforeIso) : undefined,
  });

  return rows.map(toLoaded);
}
