import { describe, expect, it } from "vitest";

import {
  canCreateSecretScope,
  canManageSecretScope,
} from "./secret-connection-policy";

describe("secret connection scope policy", () => {
  it("lets operators manage personal secrets only", () => {
    expect(canCreateSecretScope("operator", "personal")).toBe(true);
    expect(canManageSecretScope("operator", "personal")).toBe(true);
    expect(canCreateSecretScope("operator", "workspace")).toBe(false);
    expect(canManageSecretScope("operator", "workspace")).toBe(false);
  });

  it("lets workspace admins manage both scopes", () => {
    expect(canCreateSecretScope("workspace_admin", "personal")).toBe(true);
    expect(canCreateSecretScope("workspace_admin", "workspace")).toBe(true);
    expect(canManageSecretScope("workspace_admin", "personal")).toBe(true);
    expect(canManageSecretScope("workspace_admin", "workspace")).toBe(true);
  });

  it("keeps viewers read-only", () => {
    expect(canCreateSecretScope("viewer", "personal")).toBe(false);
    expect(canCreateSecretScope("viewer", "workspace")).toBe(false);
  });
});
