import { describe, expect, it } from "vitest";

import { runNowVersionChoice } from "./run-now-version";

describe("runNowVersionChoice", () => {
  it("offers only draft when nothing has been promoted", () => {
    expect(runNowVersionChoice({ hasDraft: true })).toBe("draft-only");
    expect(runNowVersionChoice({ hasDraft: false })).toBe("draft-only");
  });

  it("offers only stable when the live file matches the snapshot", () => {
    expect(
      runNowVersionChoice({ stableVersion: 3, hasDraft: false }),
    ).toBe("stable-only");
  });

  it("lets the operator choose when a pending draft exists", () => {
    expect(
      runNowVersionChoice({ stableVersion: 3, hasDraft: true }),
    ).toBe("choose");
  });
});
