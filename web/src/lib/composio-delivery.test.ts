import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const { listActive } = vi.hoisted(() => ({ listActive: vi.fn() }));
vi.mock("@composio/core", () => ({ Composio: class { triggers = { listActive }; } }));
import { checkComposioDelivery, checkComposioTriggerInstances, configureComposioDelivery } from "./composio-delivery";

const url = "https://tas.example/api/hooks/composio/tembo";
const secret = "test-signing-secret";
const subscription = { id: "sub-1", webhook_url: url, enabled_events: ["composio.trigger.message"], secret };
let fetchMock: ReturnType<typeof vi.fn>;
const respond = (data: unknown) => fetchMock.mockResolvedValueOnce(Response.json(data));
beforeEach(() => { vi.resetAllMocks(); fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe("Composio delivery setup", () => {
  it("registers this workspace when no subscription exists", async () => {
    respond({ items: [] });
    respond(subscription);
    expect(await configureComposioDelivery("api-key", url)).toEqual(subscription);
    const [endpoint, init] = fetchMock.mock.calls[1];
    expect(endpoint).toBe("https://backend.composio.dev/api/v3.1/webhook_subscriptions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ webhook_url: url, enabled_events: ["composio.trigger.message"], version: "V3" });
    expect(init.headers["x-api-key"]).toBe("api-key");
    expect(fetchMock.mock.calls[0][0]).toContain("limit=50");
  });
  it("refuses to replace another workspace's destination or create a second subscription", async () => {
    respond({ items: [{ ...subscription, webhook_url: "https://other.example/hook" }] });
    await expect(configureComposioDelivery("key", url)).rejects.toThrow("already delivers to another URL");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("reuses a matching subscription without another mutation", async () => {
    respond({ items: [subscription] });
    expect(await configureComposioDelivery("key", url)).toEqual(subscription);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("enables trigger events on the matching URL, preserving existing events", async () => {
    respond({ items: [{ ...subscription, enabled_events: ["composio.connected_account.expired"] }] });
    respond(subscription);
    await configureComposioDelivery("key", url);
    const [endpoint, init] = fetchMock.mock.calls[1];
    expect(endpoint).toMatch(/\/sub-1$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ enabled_events: ["composio.connected_account.expired", "composio.trigger.message"] });
  });
  it("finds an existing subscription after pagination", async () => {
    respond({ items: [], next_cursor: "page2" });
    respond({ items: [subscription], next_cursor: null });
    await configureComposioDelivery("key", url);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("cursor=page2");
  });
  it("refuses ambiguous duplicates", async () => {
    respond({ items: [subscription, { ...subscription, id: "sub-2" }] });
    await expect(configureComposioDelivery("key", url)).rejects.toThrow("Multiple subscriptions");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["http://localhost:3000/hook", "https://localhost/hook", "http://tas.example/hook"])("rejects non-public HTTPS origin %s", async (invalid) => {
    await expect(configureComposioDelivery("key", invalid)).rejects.toThrow("public HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not mutate after a failed or malformed list response", async () => {
    respond({ unexpected: [] });
    await expect(configureComposioDelivery("key", url)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("never includes upstream error bodies in errors", async () => {
    fetchMock.mockResolvedValue(new Response("credential-value", { status: 401 }));
    await expect(configureComposioDelivery("key", url)).rejects.toThrow("HTTP 401");
  });
});

describe("delivery diagnostics", () => {
  it.each([
    [[], secret, "No Composio webhook subscription"],
    [[{ ...subscription, webhook_url: "https://other.example/hook" }], secret, "different URL"],
    [[{ ...subscription, enabled_events: [] }], secret, "not subscribed"],
    [[subscription], null, "no signing secret"],
    [[subscription], "wrong", "does not match"],
    [[{ ...subscription, secret: undefined }], secret, "did not return a signing secret"],
    [[subscription], secret, "matching signing secret"],
  ])("reports configuration accurately", async (items, saved, expected) => {
    respond({ items });
    expect(await checkComposioDelivery({ apiKey: "key", webhookUrl: url, secret: saved })).toContain(expected);
  });
  it("reports enabled, disabled, and missing remote instances including UUIDs", async () => {
    listActive.mockResolvedValueOnce({ items: [{ id: "nano", uuid: "uuid", disabledAt: null }], nextCursor: "next" });
    listActive.mockResolvedValueOnce({ items: [{ id: "disabled", disabledAt: "2026-01-01" }], nextCursor: null });
    const result = await checkComposioTriggerInstances("key", ["uuid", "disabled", "missing"]);
    expect(result.map((r) => r.status)).toEqual([
      "Enabled in Composio (email detection not confirmed)", "Disabled in Composio", "Not found in this Composio project",
    ]);
    expect(listActive).toHaveBeenCalledWith({ triggerIds: ["uuid", "disabled", "missing"], showDisabled: true, limit: 100, cursor: "next" }, { signal: expect.any(AbortSignal) });
  });
});
