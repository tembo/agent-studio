import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  workspace: vi.fn(),
  member: vi.fn(),
  report: vi.fn(),
  runs: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getServerSession: mocks.session }));
vi.mock("@/lib/workspace", () => ({
  getWorkspaceBySlug: mocks.workspace,
  userIsMember: mocks.member,
}));
vi.mock("@/lib/usage-report-db", () => ({
  getUsageReport: mocks.report,
  listUsageRuns: mocks.runs,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
import UsagePage from "./page";

const render = async (searchParams: Record<string, string> = {}) =>
  renderToStaticMarkup(
    await UsagePage({
      params: Promise.resolve({ workspace: "demo" }),
      searchParams: Promise.resolve(searchParams),
    }),
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ user: { id: "alice" } });
  mocks.workspace.mockResolvedValue({ id: "ws", slug: "demo" });
  mocks.member.mockResolvedValue(true);
  mocks.report.mockResolvedValue([]);
  mocks.runs.mockResolvedValue([]);
});

describe("usage report page", () => {
  it("checks workspace membership before reading any usage", async () => {
    mocks.member.mockResolvedValue(false);
    await expect(render()).rejects.toThrow("NOT_FOUND");
    expect(mocks.report).not.toHaveBeenCalled();
    expect(mocks.runs).not.toHaveBeenCalled();
  });
  it("requires a session", async () => {
    mocks.session.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NOT_FOUND");
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("offers recovery for invalid dates without querying", async () => {
    expect(await render({ from: "bad-date" })).toContain(
      "Reset to last 30 days",
    );
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it("shows zero-activity days, accounting caveats, and empty state", async () => {
    const html = await render({ from: "2026-10-01", to: "2026-10-02" });
    expect(html).toContain("No runs in this period.");
    expect(html).toContain("2026-10-01");
    expect(html).toContain("2026-10-02");
    expect(html).toContain("Cost per priced run");
    expect(html).toContain("eval judge calls");
    expect(mocks.runs).not.toHaveBeenCalled();
  });
  it("encodes row drill-downs and preserves selected dates", async () => {
    mocks.report.mockResolvedValue([
      {
        dimension: "agents",
        key: "email & drafter",
        label: "email & drafter",
        trigger: "schedule",
        agent: null,
        runs: 2,
        knownRuns: 1,
        missingCosts: 1,
        legacyCosts: 0,
        unclassifiedRuns: 0,
        total: 2,
        average: 2,
        development: 2,
        exempt: 0,
        unclassified: 0,
      },
    ]);
    const html = await render({ from: "2026-10-01", to: "2026-10-02" });
    expect(html).toContain(
      "from=2026-10-01&amp;to=2026-10-02&amp;view=runs&amp;agent=email+%26+drafter&amp;trigger=schedule",
    );
  });
});
