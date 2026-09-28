import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { schema, connectionString } = vi.hoisted(() => ({
  schema: `linkedin_privacy_test_${Date.now()}`,
  connectionString: process.env.LINKEDIN_TEST_DATABASE_URL,
}));
vi.mock("@/lib/db", async () => {
  const { Pool } = await import("pg");
  return { db: new Pool({ connectionString, options: `-c search_path=${schema}` }) };
});

import { db } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { aadSecretConnection } from "@/lib/crypto-aad";
import {
  deleteSecretConnection,
  getPersonalSecretConnectionValue,
  getSecretConnectionById,
  listSecretConnections,
  upsertSecretConnection,
} from "@/lib/secret-connections";

describe.skipIf(!connectionString)("LinkedIn privacy in PostgreSQL", () => {
  const workspaceId = "00000000-0000-0000-0000-000000000001";
  const otherWorkspaceId = "00000000-0000-0000-0000-000000000002";
  const slugs = ["linkedin_li_at", "linkedin_jsessionid", "linkedin_user_agent"];
  let legacyId: string;

  beforeAll(async () => {
    vi.stubEnv("TAS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`CREATE TABLE workspace (id uuid PRIMARY KEY);
      CREATE TABLE "user" (id text PRIMARY KEY)`);
    for (const migration of ["0039_workspace_secret_connection.sql", "0084_user_scoped_secret_connection.sql"]) {
      await db.query(readFileSync(new URL(`../../../../api/migrations/${migration}`, import.meta.url), "utf8"));
    }
    await db.query("INSERT INTO workspace VALUES ($1), ($2)", [workspaceId, otherWorkspaceId]);
    await db.query('INSERT INTO "user" VALUES (\'alice\'), (\'bob\')');
    for (const slug of slugs) {
      const result = await db.query(
        `INSERT INTO workspace_secret_connection (workspace_id, slug, ciphertext, last4, created_by)
         VALUES ($1, $2, $3, 'last', 'alice') RETURNING id`,
        [workspaceId, slug, encryptSecret("legacy-shared", aadSecretConnection(workspaceId, slug))],
      );
      legacyId = result.rows[0].id;
      await upsertSecretConnection({ workspaceId, slug, value: `alice-${slug}`, description: null, actorUserId: "alice", ownerUserId: "alice" });
    }
    await upsertSecretConnection({ workspaceId, slug: "clay", value: "shared-clay", description: null, actorUserId: "alice", ownerUserId: null });
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
    vi.unstubAllEnvs();
  });

  it("hides personal and legacy LinkedIn metadata from other members", async () => {
    expect((await listSecretConnections(workspaceId, "alice")).map((secret) => secret.slug)).toEqual(["clay", ...slugs.sort()]);
    expect((await listSecretConnections(workspaceId, "bob")).map((secret) => secret.slug)).toEqual(["clay"]);
    expect((await listSecretConnections(workspaceId)).map((secret) => secret.slug)).toEqual(["clay"]);
    expect(await getSecretConnectionById(workspaceId, legacyId, "alice")).toBeNull();
    expect(await listSecretConnections(otherWorkspaceId, "alice")).toEqual([]);
  });

  it("returns only the acting user's personal session with no shared fallback", async () => {
    for (const slug of slugs) {
      expect(await getPersonalSecretConnectionValue(workspaceId, slug, "alice")).toBe(`alice-${slug}`);
      expect(await getPersonalSecretConnectionValue(workspaceId, slug, "bob")).toBeNull();
      expect(await getPersonalSecretConnectionValue(otherWorkspaceId, slug, "alice")).toBeNull();
    }
  });

  it("cannot look up or delete another member's personal secret by ID", async () => {
    const secret = (await listSecretConnections(workspaceId, "alice")).find((item) => item.slug === "linkedin_li_at")!;
    expect(await getSecretConnectionById(workspaceId, secret.id, "bob")).toBeNull();
    expect(await deleteSecretConnection(workspaceId, secret.id, "bob")).toBe(false);
    expect(await getPersonalSecretConnectionValue(workspaceId, "linkedin_li_at", "alice")).toBe("alice-linkedin_li_at");
  });

  it("keeps two members' credentials separate", async () => {
    await upsertSecretConnection({ workspaceId, slug: "linkedin_li_at", value: "bob-session", description: null, actorUserId: "bob", ownerUserId: "bob" });
    expect(await getPersonalSecretConnectionValue(workspaceId, "linkedin_li_at", "bob")).toBe("bob-session");
    expect(await getPersonalSecretConnectionValue(workspaceId, "linkedin_li_at", "alice")).toBe("alice-linkedin_li_at");
    expect(await getPersonalSecretConnectionValue(workspaceId, "linkedin_jsessionid", "bob")).toBeNull();
  });
});
