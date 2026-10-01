import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthorizeApiSuccess } from "./api-auth";
import type { ResolvedDispatch } from "./workspace-agents";
const databaseUrl = process.env.OUTPUT_REUSE_TEST_DATABASE_URL;
vi.mock("@/lib/db", async () => {
  const { Pool } = await import("pg");
  return { db: new Pool({ connectionString: process.env.OUTPUT_REUSE_TEST_DATABASE_URL }) };
});
import { db } from "./db";
import { buildOutputReuseKey } from "./output-reuse";

describe.skipIf(!databaseUrl)("output reuse authorization snapshot in PostgreSQL", () => {
  const workspace = randomUUID(), user = randomUUID(), other = randomUUID();
  const ctx = { ok: true, workspace: { id: workspace }, userId: user, role: "operator", apiKeyId: "test", surface: "api" } as AuthorizeApiSuccess;
  const dispatch: ResolvedDispatch = { agentName: "reporter", agentPath: "report.yaml", framework: "pydantic-agentspec", model: "test", specContent: "{}", specFormat: "json", versionId: "version", versionLabel: "v1", connections: [] };
  const key = () => buildOutputReuseKey(ctx, dispatch, "input", "report");
  beforeAll(async () => {
    for (const id of [user, other]) await db.query('INSERT INTO "user" (id,name,email) VALUES ($1,\'Test\',$2)', [id, `${id}@example.test`]);
    await db.query("INSERT INTO workspace (id,name,slug,created_by) VALUES ($1,'Test',$3,$2)", [workspace,user,workspace]);
    await db.query("INSERT INTO workspace_member (workspace_id,user_id,role) VALUES ($1,$2,'operator')", [workspace,user]);
  });
  afterAll(async () => {
    await db.query("DELETE FROM workspace WHERE id=$1", [workspace]);
    await db.query('DELETE FROM "user" WHERE id=ANY($1)', [[user,other]]);
    await (db as Pool).end();
  });
  it("invalidates for relevant connection changes, not another user's connections", async () => {
    const original = await key();
    const connection = randomUUID();
    await db.query("INSERT INTO workspace_composio_connection (id,workspace_id,user_id,toolkit_slug,name,composio_connection_id,auth_config_id,created_by) VALUES ($1,$2,$3,'slack','default','test','test',$3)", [connection,workspace,other]);
    expect(await key()).toBe(original);
    await db.query("UPDATE workspace_composio_connection SET user_id=$1 WHERE id=$2", [user,connection]);
    const connected = await key();
    expect(connected).not.toBe(original);
    await db.query("UPDATE workspace_composio_connection SET status='revoked',updated_at=now() WHERE id=$1", [connection]);
    expect(await key()).not.toBe(connected);
    await db.query("DELETE FROM workspace_composio_connection WHERE id=$1", [connection]);
  });
  it("invalidates membership epochs and refuses removed membership", async () => {
    const original = await key();
    await db.query("UPDATE workspace_member SET joined_at=now() + interval '1 second' WHERE workspace_id=$1 AND user_id=$2", [workspace,user]);
    expect(await key()).not.toBe(original);
    await db.query("DELETE FROM workspace_member WHERE workspace_id=$1 AND user_id=$2", [workspace,user]);
    await expect(key()).rejects.toThrow("Missing authorization snapshot");
  });
});
