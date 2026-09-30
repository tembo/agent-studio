import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MCP_PROVIDERS } from "./mcp-providers";
import { renderNativeOauthAllowlistRs } from "../../scripts/gen-native-oauth-allowlist";

describe("Maxio native MCP", () => {
  it("uses Carefeed's OAuth endpoint with automatic client registration", () => {
    const provider = MCP_PROVIDERS.maxio;
    expect(provider.mcpServerUrl).toBe(
      "https://brave-hall-4395.mcp.maxio.com/v3/mcp",
    );
    expect(provider.authMode ?? "dcr").toBe("dcr");
    expect(provider.scopeOverride).toEqual(["all"]);
    expect(provider.omitOfflineAccess).toBe(true);
    expect(provider.oauthAuthorizationServerOrigins).toEqual([
      new URL(provider.mcpServerUrl).origin,
    ]);
  });

  it("allows refresh only through the configured Maxio tenant", () => {
    expect(renderNativeOauthAllowlistRs()).toContain(
      '("https://brave-hall-4395.mcp.maxio.com", &["https://brave-hall-4395.mcp.maxio.com"]), // maxio',
    );
  });

  it("keeps the run transport's fixed upstream in sync with the catalog", () => {
    const proxy = readFileSync("../api/src/runs/native_mcp_proxy.rs", "utf8");
    expect(proxy).toContain(`const MAXIO_URL: &str = "${MCP_PROVIDERS.maxio.mcpServerUrl}";`);
  });
});
