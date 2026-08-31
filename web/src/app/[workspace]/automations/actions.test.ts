import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("@/lib/audit-db", () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock("@/lib/auth-server", () => ({
  authorizeWorkspace: vi.fn(),
  DENIED_MESSAGE: "You don't have permission to do that.",
}));

vi.mock("@/lib/automations-api", () => ({
  createAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  getAutomation: vi.fn(),
  updateAutomation: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  userIsMember: vi.fn(),
}));

vi.mock("@/lib/workspace-agents", () => ({
  getAgentByName: vi.fn(),
}));

import {
  createAutomationAction,
  updateAutomationAction,
} from "./actions";
import {
  createAutomation,
  getAutomation,
  updateAutomation,
} from "@/lib/automations-api";
import { authorizeWorkspace } from "@/lib/auth-server";
import { userIsMember } from "@/lib/workspace";
import { getAgentByName } from "@/lib/workspace-agents";

const mockAuthorizeWorkspace = vi.mocked(authorizeWorkspace);
const mockCreateAutomation = vi.mocked(createAutomation);
const mockGetAutomation = vi.mocked(getAutomation);
const mockUpdateAutomation = vi.mocked(updateAutomation);
const mockUserIsMember = vi.mocked(userIsMember);
const mockGetAgentByName = vi.mocked(getAgentByName);

const workspace = {
  id: "ws-1",
  slug: "demo",
  name: "Demo",
  createdBy: "creator",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  faviconKind: "default-tembo" as const,
  commitMode: "pull_request" as const,
};

const existingAutomation = {
  id: "automation-1",
  workspaceId: workspace.id,
  name: "Nightly run",
  agentName: "agent",
  cron: "0 0 * * *",
  inputMessage: "Run",
  enabled: true,
  lastFiredAt: null,
  lastFireError: null,
  lastFireEventId: null,
  createdBy: "creator",
  createdByName: null,
  createdByEmail: null,
  ownerUserId: "current-owner",
  ownerUserName: null,
  ownerUserEmail: null,
  useDraft: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function automationForm(overrides: Record<string, string> = {}) {
  const formData = new FormData();
  const values = {
    workspace: workspace.slug,
    name: "Nightly run",
    agent: "agent",
    cron: "0 0 * * *",
    input_message: "Run",
    owner_user_id: "current-owner",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }
  formData.set("enabled", "on");
  return formData;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthorizeWorkspace.mockResolvedValue({
    ok: true,
    workspace,
    userId: "creator",
    role: "operator",
  });
  mockGetAgentByName.mockResolvedValue({
    agent: { ok: true, spec: { name: "agent" } },
    raw: "",
  } as unknown as Awaited<ReturnType<typeof getAgentByName>>);
});

describe("automation owner validation", () => {
  it("rejects create when owner_user_id is not a workspace member", async () => {
    mockUserIsMember.mockResolvedValue(false);

    const result = await createAutomationAction(
      {},
      automationForm({ owner_user_id: "victim-user" }),
    );

    expect(result.error).toMatch(/workspace member/);
    expect(mockUserIsMember).toHaveBeenCalledWith(workspace.id, "victim-user");
    expect(mockCreateAutomation).not.toHaveBeenCalled();
  });

  it("rejects update when owner_user_id is not a workspace member", async () => {
    mockGetAutomation.mockResolvedValue(existingAutomation);
    mockUserIsMember.mockResolvedValue(false);

    const formData = automationForm({
      id: existingAutomation.id,
      owner_user_id: "victim-user",
    });

    const result = await updateAutomationAction({}, formData);

    expect(result.error).toMatch(/workspace member/);
    expect(mockUserIsMember).toHaveBeenCalledWith(workspace.id, "victim-user");
    expect(mockUpdateAutomation).not.toHaveBeenCalled();
  });
});
