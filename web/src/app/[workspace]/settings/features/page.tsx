import { notFound } from "next/navigation";

import { Section } from "@/components/section";
import { authorizeWorkspace } from "@/lib/auth-server";
import { getTextMessagesEnabled } from "@/lib/workspace-features";
import { FeaturesForm } from "./features-form";

export const dynamic = "force-dynamic";

export default async function FeaturesSettingsPage({ params }: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const auth = await authorizeWorkspace(slug);
  if (!auth.ok) notFound();
  const enabled = await getTextMessagesEnabled(auth.workspace.id);

  return (
    <Section title="Features" description="Choose which optional features appear in your workspace navigation.">
      <FeaturesForm
        workspaceSlug={auth.workspace.slug}
        enabled={enabled}
        canEdit={auth.role === "workspace_admin"}
      />
    </Section>
  );
}
