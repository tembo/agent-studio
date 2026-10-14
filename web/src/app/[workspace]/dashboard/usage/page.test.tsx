import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), workspace: vi.fn(), role: vi.fn(), report: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/lib/session", () => ({ getServerSession: mocks.session }));
vi.mock("@/lib/workspace", () => ({ getWorkspaceBySlug: mocks.workspace, getWorkspaceRole: mocks.role }));
vi.mock("@/lib/usage-report-db", () => ({ getUsageReport: mocks.report }));
import UsagePage from "./page";

const markup = async (params = {}) => renderToStaticMarkup(await UsagePage({
  params: Promise.resolve({ workspace: "acme" }), searchParams: Promise.resolve(params),
}));
describe("usage report access and presentation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.session.mockResolvedValue({ user: { id: "admin" } });
    mocks.workspace.mockResolvedValue({ id: "workspace", slug: "acme" });
    mocks.role.mockResolvedValue("workspace_admin");
    mocks.report.mockResolvedValue({ summary: { runs: 0, knownCost: 0, averageCost: null,
      missingCosts: 0, developmentCost: 0, exemptCost: 0, unclassifiedCost: 0,
      unclassifiedRuns: 0, reusedRuns: 0, dryRuns: 0, evalRuns: 0, subRuns: 0 }, groups: [], days: [], runs: [], groupCount: 0 });
  });
  it.each([null, "operator", "viewer", "reviewer"])("rejects role %s before reading spend", async (role) => {
    mocks.role.mockResolvedValue(role);
    await expect(markup()).rejects.toThrow("NOT_FOUND");
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated requests before reading workspace data", async () => {
    mocks.session.mockResolvedValue(null);
    await expect(markup()).rejects.toThrow("NOT_FOUND");
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("shows an actionable error without querying invalid ranges", async () => {
    expect(await markup({ from: "2026-02-30" })).toContain("Reset report filters");
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("renders the admin report and preserves selections in its date form", async () => {
    const html = await markup({ agent: "email-drafter", user: "alice", group: "automations" });
    expect(html).toContain("Spend by automation");
    expect(html).toContain("No runs match");
    expect(html).toContain('name="agent" value="email-drafter"');
    expect(html).toContain('name="user" value="alice"');
    expect(html).toContain("This report does not enforce caps");
    expect(mocks.report).toHaveBeenCalledWith("workspace", expect.objectContaining({ agent: "email-drafter", user: "alice" }));
  });
});
