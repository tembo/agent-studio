import { describe, expect, it } from "vitest";

import {
  parseRunEnvironmentFilter,
} from "@/lib/run-environment";

describe("run environment", () => {
  it("parses filters with a caller-selected fallback", () => {
    expect(parseRunEnvironmentFilter("development")).toBe("development");
    expect(parseRunEnvironmentFilter("all")).toBe("all");
    expect(parseRunEnvironmentFilter("invalid")).toBe("production");
    expect(parseRunEnvironmentFilter(undefined, "all")).toBe("all");
  });
});
