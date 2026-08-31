import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { LocalTime } from "@/components/local-time";
import { Section } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { getAgentVersion } from "@/lib/agent-versions";
import { getServerSession } from "@/lib/session";
import { diffLines } from "@/lib/text-diff";
import {
  getWorkspaceBySlug,
  getWorkspaceRole,
  listWorkspaceMembers,
} from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function AgentVersionPage({
  params,
}: {
  params: Promise<{ workspace: string; agent: string; version: string }>;
}) {
  const { workspace: slug, agent: agentName, version } = await params;
  const versionNumber = Number(version);

  const session = await getServerSession();
  if (!session) notFound();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const role = await getWorkspaceRole(workspace.id, session.user.id);
  if (!role) notFound();

  if (!Number.isInteger(versionNumber) || versionNumber < 1) notFound();

  const [current, previous, members] = await Promise.all([
    getAgentVersion(workspace.id, agentName, versionNumber),
    getAgentVersion(workspace.id, agentName, versionNumber - 1),
    listWorkspaceMembers(workspace.id),
  ]);
  if (!current) notFound();

  const createdByName = (() => {
    const m = members.find((x) => x.userId === current.createdBy);
    return m ? (m.name ?? m.email) : "unknown";
  })();

  const diff = previous
    ? diffLines(previous.specContent, current.specContent)
    : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink
          href={`/${slug}/agents/${encodeURIComponent(agentName)}`}
          label={agentName}
        />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
            {agentName} · v{current.versionNumber}
          </h1>
          <Badge variant="green" size="small">
            {current.stage}
          </Badge>
        </div>
        <p className="text-foreground-muted text-sm">
          Promoted by {createdByName} ·{" "}
          <LocalTime iso={current.createdAt.toISOString()} style="relative" />
        </p>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <Section title="What changed" description={undefined}>
        <div className="text-foreground whitespace-pre-wrap text-sm">
          {current.changeSummary ?? "No summary recorded."}
        </div>
      </Section>

      {diff && (
        <Section
          title="Diff"
          description={`Compared to v${current.versionNumber - 1} (+${diff.stats.added} −${diff.stats.removed}).`}
        >
          <pre className="bg-surface border-border overflow-x-auto rounded-lg border p-3 font-mono text-xs leading-5">
            {diff.lines.map((l, i) => (
              <div
                key={i}
                className={
                  l.type === "add"
                    ? "text-sentiment-positive"
                    : l.type === "remove"
                      ? "text-sentiment-negative"
                      : "text-foreground-muted"
                }
              >
                {l.type === "add" ? "+ " : l.type === "remove" ? "- " : "  "}
                {l.text}
              </div>
            ))}
          </pre>
        </Section>
      )}

      <Section
        title="Full definition"
        description={`The frozen ${current.specFormat.toUpperCase()} for v${current.versionNumber} · ${countLines(current.specContent)} lines. Expand to view the source.`}
        collapsible
      >
        <pre className="bg-surface border-border text-foreground overflow-x-auto rounded-lg border p-4 font-mono text-sm leading-5">
          {current.specContent}
        </pre>
      </Section>
    </div>
  );
}

function countLines(source: string): number {
  const content = source.trimEnd();
  return content ? content.split(/\r\n|\r|\n/).length : 0;
}
