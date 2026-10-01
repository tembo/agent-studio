import { beforeEach, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({
  authorizeWorkspace: vi.fn(), DENIED_MESSAGE: "Access denied",
}));
vi.mock("@/lib/audit-db", () => ({ writeAuditEvent: vi.fn() }));
vi.mock("@/lib/workspace-secrets", () => ({
  getWorkspaceSecretPreview: vi.fn(), setWorkspaceSecret: vi.fn(), removeWorkspaceSecret: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { authorizeWorkspace } from "@/lib/auth-server";
import { writeAuditEvent } from "@/lib/audit-db";
import { getWorkspaceSecretPreview, setWorkspaceSecret, removeWorkspaceSecret } from "@/lib/workspace-secrets";
import { saveSecretAction, removeSecretAction } from "./secret-actions";

function form() {
  const data = new FormData();
  data.set("workspace", "test-workspace");
  data.set("kind", "fireworks_api_key");
  data.set("apiKey", "test-fireworks-secret");
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(authorizeWorkspace).mockResolvedValue({
    ok: true, workspace: { id: "workspace-id", slug: "test-workspace" },
    userId: "admin", role: "workspace_admin",
  } as Awaited<ReturnType<typeof authorizeWorkspace>>);
  vi.mocked(getWorkspaceSecretPreview).mockResolvedValue(null);
  vi.mocked(setWorkspaceSecret).mockResolvedValue({ ok: true });
});

it.each([false, true])("saves and audits Fireworks credentials (rotation: %s)", async (rotating) => {
  if (rotating) vi.mocked(getWorkspaceSecretPreview).mockResolvedValue({ last4: "1234", updatedAt: new Date() });
  expect(await saveSecretAction({}, form())).toEqual({ message: "Fireworks API key saved." });
  expect(authorizeWorkspace).toHaveBeenCalledWith("test-workspace", "workspace_admin");
  expect(setWorkspaceSecret).toHaveBeenCalledWith("workspace-id", "fireworks_api_key", "test-fireworks-secret");
  expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
    kind: rotating ? "secret.rotated" : "secret.set", targetId: "fireworks_api_key",
    payload: { secretKind: "fireworks_api_key" },
  }));
  expect(JSON.stringify(vi.mocked(writeAuditEvent).mock.calls)).not.toContain("test-fireworks-secret");
  expect(revalidatePath).toHaveBeenCalledWith("/test-workspace", "layout");
});

it("removes Fireworks credentials and refreshes the provider-needed prompt", async () => {
  expect(await removeSecretAction({}, form())).toEqual({ message: "Fireworks API key removed." });
  expect(removeWorkspaceSecret).toHaveBeenCalledWith("workspace-id", "fireworks_api_key");
  expect(revalidatePath).toHaveBeenCalledWith("/test-workspace", "layout");
});

it("denies credential changes by non-admins", async () => {
  vi.mocked(authorizeWorkspace).mockResolvedValue({ ok: false, reason: "denied", actual: "operator" });
  expect(await saveSecretAction({}, form())).toEqual({ error: "Access denied" });
  expect(await removeSecretAction({}, form())).toEqual({ error: "Access denied" });
  expect(setWorkspaceSecret).not.toHaveBeenCalled();
  expect(removeWorkspaceSecret).not.toHaveBeenCalled();
  expect(writeAuditEvent).not.toHaveBeenCalled();
});
