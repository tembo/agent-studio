import "server-only";

import { randomUUID } from "node:crypto";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { aadSmsSecret } from "@/lib/crypto-aad";
import { db } from "@/lib/db";

export type SmsChannel = {
  id: string;
  workspaceId: string;
  accountSid: string;
  hasAuthToken: boolean;
  phoneNumber: string;
  allowedNumbers: string[];
  agentName: string;
  defaultOwnerUserId: string;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

type Row = {
  id: string;
  workspace_id: string;
  account_sid: string;
  auth_token: Buffer;
  phone_number: string;
  allowed_numbers: string[];
  agent_name: string;
  default_owner_user_id: string;
  enabled: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

const SELECT = `id, workspace_id, account_sid, auth_token, phone_number, allowed_numbers,
  agent_name, default_owner_user_id, enabled, created_by, created_at, updated_at`;

function rowToChannel(row: Row): SmsChannel {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    accountSid: row.account_sid,
    hasAuthToken: row.auth_token !== null,
    phoneNumber: row.phone_number,
    allowedNumbers: row.allowed_numbers ?? [],
    agentName: row.agent_name,
    defaultOwnerUserId: row.default_owner_user_id,
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSmsChannel(
  workspaceId: string,
): Promise<SmsChannel | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${SELECT} FROM workspace_sms_channel WHERE workspace_id = $1`,
    [workspaceId],
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
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  allowedNumbers: string[];
  agentName: string;
  defaultOwnerUserId: string;
  createdBy: string;
}): Promise<SmsChannel> {
  const id = randomUUID();
  const { rows } = await db.query<Row>(
    `INSERT INTO workspace_sms_channel
       (id, workspace_id, account_sid, auth_token, phone_number, allowed_numbers,
        agent_name, default_owner_user_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${SELECT}`,
    [
      id,
      args.workspaceId,
      args.accountSid,
      encryptSecret(args.authToken, aadSmsSecret(id)),
      args.phoneNumber,
      args.allowedNumbers,
      args.agentName,
      args.defaultOwnerUserId,
      args.createdBy,
    ],
  );
  return rowToChannel(rows[0]);
}

export async function updateSmsChannel(
  workspaceId: string,
  id: string,
  args: {
    accountSid: string;
    authToken?: string;
    phoneNumber: string;
    allowedNumbers: string[];
    agentName: string;
    defaultOwnerUserId: string;
    enabled: boolean;
  },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE workspace_sms_channel
        SET account_sid = $3,
            auth_token = COALESCE($4, auth_token),
            phone_number = $5,
            allowed_numbers = $6,
            agent_name = $7,
            default_owner_user_id = $8,
            enabled = $9,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [
      workspaceId,
      id,
      args.accountSid,
      args.authToken ? encryptSecret(args.authToken, aadSmsSecret(id)) : null,
      args.phoneNumber,
      args.allowedNumbers,
      args.agentName,
      args.defaultOwnerUserId,
      args.enabled,
    ],
  );
  return (result.rowCount ?? 0) > 0;
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
