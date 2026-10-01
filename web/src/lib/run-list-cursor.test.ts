import { describe, expect, it } from "vitest";
import { decodeRunCursor, encodeRunCursor } from "./run-list-cursor";

const id = "00000000-0000-0000-0000-000000000001";
describe("run cursor", () => {
  it("preserves all six fractional digits", () => {
    const createdAt = "2026-10-01T12:00:00.123456";
    expect(decodeRunCursor(encodeRunCursor(createdAt, id))).toEqual({ createdAt, id });
  });
  it.each([
    "", "junk", "a".repeat(257),
    encodeRunCursor("2026-02-31T12:00:00.000000", id),
    encodeRunCursor("2026-10-01T12:00:00.123", id),
    encodeRunCursor("2026-10-01T12:00:00.123456", "not-a-uuid"),
    Buffer.from(JSON.stringify([{}, id])).toString("base64url"),
  ])("rejects malformed cursors: %s", (cursor) => {
    expect(() => decodeRunCursor(cursor)).toThrow("Invalid run cursor");
  });
});
