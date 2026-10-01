import { notFound } from "next/navigation";

import { improvementSubmitterLabel } from "@/lib/improvement-display";
import { scanImprovementsForPRs } from "@/lib/improvement-scan";
import { listImprovements, listOpenImprovements } from "@/lib/improvements-api";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug } from "@/lib/workspace";

import { ImprovementsTable, type ImprovementRow } from "./improvements-table";

export const dynamic = "force-dynamic";

export default async function ImprovementsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;

  const session = await getServerSession();
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  // Scan open rows for PR updates before reading the full list, so merged-but-
  // undetected PRs show fresh status.
  const open = await listOpenImprovements(workspace.id);
  await scanImprovementsForPRs(workspace.id, open);
  const improvements = await listImprovements(workspace.id);

  const rows: ImprovementRow[] = improvements.map((i) => {
    const agentHref = `/${workspace.slug}/agents/${encodeURIComponent(i.agentName)}`;
    return {
      id: i.id,
      agentName: i.agentName,
      text: i.improvementText,
      submitter: improvementSubmitterLabel(i),
      status: i.status,
      source: i.source,
      createdAtIso: i.createdAt.toISOString(),
      agentHref,
      runHref: i.runId ? `${agentHref}/runs/${i.runId}` : null,
      temboTaskHtmlUrl: i.temboTaskHtmlUrl,
      prUrl: i.prUrl,
      prNumber: i.prNumber,
      commitUrl: i.commitUrl,
    };
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Improvements
        </h1>
        <p className="text-foreground-weak text-base">
          Track agent creation, chat-to-edit, and run improvement requests.
          Select &ldquo;View full request&rdquo; to read or copy the original
          submission, even if the agent hasn&apos;t been created yet.
          Status updates as the Tembo task
          opens a PR and it&apos;s merged — or, in YOLO mode, as the change is
          committed straight to the default branch.
        </p>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      {rows.length === 0 ? (
        <p className="text-foreground-weak text-base">
          No improvements yet. Open a run, scroll to{" "}
          <em>Improve the Agent</em>, and submit one to start.
        </p>
      ) : (
        <ImprovementsTable rows={rows} />
      )}
    </div>
  );
}
