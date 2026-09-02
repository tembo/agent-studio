import { NextResponse, type NextRequest } from "next/server";

import { authorizeApiRequest } from "@/lib/api-auth";
import { requestAgentChange } from "@/lib/api-v1/actions";
import { apiError, authErrorResponse } from "@/lib/api-v1/http";
import { FRAMEWORKS, type Framework } from "@/lib/agent-framework";

// POST /api/v1/agent-changes — hand an authoring request to the Tembo Coding
// Agent, which opens a PR (or commits directly, per the workspace's commit
// mode). Body:
//   - edit:   { agent: "<name>", description }
//   - create: { name: "<display name>", framework?, description }
// Returns { task_id, html_url, status, kind, agent_path }. Min role operator.
//
// Note: this is for MCP clients that aren't themselves coding agents. When the
// caller IS Claude Code, editing the YAML locally + committing is usually the
// better path — this just exposes the in-app "describe a change" button.

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authorizeApiRequest(request, "operator");
  if (!auth.ok) return authErrorResponse(auth);

  let body: {
    agent?: unknown;
    name?: unknown;
    framework?: unknown;
    description?: unknown;
    includeEvals?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return apiError(400, "request body must be JSON");
  }
  if (typeof body.description !== "string" || !body.description.trim()) {
    return apiError(400, "`description` (string) is required");
  }
  let framework: Framework | undefined;
  if (typeof body.framework === "string") {
    if (!(FRAMEWORKS as readonly string[]).includes(body.framework)) {
      return apiError(400, `unknown framework "${body.framework}"`);
    }
    framework = body.framework as Framework;
  }

  const result = await requestAgentChange(auth, {
    agent: typeof body.agent === "string" ? body.agent : undefined,
    name: typeof body.name === "string" ? body.name : undefined,
    framework,
    description: body.description,
    includeEvals: body.includeEvals === false ? false : true,
  });
  if (!result.ok) return apiError(result.status, result.error);

  const r = result.result;
  return NextResponse.json(
    {
      task_id: r.taskId,
      html_url: r.htmlUrl,
      status: r.status,
      kind: r.kind,
      agent_path: r.agentPath,
      improvement_id: r.improvementId,
    },
    { status: 202 },
  );
}
