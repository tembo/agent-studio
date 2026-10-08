import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), preview: vi.fn(), plaintext: vi.fn(), save: vi.fn(), audit: vi.fn(),
  configure: vi.fn(), check: vi.fn(), remote: vi.fn(), triggers: vi.fn(), revalidate: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/auth-server", () => ({ authorizeWorkspace: mocks.auth, DENIED_MESSAGE: "Denied" }));
vi.mock("@/lib/config", () => ({ getPublicOrigin: () => "https://tas.example" }));
vi.mock("@/lib/audit-db", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/workspace-secrets", () => ({ getWorkspaceSecretPreview: mocks.preview, getWorkspaceSecretPlaintext: mocks.plaintext, setWorkspaceSecret: mocks.save }));
vi.mock("@/lib/triggers-db", () => ({ listTriggersForWorkspace: mocks.triggers }));
vi.mock("@/lib/composio-delivery", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/composio-delivery")>(), configureComposioDelivery: mocks.configure, checkComposioDelivery: mocks.check, checkComposioTriggerInstances: mocks.remote }));
import { composioDeliveryAction } from "./actions";
import { ComposioDeliveryConfigurationError } from "@/lib/composio-delivery";
function form(intent = "configure") {
  const data = new FormData();
  data.set("workspace", "tembo"); data.set("intent", intent);
  data.set("webhookUrl", "https://attacker.example");
  return data;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ ok: true, workspace: { id: "ws", slug: "tembo" }, userId: "admin" });
  mocks.preview.mockResolvedValue({ last4: "1234" });
  mocks.plaintext.mockResolvedValue("api-key");
  mocks.configure.mockResolvedValue({ id: "sub", secret: "test-signing-secret" });
  mocks.save.mockResolvedValue({ ok: true });
});
describe("delivery actions", () => {
  it.each(["check", "configure"])("requires workspace admin for %s", async (intent) => {
    mocks.auth.mockResolvedValue({ ok: false });
    expect(await composioDeliveryAction({}, form(intent))).toEqual({ error: "Denied" });
    expect(mocks.auth).toHaveBeenCalledWith("tembo", "workspace_admin");
    expect(mocks.plaintext).not.toHaveBeenCalled();
    expect(mocks.configure).not.toHaveBeenCalled();
  });
  it("uses the authorized workspace and saves the secret without exposing it", async () => {
    const result = await composioDeliveryAction({}, form());
    expect(mocks.configure).toHaveBeenCalledWith("api-key", "https://tas.example/api/hooks/composio/tembo");
    expect(mocks.save).toHaveBeenCalledWith("ws", "composio_webhook_secret", "test-signing-secret");
    expect(JSON.stringify(result)).not.toContain("test-signing-secret");
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("test-signing-secret");
    expect(mocks.revalidate).toHaveBeenCalled();
  });
  it("reports partial setup when the signing secret is unavailable", async () => {
    mocks.configure.mockResolvedValue({ id: "sub" });
    expect((await composioDeliveryAction({}, form())).error).toContain("did not return");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("does not claim success when secret storage fails", async () => {
    mocks.save.mockResolvedValue({ ok: false, error: "too-short" });
    expect((await composioDeliveryAction({}, form())).error).toContain("could not be saved");
  });
  it("checks only this workspace's triggers without writing configuration", async () => {
    mocks.triggers.mockResolvedValue([{ composioTriggerId: "trigger", agentName: "email-memory-test", enabled: true }]);
    mocks.remote.mockResolvedValue([{ id: "trigger", status: "Enabled in Composio" }]);
    mocks.check.mockResolvedValue("Configured");
    const result = await composioDeliveryAction({}, form("check"));
    expect(mocks.triggers).toHaveBeenCalledWith("ws");
    expect(mocks.remote).toHaveBeenCalledWith("api-key", ["trigger"]);
    expect(result.triggers?.[0].agent).toBe("email-memory-test");
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("explains configuration conflicts without claiming success", async () => {
    mocks.configure.mockRejectedValue(new ComposioDeliveryConfigurationError("Another workspace uses this project."));
    expect(await composioDeliveryAction({}, form())).toEqual({ error: "Another workspace uses this project." });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("still reports trigger status if checking webhook subscriptions fails", async () => {
    mocks.triggers.mockResolvedValue([{ composioTriggerId: "trigger", agentName: "email", enabled: true }]);
    mocks.remote.mockResolvedValue([{ id: "trigger", status: "Disabled in Composio" }]);
    mocks.check.mockRejectedValue(new Error("upstream error"));
    const result = await composioDeliveryAction({}, form("check"));
    expect(result.message).toContain("Could not check");
    expect(result.triggers?.[0].status).toContain("Disabled in Composio");
  });
  it("keeps upstream errors out of client state", async () => {
    mocks.configure.mockRejectedValue(new Error("sensitive upstream body"));
    const result = await composioDeliveryAction({}, form());
    expect(result.error).toBeDefined();
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });
});
