import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getPersonalSecretConnectionValue } = vi.hoisted(() => ({ getPersonalSecretConnectionValue: vi.fn() }));
vi.mock("@/lib/secret-connections", () => ({ getPersonalSecretConnectionValue }));

import { linkedinExecutor } from "@/lib/inbox-executors/linkedin";

const convId = "urn:li:msg_conversation:(urn:li:fsd_profile:owner,conversation)";

describe("LinkedIn inbox execution", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    getPersonalSecretConnectionValue.mockImplementation(async (_workspaceId, slug, userId) => userId === "owner" ? `own-${slug}` : null);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["send", "archive", "send_and_archive"])("uses the clicking user's session for %s", async (op) => {
    await linkedinExecutor({ workspaceId: "workspace-1", userId: "owner", op, params: { convId, userId: "someone-else" }, text: "Hello" });
    for (const [workspaceId, , userId] of getPersonalSecretConnectionValue.mock.calls) {
      expect([workspaceId, userId]).toEqual(["workspace-1", "owner"]);
    }
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ cookie: 'li_at=own-linkedin_li_at; JSESSIONID="own-linkedin_jsessionid"' }),
    }));
  });

  it.each(["send", "archive", "send_and_archive"])("refuses %s when the clicking user has no LinkedIn account", async (op) => {
    await expect(linkedinExecutor({ workspaceId: "workspace-1", userId: "other-user", op, params: { convId }, text: "Hello" })).rejects.toThrow("Your LinkedIn session is not configured");
    expect(fetch).not.toHaveBeenCalled();
  });
});
