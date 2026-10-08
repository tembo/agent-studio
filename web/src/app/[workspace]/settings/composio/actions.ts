"use server";

import { revalidatePath } from "next/cache";
import { authorizeWorkspace, DENIED_MESSAGE } from "@/lib/auth-server";
import { writeAuditEvent } from "@/lib/audit-db";
import { getPublicOrigin } from "@/lib/config";
import { ComposioDeliveryConfigurationError, checkComposioDelivery, checkComposioTriggerInstances, configureComposioDelivery } from "@/lib/composio-delivery";
import { listTriggersForWorkspace } from "@/lib/triggers-db";
import { getWorkspaceSecretPlaintext, getWorkspaceSecretPreview, setWorkspaceSecret } from "@/lib/workspace-secrets";

export type DeliveryState = {
  message?: string;
  error?: string;
  triggers?: Array<{ id: string; agent: string; status: string }>;
};

export async function composioDeliveryAction(_previous: DeliveryState, form: FormData): Promise<DeliveryState> {
  const auth = await authorizeWorkspace(String(form.get("workspace") ?? ""), "workspace_admin");
  if (!auth.ok) return { error: DENIED_MESSAGE };
  const { workspace, userId } = auth;
  if (!(await getWorkspaceSecretPreview(workspace.id, "composio_api_key"))) {
    return { error: "Save a Composio API key first." };
  }
  const webhookUrl = `${getPublicOrigin()}/api/hooks/composio/${workspace.slug}`;
  const apiKey = await getWorkspaceSecretPlaintext(workspace.id, "composio_api_key");
  if (form.get("intent") === "configure") {
    try {
      const subscription = await configureComposioDelivery(apiKey, webhookUrl);
      if (!subscription.secret) {
        return { error: "The webhook URL is registered, but Composio did not return its signing secret. Copy that subscription's secret from the Composio dashboard into TAS, then check delivery again." };
      }
      const saved = await setWorkspaceSecret(workspace.id, "composio_webhook_secret", subscription.secret);
      if (!saved.ok) return { error: "The webhook URL is registered, but its signing secret could not be saved. Copy the subscription secret from Composio into TAS." };
      await writeAuditEvent({
        workspaceId: workspace.id, actorUserId: userId, source: "human_action",
        kind: "composio.webhook_configured", targetType: "workspace", targetId: workspace.id,
        agentName: null, payload: { subscriptionId: subscription.id, webhookUrl },
      });
      revalidatePath(`/${workspace.slug}/settings/composio`);
      return { message: "Composio delivery configured and signing secret saved. Send a new matching event, then check the agent's dispatch history." };
    } catch (error) {
      if (error instanceof ComposioDeliveryConfigurationError) return { error: error.message };
      return { error: "Could not configure Composio delivery. Check the API key, public HTTPS BETTER_AUTH_URL, and webhook subscriptions in the Composio dashboard, then retry. Other subscription URLs are never changed." };
    }
  }
  try {
    const secret = await getWorkspaceSecretPreview(workspace.id, "composio_webhook_secret")
      ? await getWorkspaceSecretPlaintext(workspace.id, "composio_webhook_secret") : null;
    const triggers = await listTriggersForWorkspace(workspace.id);
    const [delivery, remote] = await Promise.allSettled([
      checkComposioDelivery({ apiKey, webhookUrl, secret }),
      checkComposioTriggerInstances(apiKey, triggers.map((t) => t.composioTriggerId)),
    ]);
    return {
      message: delivery.status === "fulfilled" ? delivery.value : "Could not check webhook subscriptions. Verify delivery in the Composio dashboard or retry.",
      triggers: triggers.map((t, i) => ({
        id: t.composioTriggerId, agent: t.agentName,
        status: `${t.enabled ? "Enabled" : "Disabled"} in TAS; ${remote.status === "fulfilled" ? remote.value[i].status : "Remote status unavailable; retry or check Composio"}`,
      })),
    };
  } catch {
    return { error: "Could not check Composio delivery. Check the API key and Composio availability, then retry. No configuration was changed." };
  }
}
