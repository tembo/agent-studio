import Link from "next/link";
import { notFound } from "next/navigation";

import { LocalTime } from "@/components/local-time";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug, getWorkspaceRole } from "@/lib/workspace";
import { getUsageReport } from "@/lib/usage-report-db";
import { parseUsageFilters, usageHref, usageMoney, USAGE_PAGE_SIZE, type UsageFilters } from "@/lib/usage-report";

export const dynamic = "force-dynamic";
const cell = "px-3 py-2 text-right tabular-nums whitespace-nowrap";
const table = "w-full text-sm [&_th]:font-medium [&_th]:text-foreground-weak [&_tbody_tr]:border-t [&_tbody_tr]:border-border-weak";

export default async function UsagePage({ params, searchParams }: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspace: slug } = await params;
  const session = await getServerSession();
  if (!session) notFound();
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace || await getWorkspaceRole(workspace.id, session.user.id) !== "workspace_admin") notFound();

  let filters: UsageFilters;
  try {
    filters = parseUsageFilters(await searchParams);
  } catch (error) {
    return <div className="p-8"><h1 className="text-xl font-bold">Usage report</h1>
      <p role="alert" className="my-4">{error instanceof Error ? error.message : "Invalid report filters."}</p>
      <Link href={`/${slug}/dashboard/usage`} className="underline">Reset report filters</Link></div>;
  }
  const report = await getUsageReport(workspace.id, filters);
  const { summary } = report;
  const filtered = Boolean(filters.user || filters.agent || filters.automation || filters.trigger || filters.kind);

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col break-words gap-7 px-6 py-8">
      <header className="flex flex-col gap-2">
        <Link href={`/${slug}/dashboard`} className="text-foreground-weak text-sm">← Dashboard</Link>
        <h1 className="text-foreground-title text-2xl font-bold">Usage report</h1>
        <p className="text-foreground-weak">Find costly agents and automations across the team. All run states, dry runs, and eval-triggered runs are included.</p>
      </header>

      <form key={JSON.stringify(filters)} className="flex flex-wrap items-end gap-3" action={`/${slug}/dashboard/usage`}>
        <label className="flex w-full min-w-0 flex-col gap-1 text-sm sm:w-auto">From<Input name="from" type="date" defaultValue={filters.from} required /></label>
        <label className="flex w-full min-w-0 flex-col gap-1 text-sm sm:w-auto">Through<Input name="to" type="date" defaultValue={filters.to} required /></label>
        <label className="flex w-full min-w-0 flex-col gap-1 text-sm sm:w-auto">Group by
          <select name="group" defaultValue={filters.group} className="border-border bg-surface h-8 max-w-full rounded-lg border px-3">
            <option value="agents">Agent and trigger</option><option value="automations">Automation</option><option value="users">Run-as user</option>
          </select>
        </label>
        {(["user", "agent", "automation", "trigger", "kind"] as const).map((name) =>
          filters[name] ? <input key={name} type="hidden" name={name} value={filters[name]} /> : null)}
        <Button type="submit" variant="secondary">Apply</Button>
        <Link href={`/${slug}/dashboard/usage`} className="text-sm underline">Last 30 days</Link>
        <span className="text-foreground-weak pb-1 text-xs">Eastern time · inclusive dates</span>
      </form>
      {filtered && <div className="border-border bg-surface rounded-lg border p-3 text-sm">
        Showing a selected {filters.group === "users" ? "member" : "agent / automation"} and its matching runs.
        {filters.agent && <span> Agent: <strong>{filters.agent}</strong>.</span>}
        {filters.trigger && <span> Trigger: {filters.trigger}.</span>}
        {filters.kind && <span> Kind: {filters.kind}.</span>}{" "}
        <Link href={usageHref(slug, filters, { user: undefined, agent: undefined, automation: undefined, trigger: undefined, kind: undefined })} className="underline">Clear selection</Link>
      </div>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Known estimated spend", usageMoney(summary.knownCost)],
          ["Runs", summary.runs.toLocaleString("en-US")],
          ["Runs without a cost estimate", summary.missingCosts.toLocaleString("en-US")],
          ["Average per priced run", usageMoney(summary.averageCost)],
        ].map(([label, value]) => <div key={label} className="border-border bg-surface min-w-0 rounded-lg border p-4">
          <p className="text-foreground-weak text-sm">{label}</p><p className="text-foreground-title mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        </div>)}
      </div>

      <Section title="Development and exempt spend" description="This report does not enforce caps. Promotion exempts later runs, including draft runs; earlier development spend stays in development.">
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <p>Development: <strong>{usageMoney(summary.developmentCost)}</strong></p>
          <p>Exempt: <strong>{usageMoney(summary.exemptCost)}</strong></p>
          <p>Unclassified: <strong>{usageMoney(summary.unclassifiedCost)}</strong> ({summary.unclassifiedRuns} runs)</p>
        </div>
      </Section>

      <Section title={filters.group === "users" ? "Spend by run-as user" : filters.group === "automations" ? "Spend by automation" : "Spend by agent and trigger"}
        description="Sorted by known spend. Select a row to inspect its daily activity and individual runs. Sub-agent executions use their own costs, without adding them again to the parent.">
        {summary.runs === 0 ? <p className="text-foreground-weak py-6">No runs match this period and selection.</p> : <div className="border-border overflow-x-auto rounded-lg border">
          <table className={table}>
            <thead><tr><th className="px-3 py-2 text-left">{filters.group === "users" ? "Run as" : filters.group === "automations" ? "Automation / agent" : "Agent"}</th>
              {["Runs", "Known spend", "Avg / priced run", "Development", "Exempt", "Unclassified", "Missing costs"].map((label) => <th key={label} className={cell}>{label}</th>)}
            </tr></thead>
            <tbody>{report.groups.map((row) => <tr key={JSON.stringify(row.filters)}>
              <td className="min-w-52 px-3 py-2"><Link className="font-medium underline" href={usageHref(slug, filters, row.filters)}>{row.label}</Link>
                <p className="text-foreground-weak text-xs">{filters.group === "automations" && `${row.filters.agent} · `}{row.filters.trigger}{row.filters.kind && ` · ${row.filters.kind}`}</p>
              </td>
              <td className={cell}>{row.runs}</td><td className={cell}>{usageMoney(row.knownCost)}</td><td className={cell}>{usageMoney(row.averageCost)}</td>
              <td className={cell}>{usageMoney(row.developmentCost)}</td><td className={cell}>{usageMoney(row.exemptCost)}</td><td className={cell}>{usageMoney(row.unclassifiedCost)}</td><td className={cell}>{row.missingCosts}</td>
            </tr>)}</tbody>
          </table>
        </div>}
        {report.groupCount > report.groups.length && <p className="text-foreground-weak mt-2 text-sm">Showing the 100 highest-spend groups of {report.groupCount}. Totals include every matching group. Narrow the period or select a group.</p>}
      </Section>

      <Section title="Runs per day" description="Days follow Eastern time. Select a date to inspect that day’s runs.">
        <div className="border-border max-h-80 overflow-auto rounded-lg border"><table className={table}>
          <thead><tr><th className="px-3 py-2 text-left">Date</th><th className={cell}>Runs</th><th className={cell}>Known spend</th><th className={cell}>Missing costs</th></tr></thead>
          <tbody>{report.days.map((day) => <tr key={day.day}>
            <td className="px-3 py-2"><Link className="underline" href={usageHref(slug, filters, { from: day.day, to: day.day })}>{day.day}</Link></td>
            <td className={cell}>{day.runs}</td><td className={cell}>{usageMoney(day.knownCost)}</td><td className={cell}>{day.missingCosts}</td>
          </tr>)}</tbody>
        </table></div>
      </Section>

      <Section title="Individual runs" description={`${summary.subRuns} sub-agent runs · ${summary.dryRuns} dry runs · ${summary.evalRuns} eval runs · ${summary.reusedRuns} reused outputs in this selection.`}>
        <div className="border-border overflow-x-auto rounded-lg border"><table className={table}>
          <thead><tr><th className="px-3 py-2 text-left">Agent / run as</th><th className="px-3 py-2 text-left">Started</th><th className="px-3 py-2 text-left">Source / status</th><th className="px-3 py-2 text-left">Spend class</th><th className={cell}>Known cost</th></tr></thead>
          <tbody>{report.runs.map((run) => <tr key={run.id}>
            <td className="min-w-48 px-3 py-2"><Link href={`/${slug}/agents/${encodeURIComponent(run.agent)}/runs/${run.id}`} className="font-medium underline">{run.agent}</Link><p className="text-foreground-weak text-xs">{run.user}</p></td>
            <td className="whitespace-nowrap px-3 py-2"><LocalTime iso={run.started} /></td>
            <td className="px-3 py-2">{run.trigger} · {run.status}<p className="text-foreground-weak text-xs">{[run.subRun && "Sub-agent", run.dryRun && "Dry run", run.reused && "Reused output"].filter(Boolean).join(" · ")}</p></td>
            <td className="px-3 py-2 capitalize">{run.classification}</td><td className={cell}>{usageMoney(run.cost)}</td>
          </tr>)}</tbody>
        </table></div>
        <nav aria-label="Run pages" className="mt-3 flex gap-4 text-sm">
          {filters.page > 1 && <Link className="underline" href={usageHref(slug, filters, { page: filters.page - 1 })}>Previous</Link>}
          <span>Page {filters.page}</span>
          {filters.page * USAGE_PAGE_SIZE < summary.runs && filters.page < 20000 && <Link className="underline" href={usageHref(slug, filters, { page: filters.page + 1 })}>Next</Link>}
        </nav>
      </Section>

      <details className="text-foreground-weak text-sm">
        <summary className="cursor-pointer font-medium">How to read these estimates</summary>
        <div className="mt-2 space-y-2">
          <p>Spend uses saved estimates, not provider invoices. Missing estimates, including unfinished or failed work, are not treated as free. Averages include only runs with known costs; reused outputs have zero additional cost.</p>
          <p>Dates use each run’s start time, or creation time while it has no start time. Development eligibility uses promotion history at run admission, independently for each sub-agent. Missing version history appears as unclassified. These buckets differ from the dashboard’s version-based environment filter.</p>
          <p>Eval agent executions are included; separate judge calls and external tool charges without saved run costs are not included. Automations use the saved schedule reference; deleted schedules, event sources, and sub-runs without that reference cannot be attributed to a specific automation.</p>
        </div>
      </details>
    </div>
  );
}
