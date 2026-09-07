import { notFound } from "next/navigation";

import { Section } from "@/components/section";
import { getWorkspaceBySlug } from "@/lib/workspace";

import { RenameWorkspaceForm } from "../rename-workspace-form";
import { MemorySection } from "../memory-section";

export const dynamic = "force-dynamic";

// General: the workspace's name + URL. Renaming re-derives the slug; the old
// slug is kept as a redirect so existing links and bookmarks survive.
export default async function GeneralSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  return (
    <div className="divide-y divide-[var(--color-border-weak)]">
      <div className="pb-6 first:pt-0">
        <Section
          title="Name & URL"
          description="The workspace's display name. The URL slug follows the name — when it changes, the old URL keeps redirecting here, so existing links don't break."
        >
          <RenameWorkspaceForm
            workspaceSlug={workspace.slug}
            workspaceName={workspace.name}
          />
        </Section>
      </div>
      <div className="py-6"><MemorySection workspaceId={workspace.id} slug={workspace.slug} /></div>
    </div>
  );
}
