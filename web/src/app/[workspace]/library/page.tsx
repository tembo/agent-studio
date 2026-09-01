import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { LibraryGallery } from "@/components/library-gallery";
import { loadAgentLibrary } from "@/lib/agent-library";
import { listConnectionsForUser } from "@/lib/composio-connections";
import { listNativeConnectionsForUser } from "@/lib/connections";
import {
  collectConnectedSlugs,
  rankLibrary,
} from "@/lib/connection-categories";
import { listSecretConnections } from "@/lib/secret-connections";
import { getServerSession } from "@/lib/session";
import { listSlackApps } from "@/lib/slack-apps";
import { getWorkspaceBySlug } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function AgentLibraryPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;

  const session = await getServerSession();
  if (!session) notFound();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  // Same per-user connection fetch the sidebar does (layout.tsx), tolerant of
  // failures — a connection-query error just means nothing ranks as "ready".
  const [composio, native, secrets, slackApps, library] = await Promise.all([
    listConnectionsForUser(workspace.id, session.user.id).catch(() => []),
    listNativeConnectionsForUser(workspace.id, session.user.id).catch(() => []),
    listSecretConnections(workspace.id, session.user.id).catch(() => []),
    listSlackApps(workspace.id).catch(() => []),
    loadAgentLibrary(),
  ]);
  const connected = collectConnectedSlugs(composio, native, secrets);
  // Slack notifications run through TAS-managed Slack apps (workspace-level), not
  // a per-user connection — so satisfy the "notify" category when an app is
  // installed. This is the single biggest readiness lever (52 starters notify).
  if (slackApps.some((a) => a.status === "installed")) connected.add("slack");
  const ranked = rankLibrary(library, connected);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-2">
        <BackLink href={`/${workspace.slug}`} label="Agents" />
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Agent library
        </h1>
        <p className="text-foreground-weak text-base">
          Ready-made starter agents. The ones you can run now — given your{" "}
          connections — come first. Pick one to pre-fill the New Agent form;
          Tembo writes the agent and opens a pull request for your review.
        </p>
      </div>

      <hr className="border-[var(--color-border-weak)]" />

      <LibraryGallery items={ranked} workspaceSlug={workspace.slug} />
    </div>
  );
}
