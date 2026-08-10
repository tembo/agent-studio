import { auth } from "@/lib/auth";
import { selectMcpOAuthWorkspace } from "@/lib/mcp-oauth-selection";

export async function POST(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "Sign in to continue." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const workspaceId =
    body && typeof body === "object" && "workspaceId" in body
      ? (body as { workspaceId?: unknown }).workspaceId
      : null;
  if (typeof workspaceId !== "string" || !workspaceId) {
    return Response.json({ error: "Select a workspace." }, { status: 400 });
  }

  const selected = await selectMcpOAuthWorkspace({
    sessionId: session.session.id,
    userId: session.user.id,
    workspaceId,
  });
  if (!selected) {
    return Response.json(
      { error: "You are not a member of that workspace." },
      { status: 403 },
    );
  }
  return Response.json({ ok: true });
}

