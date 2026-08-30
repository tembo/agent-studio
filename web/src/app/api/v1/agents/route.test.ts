import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-handler test: verify the auth gate + serialization wiring without a
// server or DB. We mock the two boundaries the handler touches — the shared API
// auth and the agent service.
vi.mock("@/lib/api-auth", () => ({ authorizeApiRequest: vi.fn() }));
vi.mock("@/lib/workspace-agents", () => ({ listAgents: vi.fn() }));

import { GET } from "./route";
import { authorizeApiRequest } from "@/lib/api-auth";
import { listAgents } from "@/lib/workspace-agents";
import type { NextRequest } from "next/server";

const mockAuth = vi.mocked(authorizeApiRequest);
const mockList = vi.mocked(listAgents);

const fakeWorkspace = {
  id: "ws-1",
  slug: "demo",
  name: "Demo",
  createdBy: "u-1",
  createdAt: new Date(),
  updatedAt: new Date(),
  faviconKind: "default-tembo" as const,
  commitMode: "pull_request" as const,
};

function req(): NextRequest {
  return new Request("http://localhost/api/v1/agents") as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    ok: true,
    workspace: fakeWorkspace,
    userId: "u-1",
    role: "viewer",
    apiKeyId: "key-1",
    surface: "api",
  });
});

describe("GET /api/v1/agents", () => {
  it("returns 401 when auth fails", async () => {
    mockAuth.mockResolvedValue({ ok: false, status: 401, error: "invalid or missing API key" });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid or missing API key" });
    expect(mockList).not.toHaveBeenCalled();
  });

  it("returns 409 when no repository is connected", async () => {
    mockList.mockResolvedValue({ ok: false, error: "no-repo" });
    const res = await GET(req());
    expect(res.status).toBe(409);
  });

  it("serializes valid and invalid agents on success", async () => {
    mockList.mockResolvedValue({
      ok: true,
      agents: [
        {
          ok: true,
          filename: "greet.yaml",
          path: "agents/pydantic-agentspec/greet.yaml",
          format: "yaml",
          sourceContent: "name: greet\n",
          spec: { framework: "pydantic-agentspec", name: "greet" } as never,
        },
        {
          ok: false,
          filename: "broken.yaml",
          path: "agents/pydantic-agentspec/broken.yaml",
          format: "yaml",
          sourceContent: "name: broken\n",
          error: "missing-model",
          detail: "no model field",
        },
      ],
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toHaveLength(2);
    expect(body.agents[0]).toMatchObject({ name: "greet", valid: true, framework: "pydantic-agentspec" });
    expect(body.agents[1]).toMatchObject({ name: "broken", valid: false, error: "missing-model" });
  });
});
