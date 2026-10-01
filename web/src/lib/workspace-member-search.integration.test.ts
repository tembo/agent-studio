import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { schema, connectionString } = vi.hoisted(() => ({
  schema: `member_search_${Date.now()}`,
  connectionString: process.env.RUN_NAVIGATION_TEST_DATABASE_URL,
}));
vi.mock("@/lib/db", async () => {
  const { Pool } = await import("pg");
  return { db: new Pool({ connectionString, options: `-c search_path=${schema}` }) };
});
import { db } from "./db";
import { getWorkspaceMemberChoice, searchWorkspaceMembers } from "./workspace-member-search";

describe.skipIf(!connectionString)("bounded workspace member lookup", () => {
  beforeAll(async () => {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`
      CREATE TABLE "user" (id text PRIMARY KEY, name text, email text UNIQUE);
      CREATE TABLE workspace_member (workspace_id text, user_id text REFERENCES "user"(id), PRIMARY KEY(workspace_id, user_id));
      INSERT INTO "user" SELECT 'user-' || i, 'Same name', 'member-' || lpad(i::text, 5, '0') || '@example.com'
        FROM generate_series(1, 10000) i;
      INSERT INTO workspace_member SELECT 'acme', id FROM "user";
      INSERT INTO "user" VALUES ('outsider', 'Outside', 'outsider@example.com'), ('literal', null, '50%_off@example.com');
      INSERT INTO workspace_member VALUES ('other', 'outsider'), ('acme', 'literal');
      ANALYZE;
    `);
  });
  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  });
  it("returns only 25 choices from 10,001 members with a narrowing hint", async () => {
    const result = await searchWorkspaceMembers("acme", "");
    expect(result.members).toHaveLength(25);
    expect(result.hasMore).toBe(true);
    expect(result.members.some((m) => m.id === "outsider")).toBe(false);
  });
  it("finds a member beyond the first page by exact email or ID", async () => {
    for (const query of ["member-10000@example.com", "user-10000"]) {
      const result = await searchWorkspaceMembers("acme", query);
      expect(result).toEqual({ members: [{ id: "user-10000", label: "Same name (member-10000@example.com)" }], hasMore: false });
    }
  });
  it("escapes wildcard input and handles missing names", async () => {
    expect(await searchWorkspaceMembers("acme", "50%_off")).toEqual({ members: [{ id: "literal", label: "50%_off@example.com" }], hasMore: false });
    expect((await searchWorkspaceMembers("acme", "member_%")).members).toEqual([]);
  });
  it("scopes both direct lookup and search to membership", async () => {
    expect(await getWorkspaceMemberChoice("acme", "outsider")).toBeNull();
    expect((await searchWorkspaceMembers("acme", "outsider")).members).toEqual([]);
    expect(await getWorkspaceMemberChoice("acme", "user-10000")).toEqual({ id: "user-10000", label: "Same name (member-10000@example.com)" });
  });
  it("stops returning a removed member", async () => {
    await db.query("DELETE FROM workspace_member WHERE workspace_id = 'acme' AND user_id = 'user-9999'");
    expect(await getWorkspaceMemberChoice("acme", "user-9999")).toBeNull();
    expect((await searchWorkspaceMembers("acme", "member-09999@example.com")).members).toEqual([]);
  });
});
