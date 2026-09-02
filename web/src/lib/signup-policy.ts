// Sign-up policy: who may create an account on this instance.
// Pure helpers — no DB, no env — so the gate, the settings form, and
// tests share one definition. Persistence + env fallback live in
// lib/instance-settings.ts; the account-creation hook in lib/auth.ts
// is the only enforcer.

export const SIGNUP_POLICIES = [
  "invite_only",
  "domain_allowlist",
  "open",
] as const;

export type SignupPolicy = (typeof SIGNUP_POLICIES)[number];

export type SignupPolicyConfig = {
  policy: SignupPolicy;
  allowedDomains: string[];
};

export const SIGNUP_POLICY_LABELS: Record<SignupPolicy, string> = {
  invite_only: "Invite-only",
  domain_allowlist: "Email-domain allowlist",
  open: "Open",
};

export const SIGNUP_POLICY_DESCRIPTIONS: Record<SignupPolicy, string> = {
  invite_only:
    "Only instance admins and people with a pending workspace invite can create an account.",
  domain_allowlist:
    "Anyone with a verified email at an allowed domain can self-join. Invites and instance admins still work.",
  open: "Anyone who can authenticate may create an account. Workspace membership is still invite-only.",
};

export function isSignupPolicy(value: unknown): value is SignupPolicy {
  return (
    typeof value === "string" &&
    (SIGNUP_POLICIES as readonly string[]).includes(value)
  );
}

/** Normalize env/form/DB domain lists to lowercase hostnames without `@`. */
export function parseAllowedDomains(
  raw: string | string[] | null | undefined,
): string[] {
  const parts = Array.isArray(raw) ? raw : (raw ?? "").split(/[,\s]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const domain = normalizeDomain(part);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}

export function formatAllowedDomains(domains: string[]): string {
  return domains.join(", ");
}

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  return trimmed.slice(at + 1).trim().toLowerCase() || null;
}

/** Exact hostname match (case-insensitive). `foo.acme.com` does not match `acme.com`. */
export function domainMatches(
  email: string | null | undefined,
  allowed: string[],
): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  return allowed.includes(domain);
}

export function signupRejectionMessage(policy: SignupPolicy): string {
  switch (policy) {
    case "domain_allowlist":
      return "This instance only allows accounts from allowed email domains. Use a verified work email, or ask an admin to invite you.";
    case "open":
      return "Sign-in didn't provide an email address. Use a provider that shares your email, or ask an admin to invite you.";
    case "invite_only":
      return "This instance is invite-only. Ask an admin to invite your email.";
  }
}

export type SignupGateInput = {
  policy: SignupPolicy;
  allowedDomains: string[];
  email: string | null | undefined;
  emailVerified: boolean;
  isAdmin: boolean;
  hasInvite: boolean;
};

/**
 * Who may create an account. Instance admins and pending invites always
 * pass (bootstrap + explicit grants). Domain allowlist matches only a
 * *verified* email domain — unverified assertions (email/password, or an
 * IdP that didn't set `email_verified`) cannot self-join.
 */
export function isSignupAllowed(input: SignupGateInput): boolean {
  if (input.isAdmin) return true;
  if (input.hasInvite) return true;
  switch (input.policy) {
    case "open":
      return Boolean(input.email?.trim());
    case "domain_allowlist":
      return (
        Boolean(input.email?.trim()) &&
        input.emailVerified &&
        domainMatches(input.email, input.allowedDomains)
      );
    case "invite_only":
      return false;
  }
}

function normalizeDomain(raw: string): string | null {
  let domain = raw.trim().toLowerCase();
  if (domain.startsWith("@")) domain = domain.slice(1);
  if (domain.endsWith(".")) domain = domain.slice(0, -1);
  if (!domain) return null;
  // At least two labels (example.com). No scheme, path, or port.
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      domain,
    )
  ) {
    return null;
  }
  return domain;
}
