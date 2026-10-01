import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeWorkspace: vi.fn(),
  setTextMessagesEnabled: vi.fn(),
  writeAuditEvent: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/auth-server", () => ({
  authorizeWorkspace: mocks.authorizeWorkspace,
  DENIED_MESSAGE: "Denied.",
}));
vi.mock("@/lib/workspace-features", () => ({ setTextMessagesEnabled: mocks.setTextMessagesEnabled }));
vi.mock("@/lib/audit-db", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { saveFeaturesAction } from "./actions";

function form(enabled: boolean) {
  const data = new FormData();
  data.set("workspace", "acme");
  if (enabled) data.set("text_messages_enabled", "on");
  return data;
}

describe("workspace features", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeWorkspace.mockResolvedValue({
      ok: true, workspace: { id: "workspace-1", slug: "acme" }, userId: "admin-1",
    });
  });

  it.each([true, false])("persists enabled=%s for the authorized workspace, audits and refreshes navigation", async (enabled) => {
    expect(await saveFeaturesAction({}, form(enabled))).toEqual({ message: "Features saved." });
    expect(mocks.authorizeWorkspace).toHaveBeenCalledWith("acme", "workspace_admin");
    expect(mocks.setTextMessagesEnabled).toHaveBeenCalledWith("workspace-1", enabled);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1", actorUserId: "admin-1",
      payload: { text_messages_enabled: enabled },
    }));
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/acme", "layout");
  });

  it.each(["denied", "no-session", "no-workspace"])("rejects %s without changing settings", async (reason) => {
    mocks.authorizeWorkspace.mockResolvedValue({ ok: false, reason });
    expect(await saveFeaturesAction({}, form(true))).toEqual({ error: "Denied." });
    expect(mocks.setTextMessagesEnabled).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
