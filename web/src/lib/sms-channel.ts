import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { listAgentsByLabels, type ScopedAgent } from "@/lib/agent-scope";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { aadSmsSecret } from "@/lib/crypto-aad";
import { db } from "@/lib/db";

export type SmsChannel = {
  id: string;
  workspaceId: string;
  name: string;
  accountSid: string;
  hasAuthToken: boolean;
  phoneNumber: string;
  agentLabels: string[];
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

type Row = {
  id: string;
  workspace_id: string;
  name: string;
  account_sid: string;
  auth_token: Buffer;
  phone_number: string;
  agent_labels: string[];
  enabled: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

const SELECT = `id, workspace_id, name, account_sid, auth_token, phone_number,
  agent_labels, enabled, created_by, created_at, updated_at`;

function rowToChannel(row: Row): SmsChannel {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    accountSid: row.account_sid,
    hasAuthToken: row.auth_token !== null,
    phoneNumber: row.phone_number,
    agentLabels: row.agent_labels ?? [],
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSmsChannels(
  workspaceId: string,
): Promise<SmsChannel[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${SELECT} FROM workspace_sms_channel
      WHERE workspace_id = $1
      ORDER BY lower(name), created_at`,
    [workspaceId],
  );
  return rows.map(rowToChannel);
}

export async function getSmsChannel(
  workspaceId: string,
  id: string,
): Promise<SmsChannel | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${SELECT} FROM workspace_sms_channel
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return rows[0] ? rowToChannel(rows[0]) : null;
}

export async function getSmsChannelById(id: string): Promise<SmsChannel | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${SELECT} FROM workspace_sms_channel WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToChannel(rows[0]) : null;
}

export async function getSmsAuthToken(id: string): Promise<string | null> {
  const { rows } = await db.query<{ auth_token: Buffer }>(
    `SELECT auth_token FROM workspace_sms_channel WHERE id = $1`,
    [id],
  );
  return rows[0]
    ? decryptSecret(rows[0].auth_token, aadSmsSecret(id))
    : null;
}

export async function createSmsChannel(args: {
  workspaceId: string;
  name: string;
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  agentLabels: string[];
  createdBy: string;
}): Promise<SmsChannel> {
  const id = randomUUID();
  const { rows } = await db.query<Row>(
    `INSERT INTO workspace_sms_channel
       (id, workspace_id, name, account_sid, auth_token, phone_number,
        agent_labels, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${SELECT}`,
    [
      id,
      args.workspaceId,
      args.name,
      args.accountSid,
      encryptSecret(args.authToken, aadSmsSecret(id)),
      args.phoneNumber,
      args.agentLabels,
      args.createdBy,
    ],
  );
  return rowToChannel(rows[0]);
}

export async function updateSmsChannel(
  workspaceId: string,
  id: string,
  args: {
    name: string;
    accountSid: string;
    authToken?: string;
    phoneNumber: string;
    agentLabels: string[];
    enabled: boolean;
  },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE workspace_sms_channel
        SET name = $3,
            account_sid = $4,
            auth_token = COALESCE($5, auth_token),
            phone_number = $6,
            agent_labels = $7,
            enabled = $8,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [
      workspaceId,
      id,
      args.name,
      args.accountSid,
      args.authToken ? encryptSecret(args.authToken, aadSmsSecret(id)) : null,
      args.phoneNumber,
      args.agentLabels,
      args.enabled,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listAgentsForSmsChannel(
  channel: Pick<SmsChannel, "workspaceId" | "agentLabels">,
): Promise<ScopedAgent[]> {
  return listAgentsByLabels(channel.workspaceId, channel.agentLabels);
}

function hashLinkCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

export async function createSmsLinkCode(
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const code = randomBytes(8).toString("hex").toUpperCase();
  const result = await db.query(
    `INSERT INTO workspace_sms_link_code
       (workspace_id, user_id, code_hash, expires_at)
     SELECT workspace_id, user_id, $3, now() + interval '15 minutes'
       FROM workspace_member
      WHERE workspace_id = $1 AND user_id = $2
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET
       code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at,
       created_at = now()`,
    [workspaceId, userId, hashLinkCode(code)],
  );
  return (result.rowCount ?? 0) > 0 ? code : null;
}

export type LinkSmsPhoneResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid-code" | "phone-in-use" };

export async function linkSmsPhoneWithCode(
  workspaceId: string,
  code: string,
  phoneNumber: string,
): Promise<LinkSmsPhoneResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT user_id
         FROM workspace_sms_link_code
        WHERE workspace_id = $1 AND code_hash = $2 AND expires_at > now()
        FOR UPDATE`,
      [workspaceId, hashLinkCode(code)],
    );
    const userId = rows[0]?.user_id;
    if (!userId) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "invalid-code" };
    }

    await client.query(
      `UPDATE workspace_member
          SET sms_phone_number = $3
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId, phoneNumber],
    );
    await client.query(
      `DELETE FROM workspace_sms_link_code
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    await client.query("COMMIT");
    return { ok: true, userId };
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") {
      return { ok: false, reason: "phone-in-use" };
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getSmsMemberByPhone(
  workspaceId: string,
  phoneNumber: string,
): Promise<{ userId: string } | null> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT user_id
       FROM workspace_member
      WHERE workspace_id = $1 AND sms_phone_number = $2
      LIMIT 1`,
    [workspaceId, phoneNumber],
  );
  return rows[0] ? { userId: rows[0].user_id } : null;
}

export async function getSmsPhoneForMember(
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ sms_phone_number: string | null }>(
    `SELECT sms_phone_number
       FROM workspace_member
      WHERE workspace_id = $1 AND user_id = $2
      LIMIT 1`,
    [workspaceId, userId],
  );
  return rows[0]?.sms_phone_number ?? null;
}

export async function unlinkSmsPhone(
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM workspace_sms_link_code
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    const result = await client.query(
      `UPDATE workspace_member
          SET sms_phone_number = NULL
        WHERE workspace_id = $1 AND user_id = $2 AND sms_phone_number IS NOT NULL`,
      [workspaceId, userId],
    );
    await client.query("COMMIT");
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSmsChannel(
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM workspace_sms_channel WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function countRecentSmsDispatches(
  smsChannelId: string,
  recipientNumber: string,
  seconds: number,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM sms_delivery
      WHERE sms_channel_id = $1 AND recipient_number = $2
        AND created_at > now() - make_interval(secs => $3)`,
    [smsChannelId, recipientNumber, seconds],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function claimSmsEvent(
  smsChannelId: string,
  inboundSid: string,
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO sms_event_seen (sms_channel_id, inbound_sid)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [smsChannelId, inboundSid],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Records where the run result must be sent after claimSmsEvent has accepted
 * the provider event.
 */
export async function recordSmsDelivery(args: {
  runId: string;
  smsChannelId: string;
  inboundSid: string;
  recipientNumber: string;
  senderNumber: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO sms_delivery
       (run_id, sms_channel_id, inbound_sid, recipient_number, sender_number)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (run_id) DO UPDATE SET
       sms_channel_id = EXCLUDED.sms_channel_id,
       inbound_sid = EXCLUDED.inbound_sid,
       recipient_number = EXCLUDED.recipient_number,
       sender_number = EXCLUDED.sender_number`,
    [
      args.runId,
      args.smsChannelId,
      args.inboundSid,
      args.recipientNumber,
      args.senderNumber,
    ],
  );
}

export async function getSmsDeliveryForRun(
  workspaceId: string,
  runId: string,
): Promise<{ senderNumber: string; deliveredAt: Date | null; deliveryError: string | null } | null> {
  const { rows } = await db.query<{
    sender_number: string;
    delivered_at: Date | null;
    delivery_error: string | null;
  }>(
    `SELECT d.sender_number, d.delivered_at, d.delivery_error
       FROM sms_delivery d
       JOIN run r ON r.id = d.run_id
      WHERE r.workspace_id = $1 AND d.run_id = $2`,
    [workspaceId, runId],
  );
  const row = rows[0];
  return row
    ? {
        senderNumber: row.sender_number,
        deliveredAt: row.delivered_at,
        deliveryError: row.delivery_error,
      }
    : null;
}
