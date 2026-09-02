import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { query: vi.fn() },
}));

import { db } from "@/lib/db";
import {
  getSignupPolicy,
  getSignupPolicyFromEnv,
  getStoredSignupPolicy,
  setSignupPolicy,
} from "./instance-settings";

const mockQuery = vi.mocked(db.query);

const ORIGINAL_POLICY = process.env.TAS_SIGNUP_POLICY;
const ORIGINAL_DOMAINS = process.env.TAS_SIGNUP_ALLOWED_DOMAINS;

beforeEach(() => {
  mockQuery.mockReset();
  delete process.env.TAS_SIGNUP_POLICY;
  delete process.env.TAS_SIGNUP_ALLOWED_DOMAINS;
});

afterEach(() => {
  process.env.TAS_SIGNUP_POLICY = ORIGINAL_POLICY;
  process.env.TAS_SIGNUP_ALLOWED_DOMAINS = ORIGINAL_DOMAINS;
});

function rows(r: unknown[]) {
  return { rows: r, rowCount: r.length } as never;
}

describe("getSignupPolicyFromEnv", () => {
  it("defaults to invite-only with no domains", () => {
    expect(getSignupPolicyFromEnv()).toEqual({
      policy: "invite_only",
      allowedDomains: [],
    });
  });

  it("accepts hyphenated env values", () => {
    process.env.TAS_SIGNUP_POLICY = "domain-allowlist";
    process.env.TAS_SIGNUP_ALLOWED_DOMAINS = "Acme.com, @corp.acme.com";
    expect(getSignupPolicyFromEnv()).toEqual({
      policy: "domain_allowlist",
      allowedDomains: ["acme.com", "corp.acme.com"],
    });
  });

  it("falls back to invite-only on unknown values", () => {
    process.env.TAS_SIGNUP_POLICY = "yes-please";
    expect(getSignupPolicyFromEnv().policy).toBe("invite_only");
  });
});

describe("getStoredSignupPolicy / getSignupPolicy", () => {
  it("returns the stored row when an admin has saved a policy", async () => {
    mockQuery.mockResolvedValue(
      rows([
        {
          signup_policy: "open",
          signup_allowed_domains: ["acme.com"],
        },
      ]),
    );
    expect(await getStoredSignupPolicy()).toEqual({
      policy: "open",
      allowedDomains: ["acme.com"],
    });
    expect(await getSignupPolicy()).toEqual({
      policy: "open",
      allowedDomains: ["acme.com"],
    });
  });

  it("falls through to env when the stored policy is null", async () => {
    process.env.TAS_SIGNUP_POLICY = "open";
    mockQuery.mockResolvedValue(
      rows([{ signup_policy: null, signup_allowed_domains: null }]),
    );
    expect(await getStoredSignupPolicy()).toEqual({
      policy: null,
      allowedDomains: [],
    });
    expect(await getSignupPolicy()).toEqual({
      policy: "open",
      allowedDomains: [],
    });
  });

  it("fails closed to invite-only when the table is missing, even if env is open", async () => {
    process.env.TAS_SIGNUP_POLICY = "open";
    mockQuery.mockRejectedValue(new Error("relation does not exist"));
    expect(await getStoredSignupPolicy()).toBeNull();
    expect(await getSignupPolicy()).toEqual({
      policy: "invite_only",
      allowedDomains: [],
    });
  });
});

describe("setSignupPolicy", () => {
  it("writes policy + domains and the acting admin", async () => {
    mockQuery.mockResolvedValue(rows([]));
    await setSignupPolicy("domain_allowlist", ["acme.com"], "user-1");
    expect(mockQuery.mock.calls[0][1]).toEqual([
      "domain_allowlist",
      ["acme.com"],
      "user-1",
    ]);
  });
});
