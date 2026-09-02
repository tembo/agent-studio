import { describe, expect, it } from "vitest";

import {
  domainMatches,
  emailDomain,
  formatAllowedDomains,
  isSignupAllowed,
  isSignupPolicy,
  parseAllowedDomains,
  signupRejectionMessage,
  type SignupGateInput,
} from "./signup-policy";

describe("isSignupPolicy", () => {
  it("accepts the three stored values", () => {
    expect(isSignupPolicy("invite_only")).toBe(true);
    expect(isSignupPolicy("domain_allowlist")).toBe(true);
    expect(isSignupPolicy("open")).toBe(true);
  });

  it("rejects unknown / hyphenated / empty values", () => {
    expect(isSignupPolicy("invite-only")).toBe(false);
    expect(isSignupPolicy("")).toBe(false);
    expect(isSignupPolicy(null)).toBe(false);
    expect(isSignupPolicy("OPEN")).toBe(false);
  });
});

describe("parseAllowedDomains", () => {
  it("splits, lowercases, strips @, and dedupes", () => {
    expect(parseAllowedDomains("@Acme.COM, acme.com corp.acme.com")).toEqual([
      "acme.com",
      "corp.acme.com",
    ]);
  });

  it("accepts an already-parsed array", () => {
    expect(parseAllowedDomains(["Acme.com", "@corp.acme.com."])).toEqual([
      "acme.com",
      "corp.acme.com",
    ]);
  });

  it("drops empty, single-label, and junk tokens", () => {
    expect(
      parseAllowedDomains("localhost, http://acme.com, acme.com/path, , ."),
    ).toEqual([]);
  });

  it("treats null/undefined as empty", () => {
    expect(parseAllowedDomains(null)).toEqual([]);
    expect(parseAllowedDomains(undefined)).toEqual([]);
  });
});

describe("emailDomain / domainMatches", () => {
  it("extracts the host after the last @", () => {
    expect(emailDomain("Ada@Acme.COM")).toBe("acme.com");
    expect(emailDomain("a@b@c.example")).toBe("c.example");
    expect(emailDomain("no-at")).toBe(null);
    expect(emailDomain("@acme.com")).toBe(null);
    expect(emailDomain("ada@")).toBe(null);
  });

  it("matches exactly, not parent domains", () => {
    expect(domainMatches("ada@acme.com", ["acme.com"])).toBe(true);
    expect(domainMatches("ada@corp.acme.com", ["acme.com"])).toBe(false);
    expect(domainMatches("ada@acme.com", ["corp.acme.com"])).toBe(false);
  });
});

describe("formatAllowedDomains", () => {
  it("joins with a comma-space for the settings field", () => {
    expect(formatAllowedDomains(["acme.com", "acme.co.uk"])).toBe(
      "acme.com, acme.co.uk",
    );
  });
});

const base: SignupGateInput = {
  policy: "invite_only",
  allowedDomains: ["acme.com"],
  email: "ada@acme.com",
  emailVerified: true,
  isAdmin: false,
  hasInvite: false,
};

describe("isSignupAllowed", () => {
  it("always allows instance admins, even invite-only", () => {
    expect(isSignupAllowed({ ...base, isAdmin: true, emailVerified: false })).toBe(
      true,
    );
  });

  it("always allows a pending invite, even outside the allowlist", () => {
    expect(
      isSignupAllowed({
        ...base,
        policy: "domain_allowlist",
        email: "contractor@other.com",
        hasInvite: true,
      }),
    ).toBe(true);
  });

  it("invite-only rejects everyone else", () => {
    expect(isSignupAllowed(base)).toBe(false);
    expect(
      isSignupAllowed({ ...base, emailVerified: true, policy: "invite_only" }),
    ).toBe(false);
  });

  it("open allows any email, verified or not", () => {
    expect(
      isSignupAllowed({ ...base, policy: "open", emailVerified: false }),
    ).toBe(true);
    expect(isSignupAllowed({ ...base, policy: "open", email: "  " })).toBe(
      false,
    );
    expect(isSignupAllowed({ ...base, policy: "open", email: null })).toBe(
      false,
    );
  });

  it("domain allowlist requires a verified matching email", () => {
    expect(
      isSignupAllowed({ ...base, policy: "domain_allowlist", emailVerified: true }),
    ).toBe(true);
    expect(
      isSignupAllowed({
        ...base,
        policy: "domain_allowlist",
        emailVerified: false,
      }),
    ).toBe(false);
    expect(
      isSignupAllowed({
        ...base,
        policy: "domain_allowlist",
        email: "ada@other.com",
        emailVerified: true,
      }),
    ).toBe(false);
    expect(
      isSignupAllowed({
        ...base,
        policy: "domain_allowlist",
        allowedDomains: [],
        emailVerified: true,
      }),
    ).toBe(false);
  });
});

describe("signupRejectionMessage", () => {
  it("keeps the invite-only copy operators already know", () => {
    expect(signupRejectionMessage("invite_only")).toMatch(/invite-only/i);
  });

  it("explains the domain gate without claiming invite-only", () => {
    const msg = signupRejectionMessage("domain_allowlist");
    expect(msg).toMatch(/allowed email domains/i);
    expect(msg).not.toMatch(/invite-only/i);
  });
});
