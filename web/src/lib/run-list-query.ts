import {
  RUN_ENVIRONMENTS,
  type RunEnvironment,
} from "@/lib/run-environment";

export type RunListStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export type RunListTrigger = "manual" | "schedule" | "event";

export const RUN_LIST_STATUSES: RunListStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];
export const RUN_LIST_TRIGGERS: RunListTrigger[] = [
  "manual",
  "schedule",
  "event",
];

type SearchParams = Record<string, string | string[] | undefined>;

export type RunListQuery = {
  statuses: RunListStatus[];
  triggers: RunListTrigger[];
  environments: RunEnvironment[];
  agentName: string;
  search: string;
  dryRun: boolean;
};

export function parseRunListQuery(searchParams: SearchParams): RunListQuery {
  return {
    statuses: parseMultiParam(searchParams.status, RUN_LIST_STATUSES),
    triggers: parseMultiParam(searchParams.trigger, RUN_LIST_TRIGGERS),
    environments: parseMultiParam(
      searchParams.environment,
      RUN_ENVIRONMENTS,
    ),
    agentName: parseSingleParam(searchParams.agent),
    search: parseSingleParam(searchParams.q).slice(0, 200),
    dryRun: parseSingleParam(searchParams.dryRun) === "1",
  };
}

export function runListQueryKey(query: RunListQuery): string {
  return JSON.stringify(query);
}

function parseSingleParam(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() ?? "";
}

function parseMultiParam<T extends string>(
  raw: string | string[] | undefined,
  allowed: readonly T[],
): T[] {
  if (!raw) return [];
  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedSet = new Set<string>(allowed);
  return [...new Set(values.filter((value): value is T => allowedSet.has(value)))];
}
