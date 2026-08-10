import { getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Routes that don't require a signed-in session:
//   /                — the sign-in landing
//   /mcp             — MCP server, authed by a TAS API key or OAuth token
//   /.well-known/*   — public OAuth discovery metadata for remote MCP clients
//   /for-agents      — native-MCP tool reference, authed by a signed bearer token
//   /reset-password  — admin-minted reset links; the visitor is locked out
//                      by definition, the token is validated on submit
// Everything else under the matcher (/<workspace>/…, /onboarding, /settings)
// is session-gated.
function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/mcp" ||
    pathname.startsWith("/.well-known/") ||
    pathname === "/for-agents" ||
    pathname.startsWith("/for-agents/") ||
    pathname === "/reset-password"
  );
}

// Two jobs:
//
//  1. Auth gate. Without this, a signed-out visitor following a deep link
//     (e.g. /acme/audit) reached a layout/page that gates with notFound(),
//     so they got a 404 — which reads as "broken link", not "please sign in".
//     We redirect them to the sign-in landing instead, preserving where they
//     were headed in `?next=` so they return there after signing in. This is
//     an optimistic check on the session *cookie* (no DB hit, edge-safe); the
//     layouts/actions still do the authoritative session + RBAC checks.
//
//  2. Surface the request path to server components via an `x-pathname`
//     header — Next doesn't otherwise expose the pathname to a server layout,
//     and the [workspace] layout needs it to redirect a renamed workspace's
//     old slug to its current one (e.g. /old/agents/x → /new/agents/x).
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (!isPublicPath(pathname) && !getSessionCookie(request)) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }

  const headers = new Headers(request.headers);
  headers.set("x-pathname", pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Run for app routes only; skip API routes, Next internals, and metadata
  // files. (API routes resolve workspaces themselves and don't need this.)
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
