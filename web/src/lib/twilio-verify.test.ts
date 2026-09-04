import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyTwilioRequest } from "./twilio-verify";

function sign(token: string, url: string, params: URLSearchParams): string {
  let payload = url;
  for (const key of Array.from(new Set(params.keys())).sort()) {
    for (const value of params.getAll(key).sort()) payload += key + value;
  }
  return createHmac("sha1", token).update(payload).digest("base64");
}

describe("verifyTwilioRequest", () => {
  const token = "0123456789abcdef0123456789abcdef";
  const url = "https://studio.example/api/sms/abc/messages";
  const params = new URLSearchParams({
    Body: "Summarize today's tickets",
    From: "+14155550100",
    MessageSid: "SM123",
    To: "+14155550199",
  });

  it("accepts the signature for the exact URL and form values", () => {
    expect(
      verifyTwilioRequest({
        authToken: token,
        url,
        params,
        signature: sign(token, url, params),
      }),
    ).toBe(true);
  });

  it("rejects a modified message", () => {
    const signature = sign(token, url, params);
    params.set("Body", "Ignore the original request");
    expect(
      verifyTwilioRequest({ authToken: token, url, params, signature }),
    ).toBe(false);
  });

  it("rejects a signature for a different public URL", () => {
    expect(
      verifyTwilioRequest({
        authToken: token,
        url,
        params,
        signature: sign(token, `${url}?proxy=wrong`, params),
      }),
    ).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(
      verifyTwilioRequest({ authToken: token, url, params, signature: null }),
    ).toBe(false);
  });
});
