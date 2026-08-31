import Link from "next/link";
import { notFound } from "next/navigation";

import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import {
  DELIVERY_STATUSES,
  listOutputFacets,
  listOutputsForWorkspace,
  type DeliveryStatus,
} from "@/lib/outputs-db";
import { getServerSession } from "@/lib/session";
import { getWorkspaceBySlug, getWorkspaceRole } from "@/lib/workspace";

import { DeliveryStatusBadge } from "./delivery-status";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function scalar(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseDate(value: string, addDay = false): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  if (addDay) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function selectedDeliveryStatus(value: string): DeliveryStatus | undefined {
  return DELIVERY_STATUSES.find((status) => status === value);
}

function userLabel(user: { name: string | null; email: string | null }): string {
  return user.name?.trim() || user.email || "Unknown user";
}

function paginationHref(slug: string, values: Record<string, string>, cursor: string) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
  }
  params.set("cursor", cursor);
  return `/${slug}/outputs?${params.toString()}`;
}

export default async function OutputsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ workspace: slug }, sp, session] = await Promise.all([
    params,
    searchParams,
    getServerSession(),
  ]);
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const role = await getWorkspaceRole(workspace.id, session.user.id);
  if (!role) notFound();

  const values = {
    q: scalar(sp.q).slice(0, 200),
    agent: scalar(sp.agent),
    operator: scalar(sp.operator),
    user: scalar(sp.user),
    from: scalar(sp.from),
    to: scalar(sp.to),
    delivery: scalar(sp.delivery),
  };
  const [page, facets] = await Promise.all([
    listOutputsForWorkspace(workspace.id, {
      search: values.q || undefined,
      agentName: values.agent || undefined,
      operatorName: values.operator || undefined,
      createdBy: values.user || undefined,
      completedFrom: parseDate(values.from),
      completedBefore: parseDate(values.to, true),
      deliveryStatus: selectedDeliveryStatus(values.delivery),
      cursor: scalar(sp.cursor) || undefined,
    }),
    listOutputFacets(workspace.id),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
          Outputs
        </h1>
        <p className="text-foreground-weak text-base">
          Search completed reports and results in{" "}
          <span className="text-foreground font-medium">{workspace.name}</span>,
          including outputs produced by sub-agents.
        </p>
      </div>

      <form className="border-border bg-surface flex flex-col gap-3 rounded-xl border p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(14rem,2fr)_repeat(3,minmax(10rem,1fr))]">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Search output
            <input
              className="bg-input text-foreground h-8 rounded-lg px-3 shadow-[0_0_0_1px_var(--color-border)] outline-none focus-visible:shadow-focus-ring"
              type="search"
              name="q"
              defaultValue={values.q}
              placeholder="Words in the output…"
            />
          </label>
          <FilterSelect name="agent" label="Agent" value={values.agent}>
            <option value="">All agents</option>
            {facets.agents.map((agent) => (
              <option key={agent} value={agent}>{agent}</option>
            ))}
          </FilterSelect>
          <FilterSelect name="operator" label="Root operator" value={values.operator}>
            <option value="">All operators</option>
            {facets.operators.map((operator) => (
              <option key={operator} value={operator}>{operator}</option>
            ))}
          </FilterSelect>
          <FilterSelect name="user" label="Run as" value={values.user}>
            <option value="">All users</option>
            {facets.users.map((user) => (
              <option key={user.id} value={user.id}>
                {userLabel(user)}
              </option>
            ))}
          </FilterSelect>
        </div>
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <label className="flex flex-col gap-1 text-sm font-medium">
            From
            <input
              className="bg-input text-foreground h-8 rounded-lg px-3 shadow-[0_0_0_1px_var(--color-border)] outline-none focus-visible:shadow-focus-ring"
              type="date"
              name="from"
              defaultValue={values.from}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            To
            <input
              className="bg-input text-foreground h-8 rounded-lg px-3 shadow-[0_0_0_1px_var(--color-border)] outline-none focus-visible:shadow-focus-ring"
              type="date"
              name="to"
              defaultValue={values.to}
            />
          </label>
          <FilterSelect
            name="delivery"
            label="Delivery evidence"
            value={values.delivery}
          >
            <option value="">All statuses</option>
            {DELIVERY_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status[0].toUpperCase() + status.slice(1)}
              </option>
            ))}
          </FilterSelect>
          <div className="flex h-8 items-center gap-2">
            <Button type="submit" variant="primary">Apply</Button>
            <Button asChild variant="ghost">
              <Link href={`/${slug}/outputs`}>Reset</Link>
            </Button>
          </div>
        </div>
      </form>

      {page.items.length === 0 ? (
        <div className="border-border text-foreground-weak rounded-xl border border-dashed px-6 py-14 text-center">
          No completed outputs match these filters.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {page.items.map((output) => (
            <Link
              key={output.runId}
              href={`/${slug}/outputs/${output.runId}`}
              className="border-border bg-surface hover:bg-surface-raised flex flex-col gap-3 rounded-xl border p-4 transition-colors"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-foreground-title font-semibold">
                    {output.agentName}
                  </div>
                  <div className="text-foreground-weak mt-0.5 text-sm">
                    Operator {output.operatorName} · Run as{" "}
                    {userLabel({
                      name: output.createdByName,
                      email: output.createdByEmail,
                    })}
                    {output.agentVersionLabel ? ` · ${output.agentVersionLabel}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <DeliveryStatusBadge status={output.deliveryStatus} />
                  <LocalTime iso={output.completedAt.toISOString()} />
                </div>
              </div>
              <p className="text-foreground line-clamp-4 whitespace-pre-wrap text-sm leading-6">
                {output.outputPreview}
              </p>
              {output.delivery?.note ? (
                <p className="text-foreground-weak text-sm">
                  Delivery: {output.delivery.note}
                </p>
              ) : null}
            </Link>
          ))}
        </div>
      )}

      {page.nextCursor ? (
        <Button asChild variant="inverted" className="self-center">
          <Link href={paginationHref(slug, values, page.nextCursor)}>Next page</Link>
        </Button>
      ) : null}
    </div>
  );
}

function FilterSelect({
  name,
  label,
  value,
  children,
}: {
  name: string;
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      <select
        className="bg-input text-foreground h-8 min-w-0 rounded-lg px-3 shadow-[0_0_0_1px_var(--color-border)] outline-none focus-visible:shadow-focus-ring"
        name={name}
        defaultValue={value}
      >
        {children}
      </select>
    </label>
  );
}
