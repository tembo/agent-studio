import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { Pool } = require("pg");
const databaseUrl = process.env.STUDIO_MEMORY_TEST_DATABASE_URL;
const memoryDatabaseUrl = process.env.MEMORY_TEST_DATABASE_URL;
const memoryOrigin = process.env.MEMORY_TEST_URL;
if (!databaseUrl || !memoryDatabaseUrl || !memoryOrigin) {
  throw new Error("Set STUDIO_MEMORY_TEST_DATABASE_URL, MEMORY_TEST_DATABASE_URL and MEMORY_TEST_URL to disposable local test services");
}
for (const value of [databaseUrl, memoryDatabaseUrl, memoryOrigin]) {
  assert.equal(new URL(value).hostname, "127.0.0.1", "Integration tests require loopback-only services");
}
const studio = new Pool({ connectionString: databaseUrl });
const memory = new Pool({ connectionString: memoryDatabaseUrl });
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const digest = (value) => createHash("sha256").update(value).digest("hex");
let online = false;
let loseAcknowledgement = true;
const proxy = createServer(async (request, response) => {
  if (!online) { response.writeHead(503).end(); return; }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await fetch(`${memoryOrigin}${request.url}`, {
      method: request.method,
      headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json", ...(request.headers["x-memory-workspace"] ? { "x-memory-workspace": request.headers["x-memory-workspace"] } : {}) },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const text = await result.text();
    if (request.url === "/v1/reports" && result.ok && loseAcknowledgement) {
      loseAcknowledgement = false;
      response.writeHead(503).end();
      return;
    }
    response.writeHead(result.status, { "content-type": "application/json" }).end(text);
  } catch { response.writeHead(503).end(); }
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const destination = `http://127.0.0.1:${proxy.address().port}`;
const port = Number(process.env.STUDIO_MEMORY_TEST_PORT ?? "58084");
const origin = `http://127.0.0.1:${port}`;
let server;

async function start() {
  server = spawn(fileURLToPath(new URL("../api/target/debug/tas-api", import.meta.url)), [], {
    env: { ...process.env, DATABASE_URL: databaseUrl, API_BIND_ADDR: `127.0.0.1:${port}`,
      TAS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", INTERNAL_API_TOKEN: "test-internal",
      TAS_MEMORY_URL: destination, TAS_MEMORY_ADMIN_TOKEN: process.env.MEMORY_TEST_ADMIN_TOKEN ?? "memory-test-admin" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/health`)).ok) return; } catch {}
    if (server.exitCode !== null) throw new Error("Studio test API exited");
    await delay(100);
  }
  throw new Error("Studio test API did not start");
}

async function stop() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await once(server, "exit");
}

async function fixture(target) {
  const workspace = randomUUID();
  const run = randomUUID();
  const user = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const principal = `agent:studio-${workspace}-${digest(`test\x1f${user}`)}`;
  target ??= `studio-${workspace}`;
  await studio.query('INSERT INTO "user" (id, name, email) VALUES ($1,$1,$2)', [user, `${user}@example.test`]);
  await studio.query("INSERT INTO workspace (id,name,slug,created_by) VALUES ($1,'Memory test',$2,$3)", [workspace, workspace, user]);
  await studio.query("INSERT INTO workspace_member (workspace_id,user_id,role) VALUES ($1,$2,'operator')", [workspace, user]);
  await studio.query("INSERT INTO workspace_memory (workspace_id,memory_workspace_id) VALUES ($1,$2)", [workspace, target]);
  await studio.query("INSERT INTO run (id,workspace_id,agent_name,agent_path,model,status,created_by) VALUES ($1,$2,'test','test.yaml','test:model','running',$3)", [run, workspace, user]);
  await studio.query("INSERT INTO memory_run (run_id,token_hash,destination,memory_workspace_id,principal_id,operator_id) VALUES ($1,$2,$3,$4,$5,$6)", [run, digest(secret), destination, target, principal, `person:${user}`]);
  return { workspace, run, user, target, principal, token: `${run}.${secret}` };
}

async function rpc(identity, method, params = {}) {
  const response = await fetch(`${origin}/memory/mcp`, { method: "POST", headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.result;
}

async function tool(identity, name, args) {
  const result = await rpc(identity, "tools/call", { name, arguments: args });
  return JSON.parse(result.content[0].text);
}

try {
  await start();
  const first = await fixture();
  const catalog = await rpc(first, "tools/list");
  assert.equal(catalog.tools.length, 4, "Tool discovery works with Memory offline");
  if (process.env.MEMORY_TEST_PYTHON) {
    const python = spawn(process.env.MEMORY_TEST_PYTHON, ["-c", `
import asyncio, os, sys
sys.path.insert(0, os.environ['MEMORY_TEST_SCRIPTS'])
from pydantic_memory import build_memory_toolset
async def check():
    toolset = build_memory_toolset()
    async with toolset:
        tools = await toolset.list_tools()
        assert len(tools) == 4
asyncio.run(check())
`], { env: { ...process.env, MEMORY_TEST_SCRIPTS: fileURLToPath(new URL("../api/scripts", import.meta.url)), TAS_MEMORY_CONNECTION: JSON.stringify({ url: `${origin}/memory/mcp`, token: first.token }) }, stdio: ["ignore", "inherit", "inherit"] });
    const [code] = await once(python, "exit");
    assert.equal(code, 0, "Real Pydantic MCP client discovers tools while Memory is offline");
  }
  const unavailable = await tool(first, "memory_ask", { question: "What changed?" });
  assert.equal(unavailable.status, "unavailable");
  const report = { raw_ref: "test://original", text: "A durable test fact", shape: "pointer", occurred_at: "2026-08-01T12:00:00Z", _studio_invocation_id: "stable-call" };
  const queued = await tool(first, "memory_report", report);
  assert.equal(queued.status, "queued");
  const repeated = await tool(first, "memory_report", report);
  assert.equal(repeated.receipt_id, queued.receipt_id);
  const stored = (await studio.query("SELECT * FROM memory_outbox WHERE id = $1", [queued.receipt_id])).rows[0];
  assert.ok(!stored.payload.includes(Buffer.from(report.text)), "Pending payload is encrypted");
  await studio.query("UPDATE run SET status='succeeded' WHERE id=$1", [first.run]);
  await stop();
  online = true;
  await start();
  let delivered;
  for (let attempt = 0; attempt < 100; attempt++) {
    await studio.query("UPDATE memory_outbox SET next_attempt_at=now() WHERE id=$1 AND status='pending'", [queued.receipt_id]);
    delivered = (await studio.query("SELECT * FROM memory_outbox WHERE id=$1", [queued.receipt_id])).rows[0];
    if (delivered.status === "delivered") break;
    if (delivered.status === "blocked") throw new Error(`Unexpected blocked report: ${delivered.last_error}`);
    await delay(200);
  }
  assert.equal(delivered.status, "delivered", "Delivery resumes without another agent run");
  assert.equal(delivered.payload, null);
  assert.ok(delivered.attempts >= 2, "Lost acknowledgement requires replay");
  const upstream = (await memory.query("SELECT * FROM reports WHERE workspace_id=$1 AND filed_by=$2", [first.target, first.principal])).rows;
  assert.equal(upstream.length, 1, "Acknowledgement loss does not duplicate reports");
  assert.equal(upstream[0].occurred_at.toISOString(), "2026-08-01T12:00:00.000Z");
  const shared = await fixture(first.target);
  const isolated = await fixture();
  await tool(shared, "memory_entities", {});
  await tool(isolated, "memory_entities", {});
  await memory.query("INSERT INTO claims (workspace_id,claim_id,text,sensitivity,scopes,confidence,status,report_id,content_hash) VALUES ($1,$2,'Shared internal knowledge','internal',ARRAY['account:acme'],1,'active',$3,$4)", [first.target, `clm_${randomUUID()}`, upstream[0].report_id, digest("Shared internal knowledge")]);
  const sharedResult = await tool(shared, "memory_search", { q: "Shared internal knowledge" });
  assert.ok(JSON.stringify(sharedResult).includes("Shared internal knowledge"), "Shared workspace reads include account-scoped internal claims");
  const isolatedResult = await tool(isolated, "memory_search", { q: "Shared internal knowledge" });
  assert.ok(!JSON.stringify(isolatedResult).includes("Shared internal knowledge"), "Different Memory workspaces remain isolated");
  await memory.query("UPDATE api_keys SET expires_at=now() WHERE workspace_id=$1 AND principal_id=$2", [shared.target, shared.principal]);
  assert.equal((await tool(shared, "memory_entities", {})).status, "unavailable");
  assert.ok(!(await tool(shared, "memory_entities", {})).status, "Expired credentials are replaced without changing identity");
  const forged = await fetch(`${origin}/memory/mcp`, { method: "POST", headers: { authorization: `Bearer ${isolated.run}.${shared.token.split('.')[1]}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(forged.status, 401, "Run credentials cannot be moved to another run or workspace");
  const dryRun = await fixture();
  await studio.query("UPDATE run SET is_dry_run=true WHERE id=$1", [dryRun.run]);
  assert.equal((await tool(dryRun, "memory_report", report)).status, "simulated");
  assert.equal((await studio.query("SELECT count(*)::int AS count FROM memory_outbox WHERE run_id=$1", [dryRun.run])).rows[0].count, 0);
  for (const identity of [shared, isolated, dryRun]) await studio.query("UPDATE run SET status='succeeded' WHERE id=$1", [identity.run]);
  console.log("PASS: offline discovery/read warning, encrypted durable enqueue, replay, restart recovery, lost acknowledgement, shared/isolated workspaces, original event time, and dry-run suppression");
} finally {
  await stop();
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
  await studio.end();
  await memory.end();
}
