import "server-only";

import { Composio } from "@composio/core";
import { z } from "zod";

const API = "https://backend.composio.dev/api/v3.1/webhook_subscriptions";
const TRIGGER_EVENT = "composio.trigger.message";
const subscriptionSchema = z.object({
  id: z.string().min(1),
  webhook_url: z.string().url(),
  enabled_events: z.array(z.string()),
  secret: z.string().optional(),
});
const listSchema = z.object({
  items: z.array(subscriptionSchema),
  next_cursor: z.string().nullish(),
});
type Subscription = z.infer<typeof subscriptionSchema>;

// Only these locally authored messages are safe to return from server actions.
export class ComposioDeliveryConfigurationError extends Error {}

async function request(apiKey: string, suffix: string, init?: RequestInit) {
  const response = await fetch(`${API}${suffix}`, {
    ...init,
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  // Upstream bodies can contain credentials; never send them to the browser.
  if (!response.ok) throw new Error(`Composio webhook API returned HTTP ${response.status}.`);
  return response.json();
}

async function listSubscriptions(apiKey: string): Promise<Subscription[]> {
  const items: Subscription[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ limit: "50" });
    if (cursor) query.set("cursor", cursor);
    const result = listSchema.parse(await request(apiKey, `?${query}`));
    items.push(...result.items);
    if (!result.next_cursor) return items;
    cursor = result.next_cursor;
  }
  throw new Error("Composio returned too many webhook subscriptions to check safely.");
}

export async function checkComposioDelivery(args: {
  apiKey: string;
  webhookUrl: string;
  secret: string | null;
}): Promise<string> {
  const subscriptions = await listSubscriptions(args.apiKey);
  const matching = subscriptions.filter((s) => s.webhook_url === args.webhookUrl);
  if (!matching.length && subscriptions.length) {
    return "This Composio project delivers to a different URL. Composio allows one subscription per project. Use a separate project for this workspace or review the destination in the Composio dashboard.";
  }
  if (!matching.length) {
    return "No Composio webhook subscription points to this workspace. Configure delivery below.";
  }
  const enabled = matching.filter((s) => s.enabled_events.includes(TRIGGER_EVENT));
  if (!enabled.length) return "The workspace webhook is not subscribed to trigger events. Configure delivery below.";
  if (!args.secret) return "Composio has the workspace URL, but TAS has no signing secret. Configure delivery or copy the subscription secret from Composio.";
  if (enabled.some((s) => s.secret === args.secret)) {
    return "Composio has the workspace URL, trigger events, and a matching signing secret. This checks configuration, not successful email detection or delivery.";
  }
  if (enabled.every((s) => s.secret !== undefined)) {
    return "The saved signing secret does not match Composio. Configure delivery or copy the matching subscription secret from Composio.";
  }
  return "Composio has the workspace URL and trigger events. Composio did not return a signing secret to compare; verify it in the dashboard. Email detection and delivery are not confirmed.";
}

/** Match by URL: the SDK's setWebhookSubscription updates the FIRST project
 * subscription, which could belong to a different workspace or application. */
export async function configureComposioDelivery(apiKey: string, webhookUrl: string) {
  const url = new URL(webhookUrl);
  if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new ComposioDeliveryConfigurationError("Set BETTER_AUTH_URL to the public HTTPS address of TAS before configuring delivery.");
  }
  const subscriptions = await listSubscriptions(apiKey);
  const matching = subscriptions.filter((s) => s.webhook_url === webhookUrl);
  if (matching.length > 1) throw new ComposioDeliveryConfigurationError("Multiple subscriptions target this workspace. Remove duplicates in Composio before configuring delivery.");
  const existing = matching[0];
  if (!existing && subscriptions.length) {
    throw new ComposioDeliveryConfigurationError("This Composio project already delivers to another URL. Composio allows one subscription per project. Use a separate project for this workspace or review the destination in the Composio dashboard. The existing URL was not changed.");
  }
  if (existing?.enabled_events.includes(TRIGGER_EVENT)) return existing;
  const body = existing
    ? { enabled_events: [...existing.enabled_events, TRIGGER_EVENT] }
    : { webhook_url: webhookUrl, enabled_events: [TRIGGER_EVENT], version: "V3" };
  const saved = subscriptionSchema.parse(await request(
    apiKey,
    existing ? `/${encodeURIComponent(existing.id)}` : "",
    { method: existing ? "PATCH" : "POST", body: JSON.stringify(body) },
  ));
  return { ...saved, secret: saved.secret ?? existing?.secret };
}

export async function checkComposioTriggerInstances(apiKey: string, triggerIds: string[]) {
  if (!triggerIds.length) return [];
  const client = new Composio({ apiKey });
  const statuses = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await client.triggers.listActive({
      triggerIds, showDisabled: true, limit: 100, cursor,
    }, { signal: AbortSignal.timeout(15_000) });
    for (const item of result.items) {
      const status = item.disabledAt ? "Disabled in Composio" : "Enabled in Composio (email detection not confirmed)";
      statuses.set(item.id, status);
      if (item.uuid) statuses.set(item.uuid, status);
    }
    if (!result.nextCursor) return triggerIds.map((id) => ({
      id, status: statuses.get(id) ?? "Not found in this Composio project",
    }));
    cursor = result.nextCursor;
  }
  throw new Error("Composio returned too many trigger instances to check safely.");
}
