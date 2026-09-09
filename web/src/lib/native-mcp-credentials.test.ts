import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getById, getCredentials } = vi.hoisted(() => ({
  getById: vi.fn(),
  getCredentials: vi.fn(),
}));

vi.mock("@/lib/connections", () => ({
  getNativeConnectionById: getById,
  getNativeConnectionCredentials: getCredentials,
}));

import type { WorkspaceConnection } from "@/lib/connections";
import { getUsableNativeMcpCredentials } from "./native-mcp-credentials";

const connection = {
  id: "connection-1",
  workspaceId: "workspace-1",
  userId: "owner-1",
  authType: "oauth2",
  status: "active",
  tokenExpiresAt: null,
} as WorkspaceConnection;

describe("native MCP refresh-before-use", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("INTERNAL_API_TOKEN", "internal-token");
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    getById.mockResolvedValue(connection);
    getCredentials.mockResolvedValue({ access_token: "new-token" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refreshes under the connection owner's scope before rereading credentials", async () => {
    await expect(getUsableNativeMcpCredentials(connection)).resolves.toEqual({ access_token: "new-token" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/internal/connections/native/connection-1/refresh",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        headers: { Authorization: "Bearer internal-token", "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-1", userId: "owner-1" }),
      }),
    );
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(getCredentials.mock.invocationCallOrder[0]);
  });

  it.each([409, 503, 500])("does not read credentials after refresh returns %s", async (status) => {
    fetchMock.mockResolvedValue(new Response("sensitive upstream body", { status }));
    await expect(getUsableNativeMcpCredentials(connection)).rejects.toThrow(
      status === 409 ? "Reconnect" : "Retry later",
    );
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it("does not fall back to stored credentials when the API is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("network unavailable"));
    await expect(getUsableNativeMcpCredentials(connection)).rejects.toThrow();
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it.each(["stale", "revoked", "expired"])("rejects a connection that becomes %s", async (status) => {
    getById.mockResolvedValue({ ...connection, status });
    await expect(getUsableNativeMcpCredentials(connection)).rejects.toThrow("Reconnect");
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it("rejects a deleted connection", async () => {
    getById.mockResolvedValue(null);
    await expect(getUsableNativeMcpCredentials(connection)).rejects.toThrow("Reconnect");
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it("rejects credentials that expire before use", async () => {
    getCredentials.mockResolvedValue({ access_token: "expired", expires_at: "2000-01-01T00:00:00Z" });
    await expect(getUsableNativeMcpCredentials(connection)).rejects.toThrow("Retry later");
  });

  it("rejects a still-expired database expiry", async () => {
    getById.mockResolvedValue({ ...connection, tokenExpiresAt: new Date(0) });
    await expect(getUsableNativeMcpCredentials(connection)).rejects.toThrow("Retry later");
  });

  it("does not send PAT connections through OAuth", async () => {
    await expect(getUsableNativeMcpCredentials({ ...connection, authType: "pat" })).resolves.toEqual({ access_token: "new-token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when internal authentication is unconfigured", async () => {
    vi.stubEnv("INTERNAL_API_TOKEN", "");
    await expect(getUsableNativeMcpCredentials(connection)).rejects.toThrow("administrator");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getCredentials).not.toHaveBeenCalled();
  });
});
