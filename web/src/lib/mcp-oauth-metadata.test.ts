import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  getPublicOrigin: () => "https://tas.example.com",
}));

import { mcpProtectedResourceMetadata } from "./mcp-oauth-metadata";

describe("mcpProtectedResourceMetadata", () => {
  it("advertises the exact MCP resource and TAS OAuth issuer", async () => {
    const response = mcpProtectedResourceMetadata();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resource: "https://tas.example.com/mcp",
      authorization_servers: ["https://tas.example.com/api/auth"],
      scopes_supported: ["mcp:read", "mcp:write"],
      bearer_methods_supported: ["header"],
      resource_name: "Tembo Agent Studio MCP",
    });
  });
});
