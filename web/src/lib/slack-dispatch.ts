import "server-only";

import { writeAuditEvent } from "@/lib/audit-db";
import { createRun } from "@/lib/runs-api";
import { getPermalink, getUserEmail } from "@/lib/slack-api";
import {
  countRecentSlackDispatches,
  listAgentsForSlackApp,
  recordSlackDelivery,
  type SlackApp,
} from "@/lib/slack-apps";
import { resolveAgentForDispatch } from "@/lib/workspace-agents";
import { listWorkspaceMembers } from "@/lib/workspace";

// Per-user guard against runaway loops (a misbehaving integration, or a
// user spamming the picker): at most this many dispatches per Slack user
// per app per minute.
const RATE_LIMIT_PER_MIN = 20;

// The explicit-routing dispatcher: turn a Slack message into a TAS run.
// "Explicit" = the agent is named (slash `/tas <agent> <input>`, or the
// picker modal's submission). Natural-language routing is Step 5.

/** Split "<agent> <input…>" — first whitespace-delimited token is the agent. */
export function parseCommand(text: string): {
  agentName: string;
  input: string;
} {
  const trimmed = text.trim();
  if (!trimmed) return { agentName: "", input: "" };
  const m = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
  if (!m) return { agentName: "", input: "" };
  return { agentName: m[1], input: m[2].trim() };
}

// The callback_id the interactivity route matches to dispatch a picker
// submission. private_metadata carries the originating channel/thread so
// the run's reply lands where the command was invoked.
export const PICKER_CALLBACK_ID = "tas_agent_picker";

// Message shortcut ("Run agent on this message") — defined in the manifest,
// handled by the interactivity route, which opens the picker prefilled with
// the message text.
export const MESSAGE_SHORTCUT_CALLBACK_ID = "tas_run_on_message";

/**
 * A modal listing the app's scoped agents (static_select) + a free-text
 * input. Opened when a slash command / mention names no (or an unknown)
 * agent, or from the message shortcut (with the message text prefilled).
 * `scoped` must be non-empty.
 */
export function buildPickerView(
  scoped: { name: string; description?: string }[],
  privateMetadata: { channel: string; threadTs: string | null },
  initialInput?: string,
): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: PICKER_CALLBACK_ID,
    private_metadata: JSON.stringify(privateMetadata),
    title: { type: "plain_text", text: "Launch an agent" },
    submit: { type: "plain_text", text: "Run" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "agent",
        label: { type: "plain_text", text: "Agent" },
        element: {
          type: "static_select",
          action_id: "agent",
          placeholder: { type: "plain_text", text: "Pick an agent" },
          options: scoped.slice(0, 100).map((a) => ({
            text: {
              type: "plain_text",
              text: a.name.slice(0, 75),
            },
            value: a.name,
          })),
        },
      },
      {
        type: "input",
        block_id: "input",
        optional: true,
        label: { type: "plain_text", text: "Input" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          multiline: true,
          ...(initialInput ? { initial_value: initialInput.slice(0, 3000) } : {}),
          placeholder: {
            type: "plain_text",
            text: "What should it do?",
          },
        },
      },
    ],
  };
}

/**
 * The bot's App Home tab: a directory of the agents this app can launch
 * plus a how-to. Published on app_home_opened. `scoped` is the app's
 * label-scoped registry.
 */
export function buildHomeView(
  appName: string,
  scoped: { name: string; description?: string }[],
): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${appName} — what I can do` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Launch an agent with `/tas <agent> <your message>`, or just *message me* and name the agent. Run `/tas` with no agent to pick from a menu.",
      },
    },
    { type: "divider" },
  ];

  if (scoped.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No agents are assigned to this bot yet._ An admin can scope it in TAS → Settings → Slack apps: give the bot a label, then add a matching `labels:` line to an agent.",
      },
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Agents I can launch (${scoped.length})*`,
      },
    });
    // Slack caps a view at 100 blocks; each agent is one section. Leave
    // headroom for the preamble — 50 agents is far more than any bot's
    // realistic scope.
    for (const a of scoped.slice(0, 50)) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: a.description
            ? `• \`${a.name}\` — ${a.description}`
            : `• \`${a.name}\``,
        },
      });
    }
    if (scoped.length > 50) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `…and ${scoped.length - 50} more.`,
          },
        ],
      });
    }
  }

  return { type: "home", blocks };
}

