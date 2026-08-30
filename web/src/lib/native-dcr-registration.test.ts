import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/connections", () => ({
  getNativeConnection: vi.fn(),
  getNativeConnectionCredentials: vi.fn(),
}));

import {
  getNativeConnection,
  getNativeConnectionCredentials,
} from "@/lib/connections";
import {
  dcrRegistrationFailureMessage,
  getReusableDcrRegistration,
} from "./native-dcr-registration";

const mockConnection = vi.mocked(getNativeConnection);
const mockCredentials = vi.mocked(getNativeConnectionCredentials);

const args = {
  workspaceId: "workspace-1",
  userId: "user-1",
  provider: "attio" as const,
  connectionName: "default",
  mcpServerUrl: "https://mcp.attio.com/mcp",
};

function connection(
  metadata: Record<string, unknown>,
  mcpServerUrl = args.mcpServerUrl,
) {
  return {
    id: "connection-1",
    mcpServerUrl,
    metadata,
  } as Awaited<ReturnType<typeof getNativeConnection>>;
}

describe("getReusableDcrRegistration", () => {
  beforeEach(() => {
    mockConnection.mockReset();
    mockCredentials.mockReset();
  });

  it("reuses a public DCR client without reading credentials", async () => {
    mockConnection.mockResolvedValue(
      connection({ dcr_client_id: "existing-client" }),
    );

    await expect(getReusableDcrRegistration(args)).resolves.toEqual({
      clientId: "existing-client",
      clientSecret: null,
    });
    expect(mockCredentials).not.toHaveBeenCalled();
  });

  it("reuses a confidential DCR client with its encrypted credentials", async () => {
    mockConnection.mockResolvedValue(
      connection({
        auth_mode: "dcr_confidential",
        dcr_client_id: "confidential-client",
      }),
    );
    mockCredentials.mockResolvedValue({
      access_token: "old-token",
      client_id: "confidential-client",
      client_secret: "client-secret",
    });

    await expect(getReusableDcrRegistration(args)).resolves.toEqual({
      clientId: "confidential-client",
      clientSecret: "client-secret",
    });
    expect(mockCredentials).toHaveBeenCalledWith("connection-1");
  });

  it("registers again when the saved registration cannot be reused", async () => {
    mockConnection.mockResolvedValue(
      connection(
        { dcr_client_id: "client-for-old-server" },
        "https://old.example.com/mcp",
      ),
    );

    await expect(getReusableDcrRegistration(args)).resolves.toBeNull();
  });

  it("registers again when confidential credentials are incomplete", async () => {
    mockConnection.mockResolvedValue(
      connection({
        auth_mode: "dcr_confidential",
        dcr_client_id: "confidential-client",
      }),
    );
    mockCredentials.mockResolvedValue({ access_token: "old-token" });

    await expect(getReusableDcrRegistration(args)).resolves.toBeNull();
  });
});

describe("dcrRegistrationFailureMessage", () => {
  it("turns rate limits into actionable provider-safe guidance", () => {
    expect(dcrRegistrationFailureMessage("Clerk", 429)).toBe(
      "Clerk is temporarily limiting new connections. Please try again later.",
    );
  });

  it("does not include an upstream response body", () => {
    expect(dcrRegistrationFailureMessage("Attio", 503)).toBe(
      "Couldn't register a new Attio connection (503). Please try again later.",
    );
  });
});
