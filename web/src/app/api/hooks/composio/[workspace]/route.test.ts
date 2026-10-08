import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ workspace: vi.fn(), preview: vi.fn(), secret: vi.fn(), trigger: vi.fn(), resolve: vi.fn(), success: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ getWorkspaceBySlug: mocks.workspace, getWorkspaceSecretPreview: mocks.preview, getWorkspaceSecretPlaintext: mocks.secret }));
vi.mock("@/lib/triggers-db", () => ({ getTriggerByComposioId: mocks.trigger }));
vi.mock("@/lib/workspace-agents", () => ({ resolveAgentForDispatch: mocks.resolve }));
vi.mock("@/lib/automation-events", () => ({ recordAutomationSuccess: mocks.success }));
import { POST } from "./route";

const secret = "test-composio-signing-secret";
const payload = { subject: "memtest", message_id: "email-1" };
const triggerId = "trigger-1";
const variants = [
  { trigger_name: "GMAIL_NEW_GMAIL_MESSAGE", connection_id: "connection-1", trigger_id: triggerId, payload, log_id: "log-1" },
  { type: "gmail_new_gmail_message", timestamp: "2026-10-08T00:00:00Z", log_id: "log-1", data: { connection_id: "connection-uuid", connection_nano_id: "connection-1", trigger_nano_id: triggerId, trigger_id: "trigger-uuid", user_id: "ws:owner", ...payload } },
  { id: "event-id-not-trigger-id", type: "composio.trigger.message", timestamp: "2026-10-08T00:00:00Z", metadata: { log_id: "log-1", trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE", trigger_id: triggerId, connected_account_id: "connection-1", auth_config_id: "auth-1", user_id: "ws:owner" }, data: payload },
];
function request(body: unknown, signingSecret = secret) {
  const raw = JSON.stringify(body, null, 2);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", signingSecret).update(`delivery-1.${timestamp}.${raw}`).digest("base64");
  return new NextRequest("https://tas.example/api/hooks/composio/tembo", {
    method: "POST", body: raw, headers: { "webhook-id": "delivery-1", "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` },
  });
}
const context = { params: Promise.resolve({ workspace: "tembo" }) };
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("INTERNAL_API_TOKEN", "test-token");
  vi.stubEnv("COMPOSIO_LOGGING_LEVEL", "silent");
  mocks.workspace.mockResolvedValue({ id: "ws", slug: "tembo" });
  mocks.preview.mockResolvedValue({ last4: "test" });
  mocks.secret.mockImplementation(async (_id, kind) => kind === "composio_webhook_secret" ? secret : "test-api-key");
  mocks.trigger.mockResolvedValue({ id: "local-trigger", workspaceId: "ws", enabled: true, userId: "owner", agentName: "email-memory-test" });
  mocks.resolve.mockResolvedValue({ ok: true, resolved: { agentName: "email-memory-test", agentPath: "agents/email.yaml", model: "test", framework: "pydantic-agentspec", specContent: "test", specFormat: "yaml", versionId: "stable", versionLabel: "v1" } });
  fetchMock = vi.fn().mockImplementation(async () => Response.json({ run_id: "run-1" }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("signed Composio Gmail delivery", () => {
  it.each(variants)("dispatches an SDK-supported Gmail payload using the trigger ID", async (body) => {
    const response = await POST(request(body), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", run_id: "run-1" });
    expect(mocks.trigger).toHaveBeenCalledWith(triggerId);
    const dispatched = JSON.parse(fetchMock.mock.calls.find(([url]) => String(url).endsWith("/internal/runs"))![1].body);
    expect(dispatched).toMatchObject({ workspace_id: "ws", user_id: "owner", trigger: "event", agent_version_id: "stable" });
    expect(JSON.parse(dispatched.user_message)).toMatchObject({ trigger_id: triggerId, trigger_type: "GMAIL_NEW_GMAIL_MESSAGE", payload });
    expect(mocks.success).toHaveBeenCalledWith({ kind: "trigger", id: "local-trigger", runId: "run-1" });
  });
  it("rejects an invalid signature before looking up a trigger", async () => {
    expect((await POST(request(variants[2], "wrong-secret"), context)).status).toBe(401);
    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/internal/runs"))).toBe(false);
  });
  it("does not dispatch a trigger for a different workspace", async () => {
    mocks.trigger.mockResolvedValue({ workspaceId: "other", enabled: true });
    expect(await (await POST(request(variants[2]), context)).json()).toEqual({ status: "ignored" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/internal/runs"))).toBe(false);
  });
});
