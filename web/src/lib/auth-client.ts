import { createAuthClient } from "better-auth/react";
import { genericOAuthClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

export const authClient = createAuthClient({
  // genericOAuth (Microsoft Entra + generic OIDC) → signIn.oauth2().
  // oauthProviderClient forwards the signed OAuth query through login,
  // workspace selection, and consent without storing it in application state.
  plugins: [oauthProviderClient(), genericOAuthClient()],
  // Resolve the base URL from the browser's actual origin at runtime.
  // The auth API (`/api/auth/*`) is always same-origin as the app, so the
  // current origin is correct for any deploy. We can't rely on
  // NEXT_PUBLIC_BETTER_AUTH_URL: it's inlined at build time, so a prebuilt
  // image (GHCR) bakes the wrong/localhost value and ignores the runtime
  // env. The build-time env is only a fallback for SSR module eval, where
  // the value is never used for an actual request.
  baseURL:
    typeof window !== "undefined"
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:3000"),
});
