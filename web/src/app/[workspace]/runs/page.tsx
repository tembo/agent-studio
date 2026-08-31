import { notFound } from "next/navigation";

import {
  listAgentNamesWithRunsForWorkspace,
  listRunsForWorkspace,
} from "@/lib/runs-db";
import { parseRunListQuery, runListQueryKey } from "@/lib/run-list-query";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug } from "@/lib/workspace";

import { RunsList } from "./runs-list";
import { toLoaded } from "./shape";

export const dynamic = "force-dynamic";

export default async function RunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspace: slug } = await params;
  const sp = await searchParams;

  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const filters = parseRunListQuery(sp);

  // Initial render is server-side with filters already applied so
  // the first paint matches the URL. The client component takes over
  // on subsequent filter or pagination changes.
  const [initial, agentNames] = await Promise.all([
    listRunsForWorkspace(workspace.id, {
      statuses: filters.statuses.length ? filters.statuses : undefined,
      triggers: filters.triggers.length ? filters.triggers : undefined,
      agentName: filters.agentName || undefined,
      search: filters.search || undefined,
    }),
    listAgentNamesWithRunsForWorkspace(workspace.id),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Runs
        </h1>
        <p className="text-foreground-weak text-base">
          Every agent run in{" "}
          <span className="text-foreground font-medium">{workspace.name}</span>
          . Filter by status, agent, or trigger, or search by agent, run ID,
          Run as identity, input, output, or error.
        </p>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <RunsList
        key={runListQueryKey(filters)}
        workspaceSlug={slug}
        agentNames={agentNames}
        initial={initial.map(toLoaded)}
        initialFilters={{
          statuses: filters.statuses,
          triggers: filters.triggers,
          agentName: filters.agentName,
          search: filters.search,
        }}
      />
    </div>
  );
}
