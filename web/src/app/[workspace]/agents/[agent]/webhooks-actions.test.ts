import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }) }));
vi.mock("@/lib/audit-db", () => ({ writeAuditEvent: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({
  authorizeWorkspace: vi.fn(),
  DENIED_MESSAGE: "You don't have permission to do that.",
}));
vi.mock("@/lib/config", () => ({ getPublicOrigin: vi.fn(() => "https://example.test") }));
vi.mock("@/lib/webhooks-db", () => ({
  createWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  getWebhookPreview: vi.fn(),
  rotateWebhookToken: vi.fn(),
  setWebhookEnabled: vi.fn(),
}));
vi.mock("@/lib/workspace", () => ({ listWorkspaceMembers: vi.fn() }));

import { authorizeWorkspace } from "@/lib/auth-server";
import { deleteWebhook, getWebhookPreview, rotateWebhookToken, setWebhookEnabled } from "@/lib/webhooks-db";
import { deleteWebhookAction, rotateWebhookAction, toggleWebhookAction } from "./webhooks-actions";

const mockAuthorizeWorkspace = vi.mocked(authorizeWorkspace);
const mockGetWebhookPreview = vi.mocked(getWebhookPreview);
const mockRotateWebhookToken = vi.mocked(rotateWebhookToken);
const mockSetWebhookEnabled = vi.mocked(setWebhookEnabled);
const mockDeleteWebhook = vi.mocked(deleteWebhook);

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

const webhook = {
  id: "hook-1",
  workspaceId: workspace.id,
  agentName: "agent",
  ownerUserId: "other-member",
  name: "Webhook",
  tokenLast4: "1234",
  hasSigningSecret: false,
  enabled: true,
  lastFiredAt: null,
  lastFireError: null,
  lastFireEventId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

function form() {
  const data = new FormData();
  data.set("workspace", workspace.slug);
  data.set("id", webhook.id);
  data.set("enabled", "false");
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthorizeWorkspace.mockResolvedValue({ ok: true, workspace, userId: "operator", role: "operator" });
  mockGetWebhookPreview.mockResolvedValue(webhook);
  mockRotateWebhookToken.mockResolvedValue("new-token");
});

describe("webhook owner permissions", () => {
  it("does not reveal a new token or mutate another member's webhook", async () => {
    const data = form();
    expect((await rotateWebhookAction({}, data)).error).toMatch(/owner/);
    expect((await toggleWebhookAction({}, data)).error).toMatch(/owner/);
    expect((await deleteWebhookAction({}, data)).error).toMatch(/owner/);
    expect(mockRotateWebhookToken).not.toHaveBeenCalled();
    expect(mockSetWebhookEnabled).not.toHaveBeenCalled();
    expect(mockDeleteWebhook).not.toHaveBeenCalled();
  });

  it("allows the owner and a workspace admin to rotate the token", async () => {
    mockAuthorizeWorkspace.mockResolvedValue({ ok: true, workspace, userId: "other-member", role: "operator" });
    expect((await rotateWebhookAction({}, form())).secret?.token).toBe("new-token");
    mockAuthorizeWorkspace.mockResolvedValue({ ok: true, workspace, userId: "admin", role: "workspace_admin" });
    expect((await rotateWebhookAction({}, form())).secret?.token).toBe("new-token");
    expect(mockRotateWebhookToken).toHaveBeenCalledTimes(2);
  });
});
