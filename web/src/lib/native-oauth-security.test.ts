import { lookup } from "node:dns/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
import {
  fetchOAuthEndpoint,
  isPublicIpAddress,
  trustedOAuthUrl,
} from "./native-oauth-security";

const allowed = ["https://app.attio.com"];
const publicRecords = [{ address: "8.8.8.8", family: 4 }];
beforeEach(() => {
  vi.mocked(lookup)
    .mockReset()
    .mockResolvedValue(publicRecords as never);
});
afterEach(() => vi.unstubAllGlobals());

describe("native OAuth URL trust checks", () => {
  it.each([
    "127.0.0.1",
    "169.254.169.254",
    "10.1.2.3",
    "192.168.0.1",
    "::1",
    "fc00::1",
    "::ffff:a9fe:a9fe",
    "::ffff:127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "::127.0.0.1",
  ])("rejects non-public IP literal %s", (ip) => {
    expect(isPublicIpAddress(ip)).toBe(false);
  });

  it("allows known public IP literals", () => {
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("requires discovered OAuth endpoints to stay on the allowed origins", async () => {
    await expect(
      trustedOAuthUrl("https://app.attio.com/oidc/token", allowed, "Token"),
    ).resolves.toMatchObject({ origin: "https://app.attio.com" });
    await expect(
      trustedOAuthUrl("https://evil.example/oidc/token", allowed, "Token"),
    ).rejects.toThrow(/allowed provider origin/);
  });

  it.each([
    "http://app.attio.com/token",
    "https://user:pass@app.attio.com/token",
    "https://169.254.169.254/token",
    "https://[::1]/token",
    "https://2130706433/token",
  ])("rejects unsafe endpoint %s before fetching", async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchOAuthEndpoint(url, [new URL(url).origin], "Token"),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects empty and mixed public/private DNS results", async () => {
    for (const records of [
      [],
      [...publicRecords, { address: "10.0.0.1", family: 4 }],
    ]) {
      vi.mocked(lookup).mockResolvedValueOnce(records as never);
      await expect(
        trustedOAuthUrl("https://app.attio.com/token", allowed, "Token"),
      ).rejects.toThrow();
    }
  });

  it("does not allow callers to follow redirects or override the secure dispatcher", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { Location: "https://127.0.0.1" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const response = await fetchOAuthEndpoint(
      "https://app.attio.com/token",
      allowed,
      "Token",
      {
        method: "POST",
        body: "code=test",
        headers: { Authorization: "Basic test" },
        redirect: "follow",
        dispatcher: "unsafe",
      } as RequestInit,
    );
    expect(response.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      redirect: "manual",
      cache: "no-store",
      method: "POST",
      body: "code=test",
    });
    expect(fetchMock.mock.calls[0][1].dispatcher).not.toBe("unsafe");
  });

  it.each([
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "::1", family: 6 }],
    [...publicRecords, { address: "169.254.169.254", family: 4 }],
    [],
  ])(
    "rejects DNS rebinding at the actual socket lookup",
    async (...records) => {
      vi.mocked(lookup)
        .mockResolvedValueOnce(publicRecords as never)
        .mockResolvedValueOnce(records as never);
      // Real Node fetch + undici dispatcher, but DNS becomes private after the
      // preflight. No socket connects to the returned private addresses.
      await expect(
        fetchOAuthEndpoint(
          "https://rebind.example.test/token",
          ["https://rebind.example.test"],
          "Token",
        ),
      ).rejects.toMatchObject({
        cause: {
          message: "OAuth endpoint resolves to a non-public IP address.",
        },
      });
      expect(lookup).toHaveBeenCalledTimes(2);
    },
  );
});
