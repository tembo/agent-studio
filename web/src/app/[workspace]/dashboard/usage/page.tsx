import Link from "next/link";
import { notFound } from "next/navigation";

import { LocalTime } from "@/components/local-time";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug, userIsMember } from "@/lib/workspace";
import {
  getUsageReport,
  listUsageRuns,
  type UsageBucket,
} from "@/lib/usage-report-db";
import {
  parseUsageFilters,
  usageDays,
  usageHref,
  USAGE_PAGE_SIZE,
  type UsageFilters,
  type UsageView,
} from "@/lib/usage-report";

export const dynamic = "force-dynamic";
const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const money = (value: number | null) =>
  value === null ? "Unavailable" : currency.format(value);
const cell = "px-3 py-2 text-right tabular-nums whitespace-nowrap";
const heading = "px-3 py-2 text-right font-medium whitespace-nowrap";
const link =
  "text-foreground underline underline-offset-4 hover:text-foreground-weak";

export default async function UsagePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspace: slug }, sp, session] = await Promise.all([
    params,
    searchParams,
    getServerSession(),
  ]);
  if (!session) notFound();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace || !(await userIsMember(workspace.id, session.user.id)))
    notFound();
  const base = `/${workspace.slug}/dashboard/usage`;
  let filters: UsageFilters;
  try {
    filters = parseUsageFilters(sp);
  } catch (error) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-6 py-8">
        <h1 className="text-2xl font-bold">Usage report</h1>
        <p role="alert">{(error as Error).message}</p>
        <Link className={link} href={base}>
          Reset to last 30 days
        </Link>
      </div>
    );
  }
  const [buckets, runs] = await Promise.all([
    getUsageReport(workspace.id, filters),
    filters.view === "runs"
      ? listUsageRuns(workspace.id, filters)
      : Promise.resolve([]),
  ]);
  const total = buckets.find((b) => b.dimension === "total");
  const rows = buckets.filter((b) => b.dimension === filters.view);
  const daily = new Map(
    buckets.filter((b) => b.dimension === "day").map((b) => [b.key, b]),
  );
  const maxDaily = Math.max(1, ...Array.from(daily.values(), (b) => b.runs));
  const hasFilters = Boolean(
    filters.agent || filters.user || filters.automation || filters.trigger,
  );
  const clearFilters = {
    agent: undefined,
    user: undefined,
    automation: undefined,
    trigger: undefined,
  };
  const views: [UsageView, string][] = [
    ["agents", "By agent"],
    ["automations", "By automation"],
    ["users", "By user"],
    ["runs", "Underlying runs"],
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="space-y-2">
        <Link
          className={`${link} text-sm`}
          href={`/${workspace.slug}/dashboard`}
        >
          ← Dashboard
        </Link>
        <h1 className="text-foreground-title text-2xl font-bold">
          Usage report
        </h1>
        <p className="text-foreground-weak">
          Estimated model spend across all runs, including evaluations, dry
          runs, and sub-agents. Each run is counted once under its run-as member
          and producing agent.
        </p>
      </div>
      <form
        key={`${filters.from}/${filters.to}`}
        action={base}
        className="flex flex-wrap items-end gap-3"
      >
        <input type="hidden" name="view" value={filters.view} />
        {(["agent", "user", "automation", "trigger"] as const).map(
          (key) =>
            filters[key] && (
              <input key={key} type="hidden" name={key} value={filters[key]} />
            ),
        )}
        <label className="flex flex-col gap-1 text-sm">
          From
          <input
            className="border-border bg-surface rounded-md border px-2 py-1"
            type="date"
            name="from"
            defaultValue={filters.from}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Through
          <input
            className="border-border bg-surface rounded-md border px-2 py-1"
            type="date"
            name="to"
            defaultValue={filters.to}
            required
          />
        </label>
        <Button type="submit">Apply dates</Button>
        {[7, 30, 90].map((days) => (
          <Link
            key={days}
            className={`${link} text-sm`}
            href={usageHref(base, filters, {
              from: parseUsageFilters({ days: String(days) }).from,
              to: parseUsageFilters({ days: String(days) }).to,
            })}
          >
            Last {days} days
          </Link>
        ))}
      </form>
      <p className="text-foreground-muted text-sm">
        Dates include both endpoints in Eastern time (America/New_York). Runs
        are assigned to the date they were admitted, even if they finish later.
      </p>
      {hasFilters && (
        <div className="border-border bg-surface rounded-lg border p-3 text-sm">
          Showing {filters.agent ? `agent ${filters.agent}; ` : ""}
          {filters.user ? "selected run-as member; " : ""}
          {filters.automation ? "selected automation; " : ""}
          {filters.trigger ? `${filters.trigger} triggers; ` : ""}
          <Link className={link} href={usageHref(base, filters, clearFilters)}>
            Clear breakdown filters
          </Link>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Known estimated spend", money(total?.total ?? 0)],
          ["Runs", total?.runs ?? 0],
          ["Runs with unavailable cost", total?.missingCosts ?? 0],
          ["Cost per priced run", money(total?.average ?? null)],
        ].map(([label, value]) => (
          <div
            key={label}
            className="border-border bg-surface rounded-lg border p-4"
          >
            <p className="text-foreground-weak text-sm">{label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </div>
      <div className="text-foreground-weak space-y-2 text-sm">
        <p>
          <strong>Development</strong> is spend before an agent’s first
          promotion. <strong>Exempt production</strong> includes subsequent
          runs, even on draft. <strong>Unclassified</strong> means the
          historical lifecycle is unavailable. These categories are separate
          from the dashboard’s Production/Development environment tabs.
        </p>
        <p>
          Totals include only stored estimates; unavailable estimates are not
          free runs. Cost per priced run excludes unavailable costs. Reused
          outputs add zero spend. Sub-agent costs are shown under each child
          agent, not added again to its parent. {total?.legacyCosts ?? 0} priced
          runs use legacy estimates without a pricing snapshot.{" "}
          {total?.unclassifiedRuns ?? 0} runs have an unclassified lifecycle.
        </p>
        <p>
          Separate eval judge calls are not recorded as priced runs and are
          excluded. This report does not enforce spend caps.
        </p>
      </div>
      <nav aria-label="Usage breakdown" className="flex flex-wrap gap-2">
        {views.map(([view, label]) => (
          <Link
            key={view}
            aria-current={filters.view === view ? "page" : undefined}
            className={`rounded-md border px-3 py-1.5 text-sm ${filters.view === view ? "border-foreground bg-surface-raised font-semibold" : "border-border hover:bg-surface-raised"}`}
            href={usageHref(base, filters, { view })}
          >
            {label}
          </Link>
        ))}
      </nav>
      {filters.view === "runs" ? (
        <Section
          title="Underlying runs"
          description="Open a run to inspect its estimate, execution, and output."
        >
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-surface-raised">
                <tr>
                  {[
                    "Agent / run",
                    "Run as",
                    "Trigger",
                    "Started (admitted)",
                    "Status",
                    "Spend category",
                    "Cost",
                  ].map((h) => (
                    <th key={h} className={heading}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2">
                      <Link
                        className={link}
                        href={`/${workspace.slug}/agents/${encodeURIComponent(r.agent_name)}/runs/${r.id}`}
                      >
                        {r.agent_name} · {r.id.slice(0, 8)}
                      </Link>
                      <div className="text-foreground-muted text-xs">
                        {[
                          r.is_dry_run && "Dry run",
                          r.orchestrator_run_id && "Sub-agent",
                          r.reused_from_run_id && "Reused output",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </td>
                    <td className={cell}>{r.user_label}</td>
                    <td className={cell}>
                      {r.trigger}
                      {r.automation_id && (
                        <div className="text-foreground-muted text-xs">
                          {r.automation_label}
                        </div>
                      )}
                    </td>
                    <td className={cell}>
                      <LocalTime iso={r.created_at.toISOString()} />
                    </td>
                    <td className={cell}>{r.status}</td>
                    <td className={cell}>{r.spend_class}</td>
                    <td className={cell}>{money(r.cost)}</td>
                  </tr>
                ))}
                {runs.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="p-6 text-center text-foreground-weak"
                    >
                      No runs on this page.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex gap-4 text-sm">
            <span>Page {filters.page}</span>
            {filters.page > 1 && (
              <Link
                className={link}
                href={usageHref(base, filters, { page: filters.page - 1 })}
              >
                Previous
              </Link>
            )}
            {filters.page * USAGE_PAGE_SIZE < (total?.runs ?? 0) && (
              <Link
                className={link}
                href={usageHref(base, filters, { page: filters.page + 1 })}
              >
                Next
              </Link>
            )}
          </div>
        </Section>
      ) : (
        <Section
          title={views.find(([view]) => view === filters.view)![1]}
          description="Sorted by known estimated spend. Select a row to inspect its runs."
        >
          <div className="border-border max-h-[36rem] overflow-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-surface-raised sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">
                    {filters.view === "users"
                      ? "Run as"
                      : filters.view === "agents"
                        ? "Agent"
                        : "Automation / agent"}
                  </th>
                  {filters.view !== "users" && (
                    <th className={heading}>Trigger type</th>
                  )}
                  {[
                    "Runs",
                    "Known total",
                    "Cost / priced run",
                    "Development",
                    "Exempt production",
                    "Unclassified",
                    "Cost unavailable",
                  ].map((h) => (
                    <th key={h} className={heading}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {rows.map((row) => (
                  <UsageRow
                    key={JSON.stringify([row.key, row.trigger, row.agent])}
                    row={row}
                    base={base}
                    filters={filters}
                  />
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={9}
                      className="p-6 text-center text-foreground-weak"
                    >
                      No {filters.view === "automations" ? "automation " : ""}
                      runs in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      <Section
        title="Runs per day"
        description="Daily counts and known estimated spend for the selected filters, in Eastern time. Select a date to inspect that day’s runs."
      >
        <div className="border-border max-h-80 overflow-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-surface-raised sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left font-medium">
                  Date (Eastern)
                </th>
                <th className={heading}>Runs</th>
                <th className={heading}>Known spend</th>
                <th className={heading}>Cost unavailable</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {usageDays(filters.from, filters.to).map((day) => {
                const bucket = daily.get(day);
                return (
                  <tr key={day}>
                    <td className="px-3 py-2">
                      <Link
                        className={link}
                        href={usageHref(base, filters, {
                          from: day,
                          to: day,
                          view: "runs",
                        })}
                      >
                        {day}
                      </Link>
                    </td>
                    <td className={cell}>
                      <div className="flex items-center justify-end gap-3">
                        <div
                          className="bg-surface-raised hidden h-2 w-32 overflow-hidden rounded sm:block"
                          aria-hidden
                        >
                          <div
                            className="bg-foreground h-full rounded"
                            style={{
                              width: `${(100 * (bucket?.runs ?? 0)) / maxDaily}%`,
                            }}
                          />
                        </div>
                        {bucket?.runs ?? 0}
                      </div>
                    </td>
                    <td className={cell}>{money(bucket?.total ?? 0)}</td>
                    <td className={cell}>{bucket?.missingCosts ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function UsageRow({
  row,
  base,
  filters,
}: {
  row: UsageBucket;
  base: string;
  filters: UsageFilters;
}) {
  const selection: Partial<UsageFilters> =
    row.dimension === "users"
      ? { user: row.key }
      : row.dimension === "agents"
        ? { agent: row.key, trigger: row.trigger ?? undefined }
        : {
            automation: row.key,
            agent: row.agent ?? undefined,
            trigger: row.trigger ?? undefined,
          };
  return (
    <tr className="hover:bg-surface-raised">
      <td className="px-3 py-2">
        <Link
          className={link}
          href={usageHref(base, filters, { ...selection, view: "runs" })}
        >
          {row.label}
        </Link>
        {row.dimension === "automations" && (
          <div className="text-foreground-muted text-xs">
            {row.agent}
            {row.key !== "unavailable" && ` · ${row.key.slice(0, 8)}`}
          </div>
        )}
      </td>
      {filters.view !== "users" && <td className={cell}>{row.trigger}</td>}
      <td className={cell}>{row.runs}</td>
      <td className={cell}>{money(row.total)}</td>
      <td className={cell}>{money(row.average)}</td>
      <td className={cell}>{money(row.development)}</td>
      <td className={cell}>{money(row.exempt)}</td>
      <td className={cell}>{money(row.unclassified)}</td>
      <td className={cell}>{row.missingCosts}</td>
    </tr>
  );
}
