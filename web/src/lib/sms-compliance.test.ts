import { describe, expect, it } from "vitest";

import { getSmsComplianceCommand, SMS_HELP_MESSAGE } from "./sms-compliance";

describe("getSmsComplianceCommand", () => {
  it.each([
    "CANCEL",
    "END",
    "OPTOUT",
    "QUIT",
    "REVOKE",
    "STOP",
    "stop",
    "STOPALL",
    " unsubscribe ",
  ])(
    "reserves Twilio opt-out keyword %s",
    (body) => {
      expect(getSmsComplianceCommand(body, null)).toBe("twilio-handled");
    },
  );

  it.each(["START", "unstop"])("reserves Twilio opt-in keyword %s", (body) => {
    expect(getSmsComplianceCommand(body, null)).toBe("twilio-handled");
  });

  it("provides HELP when Twilio has not already handled it", () => {
    expect(getSmsComplianceCommand(" help ", null)).toBe("help");
  });

  it.each(["STOP", "START", "HELP"])(
    "does not duplicate an Advanced Opt-Out %s response",
    (optOutType) => {
      expect(getSmsComplianceCommand("ignored", optOutType)).toBe(
        "twilio-handled",
      );
    },
  );

  it("matches only an entire keyword", () => {
    expect(getSmsComplianceCommand("help with ticket 42", null)).toBeNull();
    expect(getSmsComplianceCommand("stop agent", null)).toBeNull();
  });

  it("keeps the fallback HELP response within one SMS segment", () => {
    expect(SMS_HELP_MESSAGE.length).toBeLessThanOrEqual(160);
  });
});
