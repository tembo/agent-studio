import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "./route";

const ORIGINAL_BETTER_AUTH_URL = process.env.BETTER_AUTH_URL;

afterEach(() => {
  process.env.BETTER_AUTH_URL = ORIGINAL_BETTER_AUTH_URL;
});

describe("legacy generic OAuth callback", () => {
  it("forwards to the Better Auth 1.7 callback on the public origin", async () => {
    process.env.BETTER_AUTH_URL = "https://tas.example.com";
    const request = new NextRequest(
      "http://0.0.0.0:3000/api/auth/oauth2/callback/microsoft?code=abc&state=xyz",
    );

    const response = await GET(request, {
      params: Promise.resolve({ provider: "microsoft" }),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://tas.example.com/api/auth/callback/microsoft?code=abc&state=xyz",
    );
  });
});
