import { describe, expect, it } from "vitest";

import {
  runIdentityLabel,
  UNAVAILABLE_RUN_IDENTITY,
} from "./run-identity";

describe("runIdentityLabel", () => {
  it("prefers a display name and falls back safely", () => {
    expect(runIdentityLabel("Ada", "ada@example.com")).toBe("Ada");
    expect(runIdentityLabel(null, "ada@example.com")).toBe("ada@example.com");
    expect(runIdentityLabel(null, null)).toBe(UNAVAILABLE_RUN_IDENTITY);
    expect(runIdentityLabel("  ", "  ")).toBe(UNAVAILABLE_RUN_IDENTITY);
  });
});
