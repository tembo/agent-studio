import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Twilio's X-Twilio-Signature for a form-encoded webhook. Twilio signs
 * the exact configured URL followed by every POST parameter in sorted order.
 */
export function verifyTwilioRequest(args: {
  authToken: string;
  url: string;
  params: URLSearchParams;
  signature: string | null;
}): boolean {
  if (!args.signature) return false;

  let payload = args.url;
  const keys = Array.from(new Set(args.params.keys())).sort();
  for (const key of keys) {
    for (const value of args.params.getAll(key).sort()) {
      payload += key + value;
    }
  }

  const expected = createHmac("sha1", args.authToken)
    .update(payload, "utf8")
    .digest("base64");
  const actualBytes = Buffer.from(args.signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}
