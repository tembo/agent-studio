import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
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
  listAutomationsForAgent: vi.fn(),
}));

vi.mock("@/lib/cap-api", () => ({
  buildCreateAgentPrompt: vi.fn(),
  createTemboTask: vi.fn(),
}));

vi.mock("@/lib/prompt-connections", () => ({
  buildPromptConnectionContext: vi.fn(),
}));

vi.mock("@/lib/improvements-api", () => ({
  createImprovement: vi.fn(),
  getImprovement: vi.fn(),
  improvementMarker: vi.fn(),
  setImprovementCommitted: vi.fn(),
  setImprovementTask: vi.fn(),
}));

vi.mock("@/lib/workspace-agents", () => ({
  getAgentByName: vi.fn(),
}));

vi.mock("@/lib/tembo-credentials", () => ({
  resolveTemboCredential: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  getWorkspaceRepo: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { writeAuditEvent } from "@/lib/audit-db";
import {
  createAutomation,
  listAutomationsForAgent,
} from "@/lib/automations-api";
import { authorizeWorkspace } from "@/lib/auth-server";
import { getImprovement } from "@/lib/improvements-api";

import { createSuggestedAutomationAction } from "./actions";

const mockAuthorizeWorkspace = vi.mocked(authorizeWorkspace);
const mockCreateAutomation = vi.mocked(createAutomation);
const mockGetImprovement = vi.mocked(getImprovement);
const mockListAutomationsForAgent = vi.mocked(listAutomationsForAgent);
const mockRevalidatePath = vi.mocked(revalidatePath);
const mockWriteAuditEvent = vi.mocked(writeAuditEvent);

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

const improvement = {
  id: "improvement-1",
  workspaceId: workspace.id,
  runId: null,
  agentName: "daily-pipeline-digest",
  agentPath: "agents/pydantic-agentspec/daily-pipeline-digest.yaml",
  improvementText:
    "Summarize pipeline activity every weekday at 9am and send the digest.",
  kind: "create" as const,
  source: "chat" as const,
  temboTaskId: "task-1",
  temboTaskHtmlUrl: "https://app.tembo.io/tasks/task-1",
  prUrl: null,
  prNumber: null,
  prState: null,
  status: "submitted" as const,
  delivery: "pull_request" as const,
  commitSha: null,
  commitUrl: null,
  createdBy: "creator",
  createdByName: null,
  createdByEmail: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const automation = {
  id: "automation-1",
  workspaceId: workspace.id,
  name: "daily-pipeline-digest schedule",
  agentName: improvement.agentName,
  cron: "0 9 * * 1-5",
  inputMessage: "",
  enabled: true,
  lastFiredAt: null,
  lastFireError: null,
  lastFireEventId: null,
  createdBy: "creator",
  createdByName: null,
  createdByEmail: null,
  ownerUserId: "creator",
  ownerUserName: null,
  ownerUserEmail: null,
  useDraft: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function suggestedAutomationForm() {
  const formData = new FormData();
  formData.set("workspace", workspace.slug);
  formData.set("improvement_id", improvement.id);
  // These values must never be trusted by the action.
  formData.set("agent", "attacker-agent");
  formData.set("cron", "* * * * *");
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
  mockGetImprovement.mockResolvedValue(improvement);
  mockListAutomationsForAgent.mockResolvedValue([]);
  mockCreateAutomation.mockResolvedValue(automation);
});

describe("createSuggestedAutomationAction", () => {
  it("creates and enables the persisted suggested schedule", async () => {
    const result = await createSuggestedAutomationAction(
      {},
      suggestedAutomationForm(),
    );

    expect(mockCreateAutomation).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      name: "daily-pipeline-digest schedule",
      agentName: "daily-pipeline-digest",
      cron: "0 9 * * 1-5",
      inputMessage: "",
      enabled: true,
      userId: "creator",
      ownerUserId: "creator",
    });
    expect(result).toEqual({
      automation: {
        id: automation.id,
        name: automation.name,
        alreadyExisted: false,
      },
    });
    expect(mockWriteAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "automation.created",
        targetId: automation.id,
        agentName: improvement.agentName,
      }),
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/demo/automations");
  });

  it("returns an existing matching automation instead of duplicating it", async () => {
    mockListAutomationsForAgent.mockResolvedValue([automation]);

    const result = await createSuggestedAutomationAction(
      {},
      suggestedAutomationForm(),
    );

    expect(result.automation).toEqual({
      id: automation.id,
      name: automation.name,
      alreadyExisted: true,
    });
    expect(mockCreateAutomation).not.toHaveBeenCalled();
    expect(mockWriteAuditEvent).not.toHaveBeenCalled();
  });

  it("rejects a create request outside the authorized workspace", async () => {
    mockGetImprovement.mockResolvedValue({
      ...improvement,
      workspaceId: "ws-other",
    });

    const result = await createSuggestedAutomationAction(
      {},
      suggestedAutomationForm(),
    );

    expect(result.error).toMatch(/no longer available/);
    expect(mockCreateAutomation).not.toHaveBeenCalled();
  });

  it("rejects a request without a persisted schedule suggestion", async () => {
    mockGetImprovement.mockResolvedValue({
      ...improvement,
      improvementText: "Summarize pipeline activity on demand.",
    });

    const result = await createSuggestedAutomationAction(
      {},
      suggestedAutomationForm(),
    );

    expect(result.error).toMatch(/no longer available/);
    expect(mockCreateAutomation).not.toHaveBeenCalled();
  });
});
