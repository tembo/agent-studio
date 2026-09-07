import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({ authorizeWorkspace: vi.fn() }));
vi.mock("@/lib/instance", () => ({ authorizeInstance: vi.fn() }));
vi.mock("@/lib/audit-db", () => ({ writeAuditEvent: vi.fn() }));
vi.mock("@/lib/memory", () => ({ memoryRequest: vi.fn() }));

import { authorizeInstance } from "@/lib/instance";
import { authorizeWorkspace } from "@/lib/auth-server";
import { memoryRequest } from "@/lib/memory";
import { saveMemoryAction } from "./memory-actions";

beforeEach(() => vi.resetAllMocks());

describe("Memory sharing authorization", () => {
  it("does not allow workspace admins alone to select another Memory workspace", async () => {
    vi.mocked(authorizeInstance).mockResolvedValue({ ok: false, reason: "denied" });
    expect(await saveMemoryAction({}, new FormData())).toEqual({ error: "Only an instance admin can change Memory sharing." });
    expect(memoryRequest).not.toHaveBeenCalled();
  });

  it("also requires membership in the affected Studio workspace", async () => {
    vi.mocked(authorizeInstance).mockResolvedValue({ ok: true, userId: "admin", email: "admin@example.com" });
    vi.mocked(authorizeWorkspace).mockResolvedValue({ ok: false, reason: "denied", actual: null });
    expect(await saveMemoryAction({}, new FormData())).toEqual({ error: "Workspace access required." });
    expect(memoryRequest).not.toHaveBeenCalled();
  });
});
