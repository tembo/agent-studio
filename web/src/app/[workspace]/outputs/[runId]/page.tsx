import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { CopyButton } from "@/components/copy-button";
import { LocalTime } from "@/components/local-time";
import { Markdown } from "@/components/markdown";
import { Section } from "@/components/section";
import { getOutputForWorkspace } from "@/lib/outputs-db";
import { getServerSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { getWorkspaceBySlug, getWorkspaceRole } from "@/lib/workspace";

import { DeliveryStatusBadge } from "../delivery-status";

export const dynamic = "force-dynamic";

export default async function OutputDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; runId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const [{ workspace: slug, runId }, sp, session] = await Promise.all([
    params,
    searchParams,
    getServerSession(),
  ]);
  if (!session) notFound();

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) notFound();
  const role = await getWorkspaceRole(workspace.id, session.user.id);
  if (!role) notFound();

  const output = await getOutputForWorkspace(workspace.id, runId);
  if (!output || output.workspaceId !== workspace.id) notFound();

  const raw = sp.view === "raw";
  const runHref = `/${slug}/agents/${encodeURIComponent(output.agentName)}/runs/${output.runId}`;
  const operatorRunHref = `/${slug}/agents/${encodeURIComponent(output.operatorName)}/runs/${output.operatorRunId}`;
  const evidence = new Map(
    output.deliveryEvidence?.destinations.map((item) => [item.key, item.status]) ?? [],
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-7 px-6 py-8">
      <div className="flex flex-col gap-3">
        <BackLink href={`/${slug}/outputs`} label="Outputs" />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-foreground-title text-2xl font-bold tracking-tight">
              {output.agentName} output
            </h1>
            <p className="text-foreground-weak mt-1 text-sm">
              Completed <LocalTime iso={output.completedAt.toISOString()} />
            </p>
          </div>
          <DeliveryStatusBadge status={output.deliveryStatus} />
        </div>
      </div>

      <Section
        title="Output"
        description="Preview renders Markdown; Raw preserves the exact stored text."
        actions={
          <div className="flex items-center gap-2">
            <ViewTab href={`/${slug}/outputs/${runId}`} active={!raw}>Preview</ViewTab>
            <ViewTab href={`/${slug}/outputs/${runId}?view=raw`} active={raw}>Raw</ViewTab>
            <CopyButton text={output.output} ariaLabel="Copy raw output" />
          </div>
        }
      >
        <div className="border-border bg-surface min-h-56 overflow-hidden rounded-xl border p-5 sm:p-7">
          {raw ? (
            <pre className="text-foreground overflow-x-auto whitespace-pre-wrap break-words font-mono text-sm leading-6">
              {output.output}
            </pre>
          ) : (
            <Markdown size="lg">{output.output}</Markdown>
          )}
        </div>
      </Section>

      <div className="grid gap-7 lg:grid-cols-2">
        <Section title="Provenance" description="The exact execution that produced this output.">
          <dl className="border-border divide-border divide-y rounded-xl border text-sm">
            <ProvenanceRow label="Run">
              <Link className="underline hover:no-underline" href={runHref}>
                {output.runId}
              </Link>
            </ProvenanceRow>
            <ProvenanceRow label="Agent">{output.agentName}</ProvenanceRow>
            <ProvenanceRow label="Root operator">
              {output.operatorName}
              {output.operatorRunId !== output.runId ? (
                <>
                  {" · "}
                  <Link
                    className="text-foreground-weak underline hover:no-underline"
                    href={operatorRunHref}
                  >
                    parent run
                  </Link>
                </>
              ) : null}
            </ProvenanceRow>
            <ProvenanceRow label="Run as">
              {output.createdByName?.trim() || output.createdByEmail || output.createdBy}
            </ProvenanceRow>
            <ProvenanceRow label="Version">
              {output.agentVersionLabel ?? "Unversioned"}
            </ProvenanceRow>
            <ProvenanceRow label="Trigger">{output.trigger}</ProvenanceRow>
            <ProvenanceRow label="Model">{output.model}</ProvenanceRow>
            <ProvenanceRow label="Completed">
              <LocalTime iso={output.completedAt.toISOString()} />
            </ProvenanceRow>
          </dl>
        </Section>

        <Section
          title="Delivery evidence"
          description="Confirmation reflects durable records, not human receipt."
        >
          {output.delivery ? (
            <div className="border-border flex flex-col gap-4 rounded-xl border p-4">
              <p className="text-foreground text-sm">{output.delivery.note}</p>
              <div className="flex flex-col gap-3">
                {output.delivery.destinations.map((destination) => {
                  const status = evidence.get(destination.key) ?? "unobserved";
                  return (
                    <div
                      key={destination.key}
                      className="flex items-center justify-between gap-3"
                    >
                      <div>
                        <div className="text-foreground text-sm font-medium">
                          {destination.label}
                        </div>
                        <div className="text-foreground-weak font-mono text-xs">
                          {destination.evidence.type === "tool_call"
                            ? destination.evidence.tool
                            : "inbox item produced by this run"}
                        </div>
                      </div>
                      <DeliveryStatusBadge status={status} />
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="border-border text-foreground-weak rounded-xl border border-dashed p-5 text-sm">
              This agent version did not declare delivery intent.
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function ViewTab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-md px-2 py-1 text-sm font-medium",
        active
          ? "bg-interactive-state-active text-foreground"
          : "text-foreground-weak hover:bg-interactive-state-hover hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

function ProvenanceRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 px-4 py-3">
      <dt className="text-foreground-weak font-medium">{label}</dt>
      <dd className="text-foreground min-w-0 break-words">{children}</dd>
    </div>
  );
}
