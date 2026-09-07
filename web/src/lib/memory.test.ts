import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryRequest } from "./memory";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Memory backend client", () => {
  it("calls only the internal Studio API with its internal credential", async () => {
    vi.stubEnv("INTERNAL_API_TOKEN", "internal-test-token");
    vi.stubEnv("API_INTERNAL_URL", "http://api:8080");
    vi.stubEnv("TAS_MEMORY_ADMIN_TOKEN", "must-not-leave-the-api");
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ configured: true }) });
    vi.stubGlobal("fetch", fetcher);
    await memoryRequest("workspace-1");
    expect(fetcher).toHaveBeenCalledWith("http://api:8080/internal/memory/workspaces/workspace-1", expect.objectContaining({ headers: { Authorization: "Bearer internal-test-token", "Content-Type": "application/json" } }));
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("must-not-leave-the-api");
  });

  it("does not surface upstream response bodies", async () => {
    vi.stubEnv("INTERNAL_API_TOKEN", "internal-test-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, text: async () => "secret upstream details" }));
    await expect(memoryRequest("workspace-1")).rejects.toThrow("Memory settings could not be loaded or saved");
  });
});