export type DispatchResult =
  | {
      ok: true;
      runId: string;
      agentName: string;
      /** Human label for who the run acts as, for the ack message. */
      actingAs: string;
    }
  | {
      ok: false;
      reason:
        | "no-agent"
        | "unknown-agent"
        | "agent-invalid"
        | "rate-limited"
        | "error";
      message: string;
    };

/**
 * Resolve the Slack user to a TAS member by verified email, falling back
 * to the app's default owner. Returns the user id to run as plus a label.
 */
async function resolveActingUser(
  app: SlackApp,
  botToken: string,
  slackUserId: string,
): Promise<{ userId: string; label: string }> {
  const email = await getUserEmail(botToken, slackUserId);
  if (email) {
    const members = await listWorkspaceMembers(app.workspaceId);
    const match = members.find(
      (m) => m.email.toLowerCase() === email.toLowerCase(),
    );
    if (match) {
      return { userId: match.userId, label: match.name ?? match.email };
    }
  }
  return { userId: app.defaultOwnerUserId, label: "the app's default owner" };
}

/**
 * Dispatch an explicit `<agent> <input>` to a run. Validates the agent is
 * in the app's label scope, resolves the acting user, enqueues the run
 * (trigger=event), and records where to post the result.
 */
export async function dispatchToAgent(args: {
  app: SlackApp;
  botToken: string;
  slackUserId: string;
  text: string;
  channel: string;
  threadTs: string | null;
}): Promise<DispatchResult> {
  const { app, botToken, slackUserId, text, channel, threadTs } = args;
  const { agentName, input } = parseCommand(text);
  if (!agentName) {
    return { ok: false, reason: "no-agent", message: "No agent named." };
  }

  // Rate limit per Slack user, before any GitHub work — blunts runaway
  // loops and spam.
  const recent = await countRecentSlackDispatches(app.id, slackUserId, 60);
  if (recent >= RATE_LIMIT_PER_MIN) {
    return {
      ok: false,
      reason: "rate-limited",
      message:
        "You're launching agents very quickly — give the last few a moment to finish, then try again.",
    };
  }

  // Scope gate: only agents whose labels intersect this app's labels.
  const scoped = await listAgentsForSlackApp(app);
  const inScope = scoped.find((a) => a.name === agentName);
  if (!inScope) {
    return {
      ok: false,
      reason: "unknown-agent",
      message: `"${agentName}" isn't an agent this bot can launch.`,
    };
  }

  // Slack runs the agent's current stable version (no draft opt-in here).
  const dispatch = await resolveAgentForDispatch(app.workspaceId, agentName);
  if (!dispatch.ok) {
    return {
      ok: false,
      reason: "agent-invalid",
      message: `"${agentName}" couldn't be loaded: ${dispatch.error.message}`,
    };
  }
  const r = dispatch.resolved;

  const acting = await resolveActingUser(app, botToken, slackUserId);

  try {
    const { runId } = await createRun({
      workspaceId: app.workspaceId,
      userId: acting.userId,
      agentName: r.agentName,
      agentPath: r.agentPath,
      model: r.model,
      userMessage: input,
      framework: r.framework,
      specContent: r.specContent,
      specFormat: r.specFormat,
      toolsModuleContent: r.toolsModuleContent,
      skillsContent: r.skillsContent,
      trigger: "event",
      agentVersionId: r.versionId,
      agentVersionLabel: r.versionLabel,
      delivery: r.delivery,
    });
    // Deep-link target for the runs UI: the conversation that kicked this
    // off. Best-effort — a missing permalink just means no link in the UI.
    const permalink = threadTs
      ? await getPermalink(botToken, channel, threadTs)
      : null;
    await recordSlackDelivery({
      runId,
      slackAppId: app.id,
      channel,
      threadTs,
      slackUserId,
      permalink,
    });
    // Provenance: who launched what, via which bot. Best-effort — the run
    // already exists, so an audit hiccup must not fail the dispatch.
    try {
      await writeAuditEvent({
        workspaceId: app.workspaceId,
        actorUserId: acting.userId,
        source: "dashboard_event",
        kind: "slack.dispatch",
        targetType: "run",
        targetId: runId,
        agentName: r.agentName,
        payload: {
          slackAppId: app.id,
          slackAppName: app.name,
          slackUserId,
          channel,
        },
      });
    } catch {
      // swallow — provenance is nice-to-have, not load-bearing
    }
    return { ok: true, runId, agentName: r.agentName, actingAs: acting.label };
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      message: e instanceof Error ? e.message : "Failed to start the run.",
    };
  }
}
