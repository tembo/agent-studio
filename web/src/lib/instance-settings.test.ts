import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { query: vi.fn() },
}));

import { db } from "@/lib/db";
import {
  getRunQueueSettings,
  getRunQueueSettingsFromEnv,
  getSignupPolicy,
  getSignupPolicyFromEnv,
  getStoredRunQueueSettings,
  getStoredSignupPolicy,
  setRunQueueSettings,
  setSignupPolicy,
} from "./instance-settings";

const mockQuery = vi.mocked(db.query);

const ORIGINAL_POLICY = process.env.TAS_SIGNUP_POLICY;
const ORIGINAL_DOMAINS = process.env.TAS_SIGNUP_ALLOWED_DOMAINS;
const ORIGINAL_MAX_RUNS = process.env.API_MAX_CONCURRENT_RUNS;
const ORIGINAL_MAX_SUBS = process.env.API_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR;

beforeEach(() => {
  mockQuery.mockReset();
  delete process.env.TAS_SIGNUP_POLICY;
  delete process.env.TAS_SIGNUP_ALLOWED_DOMAINS;
  delete process.env.API_MAX_CONCURRENT_RUNS;
  delete process.env.API_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR;
});

afterEach(() => {
  process.env.TAS_SIGNUP_POLICY = ORIGINAL_POLICY;
  process.env.TAS_SIGNUP_ALLOWED_DOMAINS = ORIGINAL_DOMAINS;
  process.env.API_MAX_CONCURRENT_RUNS = ORIGINAL_MAX_RUNS;
  process.env.API_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR = ORIGINAL_MAX_SUBS;
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

describe("run queue settings", () => {
  it("defaults to ten concurrent runs and three sub-agents", () => {
    expect(getRunQueueSettingsFromEnv()).toEqual({
      maxConcurrentRuns: 10,
      maxSubAgentsPerOrchestrator: 3,
    });
  });

  it("reads env fallbacks", () => {
    process.env.API_MAX_CONCURRENT_RUNS = "8";
    process.env.API_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR = "2";
    expect(getRunQueueSettingsFromEnv()).toEqual({
      maxConcurrentRuns: 8,
      maxSubAgentsPerOrchestrator: 2,
    });
  });

  it("prefers stored values over env", async () => {
    process.env.API_MAX_CONCURRENT_RUNS = "4";
    mockQuery.mockResolvedValue(
      rows([
        {
          max_concurrent_runs: 10,
          max_sub_agents_per_orchestrator: 3,
        },
      ]),
    );
    expect(await getStoredRunQueueSettings()).toEqual({
      maxConcurrentRuns: 10,
      maxSubAgentsPerOrchestrator: 3,
    });
    expect(await getRunQueueSettings()).toEqual({
      maxConcurrentRuns: 10,
      maxSubAgentsPerOrchestrator: 3,
    });
  });

  it("falls through to env when stored values are null", async () => {
    process.env.API_MAX_CONCURRENT_RUNS = "6";
    mockQuery.mockResolvedValue(
      rows([
        {
          max_concurrent_runs: null,
          max_sub_agents_per_orchestrator: null,
        },
      ]),
    );
    expect(await getRunQueueSettings()).toEqual({
      maxConcurrentRuns: 6,
      maxSubAgentsPerOrchestrator: 3,
    });
  });

  it("writes both limits and the acting admin", async () => {
    mockQuery.mockResolvedValue(rows([]));
    await setRunQueueSettings(
      { maxConcurrentRuns: 10, maxSubAgentsPerOrchestrator: 3 },
      "user-1",
    );
    expect(mockQuery.mock.calls[0][1]).toEqual([10, 3, "user-1"]);
  });
});
