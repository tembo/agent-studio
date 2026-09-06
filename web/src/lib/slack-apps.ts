import "server-only";

import { randomUUID } from "node:crypto";

import { listAgentsByLabels, type ScopedAgent } from "@/lib/agent-scope";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { aadSlackSecret } from "@/lib/crypto-aad";
import { db } from "@/lib/db";

// Data access for TAS-managed Slack apps (workspace_slack_app). One row
// per Slack app TAS owns for a workspace — its identity, install, and the
// agent labels it may launch. Credentials are AES-256-GCM blobs (see
// crypto.ts) and never leave the server; the client-facing SlackApp type
// exposes only "is it set?" booleans.

export type SlackAppStatus = "configuring" | "installed" | "disabled";

export type SlackApp = {
  id: string;
  workspaceId: string;
  name: string;
  slackAppId: string | null;
  hasSigningSecret: boolean;
  clientId: string | null;
  hasClientSecret: boolean;
  hasBotToken: boolean;
  teamId: string | null;
  botUserId: string | null;
  defaultOwnerUserId: string;
  agentLabels: string[];
  status: SlackAppStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

type Row = {
  id: string;
  workspace_id: string;
  name: string;
  slack_app_id: string | null;
  signing_secret: Buffer | null;
  client_id: string | null;
  client_secret: Buffer | null;
  bot_token: Buffer | null;
  team_id: string | null;
  bot_user_id: string | null;
  default_owner_user_id: string;
  agent_labels: string[];
  status: SlackAppStatus;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

const SELECT = `id, workspace_id, name, slack_app_id, signing_secret, client_id,
  client_secret, bot_token, team_id, bot_user_id, default_owner_user_id,
  agent_labels, status, created_by, created_at, updated_at`;

function rowToApp(r: Row): SlackApp {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    slackAppId: r.slack_app_id,
    hasSigningSecret: r.signing_secret !== null,
    clientId: r.client_id,
    hasClientSecret: r.client_secret !== null,
    hasBotToken: r.bot_token !== null,
    teamId: r.team_id,
    botUserId: r.bot_user_id,
    defaultOwnerUserId: r.default_owner_user_id,
    agentLabels: r.agent_labels ?? [],
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listSlackApps(workspaceId: string): Promise<SlackApp[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${SELECT} FROM workspace_slack_app
      WHERE workspace_id = $1 ORDER BY lower(name) ASC`,
    [workspaceId],
  );
  return rows.map(rowToApp);
}

export async function getSlackApp(
  workspaceId: string,
  id: string,
): Promise<SlackApp | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${SELECT} FROM workspace_slack_app
      WHERE workspace_id = $1 AND id = $2 LIMIT 1`,
    [workspaceId, id],
  );
  return rows[0] ? rowToApp(rows[0]) : null;
}

/** Inbound routes only carry our app id (path param), not the workspace. */
export async function getSlackAppById(id: string): Promise<SlackApp | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${SELECT} FROM workspace_slack_app WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ? rowToApp(rows[0]) : null;
}

export type CreateSlackAppInput = {
  name: string;
  defaultOwnerUserId: string;
  agentLabels: string[];
  slackAppId?: string | null;
  signingSecret?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
};

export async function createSlackApp(
  workspaceId: string,
  input: CreateSlackAppInput,
  createdBy: string,
): Promise<SlackApp> {
  // Generate the row id up front so the secret AAD can bind to it at encrypt
  // time (it isn't known until after INSERT otherwise).
  const id = randomUUID();
  const { rows } = await db.query<Row>(
    `INSERT INTO workspace_slack_app
       (id, workspace_id, name, slack_app_id, signing_secret, client_id,
        client_secret, default_owner_user_id, agent_labels, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${SELECT}`,
    [
      id,
      workspaceId,
      input.name,
      input.slackAppId ?? null,
      input.signingSecret
        ? encryptSecret(input.signingSecret, aadSlackSecret(id, "signing_secret"))
        : null,
      input.clientId ?? null,
      input.clientSecret
        ? encryptSecret(input.clientSecret, aadSlackSecret(id, "client_secret"))
        : null,
      input.defaultOwnerUserId,
      input.agentLabels,
      createdBy,
    ],
  );
  return rowToApp(rows[0]);
}

export type UpdateSlackAppInput = {
  name?: string;
  defaultOwnerUserId?: string;
  agentLabels?: string[];
  slackAppId?: string | null;
  clientId?: string | null;
  // Secrets: only written when a non-empty string is supplied (so leaving
  // the field blank in the form keeps the existing value).
  signingSecret?: string;
  clientSecret?: string;
};

export async function updateSlackApp(
  workspaceId: string,
  id: string,
  input: UpdateSlackAppInput,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (input.name !== undefined) set("name", input.name);
  if (input.defaultOwnerUserId !== undefined)
    set("default_owner_user_id", input.defaultOwnerUserId);
  if (input.agentLabels !== undefined) set("agent_labels", input.agentLabels);
  if (input.slackAppId !== undefined) set("slack_app_id", input.slackAppId);
  if (input.clientId !== undefined) set("client_id", input.clientId);
  if (input.signingSecret)
    set(
      "signing_secret",
      encryptSecret(input.signingSecret, aadSlackSecret(id, "signing_secret")),
    );
  if (input.clientSecret)
    set(
      "client_secret",
      encryptSecret(input.clientSecret, aadSlackSecret(id, "client_secret")),
    );
  if (sets.length === 0) return;
  sets.push("updated_at = now()");
  params.push(workspaceId);
  const wsIdx = params.length;
  params.push(id);
  const idIdx = params.length;
  await db.query(
    `UPDATE workspace_slack_app SET ${sets.join(", ")}
      WHERE workspace_id = $${wsIdx} AND id = $${idIdx}`,
    params,
  );
}

export async function deleteSlackApp(
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const res = await db.query(
    `DELETE FROM workspace_slack_app WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return (res.rowCount ?? 0) > 0;
}

// Server-only: decrypt credentials for inbound verification, the OAuth
// install, and posting replies back to Slack. Never serialize to a client.
export type SlackAppSecrets = {
  signingSecret: string | null;
  clientSecret: string | null;
  botToken: string | null;
};

export async function getSlackAppSecrets(
  id: string,
): Promise<SlackAppSecrets | null> {
  const { rows } = await db.query<{
    signing_secret: Buffer | null;
    client_secret: Buffer | null;
    bot_token: Buffer | null;
  }>(
    `SELECT signing_secret, client_secret, bot_token
       FROM workspace_slack_app WHERE id = $1 LIMIT 1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    signingSecret: r.signing_secret
      ? decryptSecret(r.signing_secret, aadSlackSecret(id, "signing_secret"))
      : null,
    clientSecret: r.client_secret
      ? decryptSecret(r.client_secret, aadSlackSecret(id, "client_secret"))
      : null,
    botToken: r.bot_token
      ? decryptSecret(r.bot_token, aadSlackSecret(id, "bot_token"))
      : null,
  };
}

/**
 * Valid agents in the app's workspace whose labels intersect the app's
 * scope — the registry its slash command, picker, and App Home expose.
 * An app with no labels exposes nothing (agents must be opted in via a
 * matching label), so a new bot can't accidentally launch everything.
 */
export async function listAgentsForSlackApp(
  app: Pick<SlackApp, "workspaceId" | "agentLabels">,
): Promise<ScopedAgent[]> {
  return listAgentsByLabels(app.workspaceId, app.agentLabels);
}

/**
 * Record where a Slack-dispatched run's result should be posted. The api
 * runner reads this on completion (decrypts the app's bot token, posts to
 * channel/thread). 1:1 with the run — re-dispatch of the same run id just
 * updates the target.
 */
export async function recordSlackDelivery(args: {
  runId: string;
  slackAppId: string;
  channel: string;
  threadTs: string | null;
  slackUserId: string | null;
  permalink: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO slack_delivery (run_id, slack_app_id, channel, thread_ts, slack_user_id, permalink)
       VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (run_id) DO UPDATE
       SET slack_app_id = EXCLUDED.slack_app_id,
           channel = EXCLUDED.channel,
           thread_ts = EXCLUDED.thread_ts,
           slack_user_id = EXCLUDED.slack_user_id,
           permalink = EXCLUDED.permalink`,
    [
      args.runId,
      args.slackAppId,
      args.channel,
      args.threadTs,
      args.slackUserId,
      args.permalink,
    ],
  );
}

/**
 * Replay guard. Records that we've handled this Slack event envelope id;
 * returns true if it's the first time (proceed) and false if we've already
 * seen it (a Slack retry — skip to avoid a duplicate dispatch).
 */
export async function claimSlackEvent(
  slackAppId: string,
  eventId: string,
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO slack_event_seen (slack_app_id, event_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [slackAppId, eventId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Count this Slack user's dispatches for an app within the last N seconds. */
export async function countRecentSlackDispatches(
  slackAppId: string,
  slackUserId: string,
  seconds: number,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM slack_delivery
      WHERE slack_app_id = $1 AND slack_user_id = $2
        AND created_at > now() - make_interval(secs => $3)`,
    [slackAppId, slackUserId, seconds],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Called by the OAuth callback once the app is installed into Slack. */
export async function setSlackAppInstall(
  id: string,
  args: {
    botToken: string;
    teamId: string;
    botUserId: string;
    slackAppId?: string | null;
  },
): Promise<void> {
  await db.query(
    `UPDATE workspace_slack_app
        SET bot_token = $2, team_id = $3, bot_user_id = $4,
            slack_app_id = COALESCE($5, slack_app_id),
            status = 'installed', updated_at = now()
      WHERE id = $1`,
    [
      id,
      encryptSecret(args.botToken, aadSlackSecret(id, "bot_token")),
      args.teamId,
      args.botUserId,
      args.slackAppId ?? null,
    ],
  );
}
