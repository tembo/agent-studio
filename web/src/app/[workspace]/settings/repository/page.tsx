import Link from "next/link";
import { notFound } from "next/navigation";

import { LocalTime } from "@/components/local-time";
import { Section } from "@/components/section";
import { getGuidanceRefreshSettings } from "@/lib/guidance-refresh";
import {
  getWorkspaceBySlug,
  getWorkspaceRepo,
} from "@/lib/workspace";

import { DisconnectRepoForm } from "../disconnect-repo-form";
import { SyncGuidanceForm } from "../sync-guidance-form";

export const dynamic = "force-dynamic";

// Repository: the workspace's GitHub connection + the agent-guidance
// refresh (both are direct repo writes via the GitHub token — no Tembo
// needed). Improvements-delivery lives on the Tembo Coding Agent tab
// since it governs how the coding agent's PRs land.

export default async function RepositoryPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const [repo, guidanceRefresh] = await Promise.all([
    getWorkspaceRepo(workspace.id),
    getGuidanceRefreshSettings(workspace.id),
  ]);

  return (
    <div className="divide-y divide-[var(--color-border-weak)]">
      <div className="pb-6 first:pt-0">
        <Section
          title="GitHub repository"
          description="The repo where this workspace's agent definitions live. Disconnecting drops the stored token and returns the workspace to the onboarding repo step."
        >
          {repo ? (
            <div className="bg-surface border-border flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <div className="flex flex-col">
                <a
                  href={`https://github.com/${repo.owner}/${repo.name}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-foreground text-sm font-medium hover:underline"
                >
                  github.com/{repo.owner}/{repo.name}
                </a>
                <span className="text-foreground-muted text-sm">
                  Default branch {repo.defaultBranch} · connected{" "}
                  <LocalTime iso={repo.connectedAt.toISOString()} />
                </span>
              </div>
              <DisconnectRepoForm workspaceSlug={workspace.slug} />
            </div>
          ) : (
            <p className="text-foreground-weak text-base">
              No repository connected.{" "}
              <Link
                href={`/onboarding/repo?ws=${encodeURIComponent(workspace.slug)}`}
                className="text-foreground hover:underline"
              >
                Connect one now →
              </Link>
            </p>
          )}
        </Section>
      </div>

      {repo && (
        <div className="pt-6">
          <Section
            title="Agent guidance"
            description="Writes (or refreshes) AGENTS.md and the per-framework AGENT_GUIDE.md files into the connected repo. These tell the Tembo Coding Agent how to write valid agent files. Safe to click repeatedly — it only commits when the files are missing or out of date."
          >
            <SyncGuidanceForm
              key={guidanceRefresh.cadence}
              workspaceSlug={workspace.slug}
              cadence={guidanceRefresh.cadence}
              refreshedAtIso={
                guidanceRefresh.refreshedAt?.toISOString() ?? null
              }
            />
          </Section>
        </div>
      )}
    </div>
  );
}
