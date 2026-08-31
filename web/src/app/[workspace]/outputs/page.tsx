import { notFound } from "next/navigation";

import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug, getWorkspaceRole } from "@/lib/workspace";

import { OutputsView, type OutputsSearchParams } from "./outputs-view";

export const dynamic = "force-dynamic";

export default async function OutputsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<OutputsSearchParams>;
}) {
  const [{ workspace: slug }, sp, session] = await Promise.all([
    params,
    searchParams,
    getServerSession(),
  ]);
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const role = await getWorkspaceRole(workspace.id, session.user.id);
  if (!role) notFound();

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Outputs
        </h1>
        <p className="text-foreground-weak text-base">
          Search completed reports and results in{" "}
          <span className="text-foreground font-medium">{workspace.name}</span>,
          including outputs produced by sub-agents.
        </p>
      </div>

      <OutputsView
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        baseHref={`/${workspace.slug}/outputs`}
        searchParams={sp}
      />
    </div>
  );
}
