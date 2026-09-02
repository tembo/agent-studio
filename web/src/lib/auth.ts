import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { genericOAuth, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { Pool } from "pg";

import { resolveAuthSecret } from "@/lib/auth-secret";
import { genericOAuthConfigs, emailPasswordEnabled } from "@/lib/auth-providers";
import { writeAuditEvent } from "@/lib/audit-db";
import { getPublicOrigin } from "@/lib/config";
import { isInstanceAdmin } from "@/lib/instance-admins";
import { getSignupPolicy } from "@/lib/instance-settings";
import {
  hasPendingInvite,
  resolvePendingInvitesForUser,
} from "@/lib/invitations";
import {
  isSignupAllowed,
  signupRejectionMessage,
} from "@/lib/signup-policy";
import { listWorkspacesForUser } from "@/lib/workspace";
import {
  hasMcpOAuthScope,
  MCP_OAUTH_SCOPES,
  MCP_OAUTH_WORKSPACE_CLAIM,
  mcpOAuthIssuer,
  mcpOAuthResource,
} from "@/lib/mcp-oauth";
import { getMcpOAuthWorkspaceSelection } from "@/lib/mcp-oauth-selection";

// We intentionally do not throw on missing env at module load time:
// Next.js evaluates this file during `next build` to collect page data,
// and the build environment legitimately has no DATABASE_URL. Misconfigured
// runtimes will fail loudly on the first request instead.
const databaseUrl = process.env.DATABASE_URL ?? "postgres://placeholder";
// Never fall back to a usable default secret: a missing/placeholder secret
// at runtime would let anyone with the (public) repo forge sessions.
const secret = resolveAuthSecret();
const publicOrigin = getPublicOrigin();

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

// Microsoft (Entra ID) + generic OIDC both run through the genericOAuth
// plugin; Google stays a built-in social provider below.
const oauthConfigs = genericOAuthConfigs();

export const auth = betterAuth({
  database: new Pool({ connectionString: databaseUrl }),
  secret,
  baseURL: publicOrigin,
  disabledPaths: ["/token"],
  // Zero-config quickstart: email + password auto-enables when no OAuth provider
  // is configured (see emailPasswordEnabled). The sign-up policy below still
  // governs who may create an account. No email verification — keep first-run
  // SMTP-free; configure an OAuth provider for production.
  emailAndPassword: emailPasswordEnabled()
    ? {
        enabled: true,
        requireEmailVerification: false,
        autoSignIn: true,
        // Reset links are admin-minted (lib/password-reset.ts) and often
        // follow a lockout or leak — kill existing sessions on reset.
        revokeSessionsOnPasswordReset: true,
      }
    : { enabled: false },
  socialProviders:
    googleClientId && googleClientSecret
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
          },
        }
      : undefined,
  plugins: [
    jwt({
      jwt: {
        issuer: mcpOAuthIssuer(),
        audience: mcpOAuthResource(),
      },
    }),
    oauthProvider({
      loginPage: "/",
      consentPage: "/oauth/consent",
      scopes: [...MCP_OAUTH_SCOPES],
      resources: [mcpOAuthResource()],
      enforcePerClientResources: false,
      clientRegistrationDefaultResources: [mcpOAuthResource()],
      clientRegistrationAllowedResources: [mcpOAuthResource()],
      grantTypes: ["authorization_code", "refresh_token"],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      silenceWarnings: { oauthAuthServerConfig: true },
      clientRegistrationDefaultScopes: [...MCP_OAUTH_SCOPES],
      clientRegistrationAllowedScopes: [...MCP_OAUTH_SCOPES],
      postLogin: {
        // The plugin exposes consentReferenceId through postLogin, but TAS does
        // the workspace choice on the consent screen itself. Never insert an
        // extra post-login redirect: oauth-provider 1.6.25 cannot clear that
        // continuation reliably and loops back to the selection page.
        page: "/oauth/consent",
        shouldRedirect: async () => false,
        consentReferenceId: async ({ user, session, scopes }) => {
          if (!hasMcpOAuthScope(scopes)) return undefined;
          return (
            (await getMcpOAuthWorkspaceSelection(session.id, user.id)) ??
            undefined
          );
        },
      },
      customAccessTokenClaims: ({ user, referenceId }) => {
        if (!user || !referenceId) {
          throw new APIError("BAD_REQUEST", {
            message: "MCP access tokens must be bound to a TAS workspace.",
          });
        }
        return { [MCP_OAUTH_WORKSPACE_CLAIM]: referenceId };
      },
    }),
    ...(oauthConfigs.length > 0
      ? [genericOAuth({ config: oauthConfigs })]
      : []),
  ],
  // Sign-up gate. Policy (invite-only / domain allowlist / open) lives in
  // instance_settings with an env fallback; default is invite-only so
  // existing instances stay closed. Instance admins and pending invites
  // always pass. Existing users (already have an account) are unaffected.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Bootstrap path: don't depend on instance_settings being
          // readable yet — an env-listed admin must always get in.
          if (await isInstanceAdmin(user.email)) {
            return { data: user };
          }
          const [{ policy, allowedDomains }, hasInvite] = await Promise.all([
            getSignupPolicy(),
            hasPendingInvite(user.email),
          ]);
          const allowed = isSignupAllowed({
            policy,
            allowedDomains,
            email: user.email,
            emailVerified: Boolean(
              (user as { emailVerified?: boolean }).emailVerified,
            ),
            isAdmin: false,
            hasInvite,
          });
          if (!allowed) {
            throw new APIError("FORBIDDEN", {
              message: signupRejectionMessage(policy),
            });
          }
          return { data: user };
        },
        // First sign-in: turn pending invites into memberships so the
        // user lands straight in their workspace(s).
        after: async (user) => {
          if (!user.email) return;
          try {
            await resolvePendingInvitesForUser(user.id, user.email);
          } catch (e) {
            console.error("[invites] resolve on signup failed:", e);
          }
        },
      },
    },
    // Audit sign-ins. A session is created on every successful login (the
    // OAuth/OIDC callback), so this is our login event. The audit log is
    // workspace-scoped (audit_event.workspace_id is NOT NULL), so we write one
    // `auth.login` per workspace the user belongs to — each workspace's
    // timeline then shows when its members signed in. Best-effort: never let an
    // audit write block a login.
    //
    // Not covered here: logout (better-auth exposes no session-delete database
    // hook in this version) and rejected sign-ups (the `user.create.before`
    // gate above throws, but a rejected user has no workspace to attribute
    // the event to).
    session: {
      create: {
        after: async (session) => {
          try {
            const workspaces = await listWorkspacesForUser(session.userId);
            await Promise.all(
              workspaces.map((w) =>
                writeAuditEvent({
                  workspaceId: w.id,
                  actorUserId: session.userId,
                  source: "human_action",
                  kind: "auth.login",
                  targetType: "user",
                  targetId: session.userId,
                  agentName: null,
                  payload: {
                    ipAddress: session.ipAddress ?? null,
                    userAgent: session.userAgent ?? null,
                  },
                }),
              ),
            );
          } catch (e) {
            console.error("[audit] auth.login write failed:", e);
          }
        },
      },
    },
  },
});
