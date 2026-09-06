export type SmsComplianceCommand = "twilio-handled" | "help";

const TWILIO_OPT_OUT_KEYWORDS = new Set([
  "CANCEL",
  "END",
  "OPTOUT",
  "QUIT",
  "REVOKE",
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
]);
const TWILIO_OPT_IN_KEYWORDS = new Set(["START", "UNSTOP"]);
const ADVANCED_OPT_OUT_TYPES = new Set(["HELP", "START", "STOP"]);

/**
 * Keeps Twilio compliance keywords out of agent routing. An OptOutType means
 * Advanced Opt-Out has already replied, so returning another message would
 * produce a duplicate response.
 */
export function getSmsComplianceCommand(
  body: string,
  optOutType: string | null,
): SmsComplianceCommand | null {
  const providerType = optOutType?.trim().toUpperCase() ?? "";
  if (ADVANCED_OPT_OUT_TYPES.has(providerType)) return "twilio-handled";

  const keyword = body.trim().toUpperCase();
  if (
    TWILIO_OPT_OUT_KEYWORDS.has(keyword) ||
    TWILIO_OPT_IN_KEYWORDS.has(keyword)
  ) {
    return "twilio-handled";
  }
  return keyword === "HELP" ? "help" : null;
}

export const SMS_HELP_MESSAGE =
  "Tembo Agent Studio: Text AGENTS for agent list. Help: tembo.io. Request replies only. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.";
