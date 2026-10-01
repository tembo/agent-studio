"use server";

import { notFound } from "next/navigation";

import {
  listRunsForWorkspace,
  type RunListFilters,
} from "@/lib/runs-db";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug, userIsMember } from "@/lib/workspace";

import { toLoaded, type LoadedRun } from "./shape";

// The opaque cursor preserves the database timestamp and ID tie-breaker.

export type LoadRunsArgs = {
  workspaceSlug: string;
  filters: {
    statuses?: RunListFilters["statuses"];
    agentName?: string;
    triggers?: RunListFilters["triggers"];
    environments?: RunListFilters["environments"];
    search?: string;
    dryRun?: boolean;
  };
  cursor?: string;
};

export async function loadRunsAction(args: LoadRunsArgs): Promise<LoadedRun[]> {
  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(args.workspaceSlug);
  if (!workspace) notFound();

  const isMember = await userIsMember(workspace.id, session.user.id);
  if (!isMember) notFound();

  const rows = await listRunsForWorkspace(workspace.id, args.filters, {
    cursor: args.cursor,
  });

  return rows.map(toLoaded);
}
