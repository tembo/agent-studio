import { beforeAll, describe, expect, it } from "vitest";

// 32 zero bytes, base64 — satisfies crypto.ts's KEY_LEN check. Set before the
// module reads it (getMasterKey reads process.env lazily per call, but be safe).
beforeAll(() => {
  process.env.TAS_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");
});

// Imported after the env guard above is declared; getMasterKey reads env per
// call so import order doesn't matter, but keep it explicit.
const { encryptSecret, decryptSecret } = await import("./crypto");
const { aadSecretConnection, aadWorkspaceSecret } = await import("./crypto-aad");

describe("crypto AES-GCM blobs", () => {
  it("round-trips without AAD (legacy layout)", () => {
    const blob = encryptSecret("hunter2");
    expect(decryptSecret(blob)).toBe("hunter2");
  });

  it("legacy blobs carry no version byte; AAD blobs are 1 byte longer", () => {
    const legacy = encryptSecret("x");
    const bound = encryptSecret("x", "ctx");
    expect(bound.length).toBe(legacy.length + 1);
    expect(bound[0]).toBe(0x01);
  });

  it("builds the canonical cross-language AAD (must match api/src/crypto.rs)", () => {
    expect(aadWorkspaceSecret("00000000-0000-0000-0000-000000000000", "kind")).toBe(
      "workspace_secret\u{1f}00000000-0000-0000-0000-000000000000\u{1f}kind",
    );
  });

  it("keeps shared secret AAD stable and binds personal secrets to their owner", () => {
    expect(aadSecretConnection("ws-1", "clay")).toBe(
      "secret_connection\u{1f}ws-1\u{1f}clay",
    );
    expect(aadSecretConnection("ws-1", "clay", "user-1")).toBe(
      "secret_connection\u{1f}ws-1\u{1f}clay\u{1f}user-1",
    );
  });

  it("round-trips with matching AAD", () => {
    const aad = aadWorkspaceSecret("ws-1", "anthropic_api_key");
    const blob = encryptSecret("sk-secret", aad);
    expect(decryptSecret(blob, aad)).toBe("sk-secret");
  });

  it("rejects a mismatched AAD (row-binding holds)", () => {
    const blob = encryptSecret("sk-secret", aadWorkspaceSecret("ws-1", "k"));
    expect(() =>
      decryptSecret(blob, aadWorkspaceSecret("ws-2", "k")),
    ).toThrow();
  });

  it("requires the AAD to read a bound blob", () => {
    const blob = encryptSecret("sk-secret", aadWorkspaceSecret("ws-1", "k"));
    expect(() => decryptSecret(blob)).toThrow();
  });

  it("falls back to legacy: a no-AAD blob still reads when an AAD is passed", () => {
    // Pre-#49 ciphertext keeps decrypting even after a caller starts passing
    // AAD on the read path.
    const legacy = encryptSecret("old-value");
    expect(decryptSecret(legacy, aadWorkspaceSecret("ws-1", "k"))).toBe(
      "old-value",
    );
  });
});
