import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/composio-connections", () => ({
  listConnectionsForUser: vi.fn(async () => []),
}));
vi.mock("@/lib/connections", () => ({
  listNativeConnectionsForUser: vi.fn(async () => []),
}));
vi.mock("@/lib/secret-connections", () => ({
  listSecretConnections: vi.fn(async () => []),
}));

import {
  findMissingConnections,
  missingConnectionsMessage,
} from "./connection-checks";
import { listNativeConnectionsForUser } from "@/lib/connections";

const mockNative = vi.mocked(listNativeConnectionsForUser);

// Only the fields findMissingConnections reads.
function nativeRow(
  type: string,
  name: string,
  status = "active",
  refreshErrorMessage: string | null = null,
) {
  return { type, name, status, refreshErrorMessage } as Awaited<
    ReturnType<typeof listNativeConnectionsForUser>
  >[number];
}
const declare = (toolkit: string, name: string) => [
  { toolkit, name, source: "native-mcp" as const },
];

describe("findMissingConnections — native single-connection slot fallback", () => {
  beforeEach(() => mockNative.mockReset());

  it("exact slot match is not missing", async () => {
    mockNative.mockResolvedValue([nativeRow("pylon", "tembo")]);
    expect(await findMissingConnections("w", "u", declare("pylon", "tembo"))).toEqual([]);
  });

  it("slot-name mismatch with exactly ONE connection falls back (not missing)", async () => {
    mockNative.mockResolvedValue([nativeRow("pylon", "tembo")]);
    // agent pins `default`, user only has `tembo` → use it
    expect(await findMissingConnections("w", "u", declare("pylon", "default"))).toEqual([]);
  });

  it("slot-name mismatch with TWO connections is ambiguous (missing)", async () => {
    mockNative.mockResolvedValue([
      nativeRow("pylon", "tembo"),
      nativeRow("pylon", "work"),
    ]);
    const missing = await findMissingConnections("w", "u", declare("pylon", "default"));
    expect(missing.map((m) => m.toolkit)).toEqual(["pylon"]);
  });

  it("no connection for the provider is missing", async () => {
    mockNative.mockResolvedValue([]);
    const missing = await findMissingConnections("w", "u", declare("pylon", "default"));
    expect(missing.map((m) => m.toolkit)).toEqual(["pylon"]);
  });

  it("a non-active sole connection does not satisfy the fallback", async () => {
    mockNative.mockResolvedValue([nativeRow("pylon", "tembo", "stale")]);
    const missing = await findMissingConnections("w", "u", declare("pylon", "default"));
    expect(missing.map((m) => m.toolkit)).toEqual(["pylon"]);
  });

  it("surfaces the saved refresh reason and reconnect action before a run", async () => {
    mockNative.mockResolvedValue([
      nativeRow(
        "pylon",
        "tembo",
        "revoked",
        "The authorization was revoked or expired. Reconnect this account.",
      ),
    ]);

    const missing = await findMissingConnections(
      "w",
      "u",
      declare("pylon", "default"),
    );

    expect(missingConnectionsMessage(missing, true)).toBe(
      "Your connection needs attention: Pylon. The authorization was revoked or expired. Reconnect this account. Then run again.",
    );
  });
});
