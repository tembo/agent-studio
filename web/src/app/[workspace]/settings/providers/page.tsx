import { notFound } from "next/navigation";

import { Section } from "@/components/section";
import {
  getWorkspaceBySlug,
  getWorkspaceSecretPreview,
} from "@/lib/workspace";

import { SecretKeyForm } from "../secret-key-form";

export const dynamic = "force-dynamic";

// LLM Providers: the model API keys agents *run* on. An agent's
// `model:` field (anthropic:* / openai:* / fireworks:*) selects which key the runtime
// uses. Each key is its own form so rotating one doesn't touch the
// other's preview state.
export default async function ProvidersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();

  const [anthropicPreview, openaiPreview, fireworksPreview, scaledownPreview] = await Promise.all([
    getWorkspaceSecretPreview(workspace.id, "anthropic_api_key"),
    getWorkspaceSecretPreview(workspace.id, "openai_api_key"),
    getWorkspaceSecretPreview(workspace.id, "fireworks_api_key"),
    getWorkspaceSecretPreview(workspace.id, "scaledown_api_key"),
  ]);

  return (
    <div className="divide-y divide-[var(--color-border-weak)]">
      <div className="pb-6 first:pt-0">
        <Section
          title="Anthropic API key"
          description="Required for any agent that uses an anthropic:* model."
        >
          <SecretKeyForm
            workspaceSlug={workspace.slug}
            kind="anthropic_api_key"
            label="Anthropic API key"
            placeholder="sk-ant-…"
            maskedPrefix="sk-ant-"
            preview={
              anthropicPreview
                ? {
                    last4: anthropicPreview.last4,
                    updatedAt: anthropicPreview.updatedAt.toISOString(),
                  }
                : null
            }
          />
        </Section>
      </div>

      <div className="py-6">
        <Section
          title="OpenAI API key"
          description="Required for any agent that uses an openai:* model."
        >
          <SecretKeyForm
            workspaceSlug={workspace.slug}
            kind="openai_api_key"
            label="OpenAI API key"
            placeholder="sk-…"
            maskedPrefix="sk-"
            preview={
              openaiPreview
                ? {
                    last4: openaiPreview.last4,
                    updatedAt: openaiPreview.updatedAt.toISOString(),
                  }
                : null
            }
          />
        </Section>
      </div>

      <div className="py-6">
        <Section
          title="Fireworks API key"
          description="Required for any agent that uses an fireworks:* model."
        >
          <SecretKeyForm
            workspaceSlug={workspace.slug}
            kind="fireworks_api_key"
            label="Fireworks API key"
            placeholder="Your Fireworks API key"
            maskedPrefix=""
            preview={
              fireworksPreview
                ? {
                    last4: fireworksPreview.last4,
                    updatedAt: fireworksPreview.updatedAt.toISOString(),
                  }
                : null
            }
          />
        </Section>
      </div>

      <div className="pt-6">
        <Section
          title="ScaleDown API key"
          description="Optional. Compresses bulky prompt/context through ScaleDown (scaledown.ai) to cut frontier-model tokens. Opt in per agent with scaledown: prompt | aggressive in the agent spec."
        >
          <SecretKeyForm
            workspaceSlug={workspace.slug}
            kind="scaledown_api_key"
            label="ScaleDown API key"
            placeholder="Your ScaleDown API key"
            maskedPrefix=""
            preview={
              scaledownPreview
                ? {
                    last4: scaledownPreview.last4,
                    updatedAt: scaledownPreview.updatedAt.toISOString(),
                  }
                : null
            }
          />
        </Section>
      </div>
    </div>
  );
}
