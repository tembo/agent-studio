// Shared JSON-safe shape for runs crossing the server-action <-> client
// boundary. Dates become ISO strings so they survive the wire cleanly.
// Lives here rather than in actions.ts because Next.js server-action
// files (`"use server"`) can only export async functions; this module
// is a plain helper both actions.ts and page.tsx import.

import type { RunListItem } from "@/lib/runs-db";

export type LoadedRun = Omit<
  RunListItem,
  "createdAt" | "startedAt" | "completedAt"
> & {
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export function toLoaded(r: RunListItem): LoadedRun {
  return {
    id: r.id,
    agentName: r.agentName,
    status: r.status,
    trigger: r.trigger,
    automationId: r.automationId,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    userMessagePreview: r.userMessagePreview,
    errorMessagePreview: r.errorMessagePreview,
    costUsd: r.costUsd,
    createdByName: r.createdByName,
    createdByEmail: r.createdByEmail,
    slack: r.slack,
    agentVersionLabel: r.agentVersionLabel,
    runEnvironment: r.runEnvironment,
  };
}
