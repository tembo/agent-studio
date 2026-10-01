// Run against a disposable database and the matching local Rust API:
// OUTPUT_REUSE_TEST_DATABASE_URL=postgres://... OUTPUT_REUSE_TEST_API_URL=http://127.0.0.1:58084 INTERNAL_API_TOKEN=... node scripts/test-output-reuse.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(new URL("../web/package.json", import.meta.url));
const { Pool } = require("pg");
const databaseUrl = process.env.OUTPUT_REUSE_TEST_DATABASE_URL;
const apiUrl = process.env.OUTPUT_REUSE_TEST_API_URL;
assert(databaseUrl && apiUrl && process.env.INTERNAL_API_TOKEN, "Set the disposable DB URL, local API URL, and internal token");
assert(["localhost", "127.0.0.1"].includes(new URL(apiUrl).hostname), "Test API must be local");
const db = new Pool({ connectionString: databaseUrl });
const workspace = randomUUID(), version = randomUUID(), original = randomUUID(), parent = randomUUID(), user = randomUUID();
const key = "a".repeat(64);
const headers = { Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}`, "Content-Type": "application/json" };
async function create(overrides = {}) {
  const response = await fetch(`${apiUrl}/internal/runs`, { method: "POST", headers, body: JSON.stringify({ workspace_id:workspace, user_id:user, agent_name:"reporter", agent_path:"report.yaml", model:"test", spec_content:"{}", agent_version_id:version, agent_version_label:"v1", orchestrator_run_id:parent, output_reuse:{key,report_type:"report",max_age_seconds:60}, ...overrides }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
try {
  await db.query('INSERT INTO "user" (id,name,email) VALUES ($1,\'Reuse test\',$2)', [user, `${user}@example.test`]);
  await db.query("INSERT INTO workspace (id,name,slug,created_by) VALUES ($1,'Reuse test',$2,$3)", [workspace,workspace,user]);
  await db.query("INSERT INTO agent_version (id,workspace_id,agent_name,agent_path,version_number,framework,spec_content,spec_format,created_by) VALUES ($1,$2,'reporter','report.yaml',1,'pydantic-agentspec','{}','json',$3)", [version,workspace,user]);
  for (const id of [original,parent]) {
    await db.query("INSERT INTO run (id,workspace_id,agent_name,agent_path,model,status,output,created_by,agent_version_id,agent_version_label,run_environment,completed_at,output_reuse_key,output_reuse_type) VALUES ($1,$2,'reporter','report.yaml','test','succeeded','original report',$3,$4,'v1','production',now() - interval '10 seconds',$5,'report')", [id,workspace,user,version,id === original ? key : null]);
  }
  const hit = await create();
  assert.equal(hit.reused_from_run_id, original);
  const result = await (await fetch(`${apiUrl}/internal/runs/${hit.run_id}?workspace_id=${workspace}`, { headers })).json();
  assert.equal(result.status,"succeeded");
  assert.equal(result.output,"original report");
  assert.equal(result.reused_from_run_id,original);
  assert.equal(result.output_reuse_type,"report");
  assert.equal(result.tokens_input,0);
  const stored = (await db.query("SELECT orchestrator_run_id, cost_usd, delivery_status FROM run WHERE id=$1", [hit.run_id])).rows[0];
  assert.equal(stored.orchestrator_run_id,parent);
  assert.equal(Number(stored.cost_usd),0);
  assert.equal(stored.delivery_status,"undeclared");
  // Repeated hits retain original provenance, never the most recent reused row.
  assert.equal((await create()).reused_from_run_id,original);
  const deliveryHit = await create({output_delivery:{note:"Send report",destinations:[{key:"inbox",label:"Inbox",evidence:{type:"inbox_item"}}]}});
  assert.equal(deliveryHit.reused_from_run_id,original);
  assert.equal((await db.query("SELECT delivery_status FROM run WHERE id=$1",[deliveryHit.run_id])).rows[0].delivery_status,"unobserved");
  await db.query("UPDATE run SET run_environment='development' WHERE id=$1", [parent]);
  assert.equal((await create()).reused_from_run_id,null);
  await db.query("UPDATE run SET run_environment='production' WHERE id=$1", [parent]);
  const fresh = await create({output_reuse:{key,report_type:"report",max_age_seconds:0}});
  assert.equal(fresh.reused_from_run_id,null);
  await db.query("UPDATE run SET is_dry_run=true WHERE id=$1", [parent]);
  // With no delivery declaration, inherited dry-run rejects dispatch before lookup.
  const dryResponse = await fetch(`${apiUrl}/internal/runs`, {method:"POST",headers,body:JSON.stringify({workspace_id:workspace,user_id:user,agent_name:"reporter",agent_path:"report.yaml",model:"test",agent_version_id:version,agent_version_label:"v1",orchestrator_run_id:parent,output_reuse:{key,report_type:"report",max_age_seconds:60}})});
  assert.equal(dryResponse.status,400);
  console.log("PASS: migration-backed dispatch, child provenance, zero cost, original freshness, no repeated delivery, force-fresh, and inherited environment/dry-run");
} finally {
  // Cancel any fresh work before removing fixtures. No provider credentials are installed.
  const runs = await db.query("SELECT id FROM run WHERE workspace_id=$1 AND status IN ('queued','running')", [workspace]);
  for (const row of runs.rows) await fetch(`${apiUrl}/internal/runs/${row.id}/cancel?workspace_id=${workspace}`, {method:"POST",headers});
  await db.query("DELETE FROM run WHERE workspace_id=$1 AND reused_from_run_id IS NOT NULL", [workspace]);
  await db.query("DELETE FROM run WHERE workspace_id=$1", [workspace]);
  await db.query("DELETE FROM workspace WHERE id=$1", [workspace]);
  await db.query('DELETE FROM "user" WHERE id=$1', [user]);
  await db.end();
}
