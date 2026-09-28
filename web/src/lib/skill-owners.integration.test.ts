import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { schema, connectionString } = vi.hoisted(() => ({
  schema: `skill_owner_test_${Date.now()}`,
  connectionString: process.env.SKILL_OWNER_TEST_DATABASE_URL,
}));

vi.mock("@/lib/db", async () => {
  const { Pool } = await import("pg");
  return { db: new Pool({ connectionString, options: `-c search_path=${schema}` }) };
});

import { db } from "./db";
import { changeSkillOwner, listSkillOwners, recordSkillOwner, removeSkillOwner } from "./skill-owners";

describe.skipIf(!connectionString)("skill ownership in PostgreSQL", () => {
  const workspaceId = "00000000-0000-0000-0000-000000000001";
  const otherWorkspaceId = "00000000-0000-0000-0000-000000000002";

  beforeAll(async () => {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`CREATE TABLE workspace (id uuid PRIMARY KEY);
      CREATE TABLE "user" (id text PRIMARY KEY, name text, email text NOT NULL);
      CREATE TABLE workspace_member (workspace_id uuid REFERENCES workspace(id), user_id text REFERENCES "user"(id));`);
    const migration = readFileSync(new URL("../../../api/migrations/0092_skill_owner.sql", import.meta.url), "utf8");
    await db.query(migration);
    await db.query(migration);
    await db.query("INSERT INTO workspace VALUES ($1), ($2)", [workspaceId, otherWorkspaceId]);
    await db.query(`INSERT INTO "user" VALUES
      ('alice', 'Alice', 'alice@example.test'), ('bob', 'Bob', 'bob@example.test'),
      ('carol', '', 'carol@example.test'), ('outsider', 'Outside', 'outside@example.test')`);
    await db.query(`INSERT INTO workspace_member VALUES
      ($1, 'alice'), ($1, 'bob'), ($1, 'carol'), ($2, 'outsider')`, [workspaceId, otherWorkspaceId]);
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  });

  it("enforces the full ownership lifecycle and concurrent transfer permissions", async () => {
    const transfer = (actorUserId: string, ownerUserId: string, isAdmin = false, skillName = "writing") =>
      changeSkillOwner({ workspaceId, skillName, actorUserId, ownerUserId, isAdmin });

    await recordSkillOwner(workspaceId, "writing", "alice");
    await recordSkillOwner(workspaceId, "writing", "bob");
    expect((await listSkillOwners(workspaceId)).get("writing")?.userId).toBe("alice");
    expect((await listSkillOwners(otherWorkspaceId)).size).toBe(0);
    expect(await transfer("bob", "carol")).toBe(false);
    expect(await transfer("alice", "alice")).toBe(false);
    expect(await transfer("alice", "outsider")).toBe(false);
    expect(await transfer("alice", "outsider", true)).toBe(false);
    expect(await transfer("alice", "bob")).toBe(true);
    expect(await transfer("alice", "carol")).toBe(false);
    expect(await transfer("alice", "alice", true)).toBe(true);
    expect(await transfer("alice", "bob", false, "unassigned")).toBe(false);
    expect(await transfer("alice", "carol", true, "unassigned")).toBe(true);
    expect((await listSkillOwners(workspaceId)).get("unassigned")?.name).toBe("carol@example.test");

    const results = await Promise.all([transfer("alice", "bob"), transfer("alice", "carol")]);
    expect(results.filter(Boolean)).toHaveLength(1);

    await removeSkillOwner(otherWorkspaceId, "writing");
    expect((await listSkillOwners(workspaceId)).has("writing")).toBe(true);
    await removeSkillOwner(workspaceId, "writing");
    expect((await listSkillOwners(workspaceId)).has("writing")).toBe(false);
    await recordSkillOwner(workspaceId, "writing", "bob");
    expect((await listSkillOwners(workspaceId)).get("writing")?.userId).toBe("bob");
    await db.query("DELETE FROM workspace_member WHERE user_id = 'bob'");
    await db.query("DELETE FROM \"user\" WHERE id = 'bob'");
    expect((await listSkillOwners(workspaceId)).has("writing")).toBe(false);
    await recordSkillOwner(workspaceId, "writing", "alice");
    expect((await listSkillOwners(workspaceId)).get("writing")?.userId).toBe("alice");
  });
});
