import { notFound } from "next/navigation";

import { Section } from "@/components/section";
import { getPublicOrigin } from "@/lib/config";
import {
  getWorkspaceBySlug,
  getWorkspaceSecretPreview,
} from "@/lib/workspace";

import { SecretKeyForm } from "../secret-key-form";
import { DeliveryForm } from "./delivery-form";

export const dynamic = "force-dynamic";

// Composio integration: the workspace API key that authenticates Tool
// Router sessions, plus the HMAC secret used to verify inbound trigger
// webhooks. Per-user OAuth for individual toolkits happens at
// /connections, not here.
export default async function ComposioSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const [composioPreview, composioWebhookSecretPreview] = await Promise.all([
    getWorkspaceSecretPreview(workspace.id, "composio_api_key"),
    getWorkspaceSecretPreview(workspace.id, "composio_webhook_secret"),
  ]);
  const webhookUrl = `${getPublicOrigin()}/api/hooks/composio/${workspace.slug}`;

  return (
    <div className="divide-y divide-[var(--color-border-weak)]">
      <div className="pb-6 first:pt-0">
        <Section
          title="Composio API key"
          description="Enables Composio-backed connections. Per-user OAuth happens at /connections; the workspace key authenticates every Tool Router session built against this workspace's agents."
        >
          <SecretKeyForm
            workspaceSlug={workspace.slug}
            kind="composio_api_key"
            label="Composio API key"
            placeholder="ak_…"
            maskedPrefix="ak_"
            preview={
              composioPreview
                ? {
                    last4: composioPreview.last4,
                    updatedAt: composioPreview.updatedAt.toISOString(),
                  }
                : null
            }
          />
        </Section>
      </div>

      <div className="py-6">
        <Section title="Event delivery" description="Verify that Composio sends trigger events to this workspace.">
          <DeliveryForm workspaceSlug={workspace.slug} />
        </Section>
      </div>

      <div className="pt-6">
        <Section
          title="Composio webhook secret"
          description={
            <>
              HMAC secret Composio signs trigger webhooks with. Point your
              Composio app at{" "}
              <code className="bg-surface rounded px-1 py-0.5 text-sm">
                {webhookUrl}
              </code>{" "}
              and paste the secret here so TAS can verify each delivery.
            </>
          }
        >
          <SecretKeyForm
            workspaceSlug={workspace.slug}
            kind="composio_webhook_secret"
            label="Composio webhook secret"
            placeholder="Paste your Composio webhook secret"
            maskedPrefix=""
            preview={
              composioWebhookSecretPreview
                ? {
                    last4: composioWebhookSecretPreview.last4,
                    updatedAt:
                      composioWebhookSecretPreview.updatedAt.toISOString(),
                  }
                : null
            }
          />
        </Section>
      </div>
    </div>
  );
}
