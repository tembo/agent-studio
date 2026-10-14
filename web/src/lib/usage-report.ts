export const USAGE_TIME_ZONE = "America/New_York";
export const USAGE_PAGE_SIZE = 50;
export type UsageGroup = "agents" | "users" | "automations";
export type UsageFilters = {
  from: string;
  to: string;
  group: UsageGroup;
  user?: string;
  agent?: string;
  automation?: string;
  trigger?: string;
  kind?: "direct" | "sub-agent";
  page: number;
};

type SearchParams = Record<string, string | string[] | undefined>;
const one = (value: SearchParams[string]) => Array.isArray(value) ? value[0] : value;
const DAY_MS = 86_400_000;

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

export function parseUsageFilters(params: SearchParams, now = new Date()): UsageFilters {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: USAGE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const to = one(params.to) || today;
  if (!validDate(to)) throw new Error("Choose valid dates in order, covering at most 366 days.");
  const from = one(params.from) || new Date(Date.parse(to) - 29 * DAY_MS).toISOString().slice(0, 10);
  if (!validDate(from) || !validDate(to) || from > to || (Date.parse(to) - Date.parse(from)) / DAY_MS >= 366) {
    throw new Error("Choose valid dates in order, covering at most 366 days.");
  }
  const group = one(params.group) || "agents";
  if (group !== "agents" && group !== "users" && group !== "automations") throw new Error("Choose a valid report view.");
  const automation = one(params.automation) || undefined;
  if (automation && automation !== "none" && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(automation)) {
    throw new Error("Choose a valid automation.");
  }
  const trigger = one(params.trigger) || undefined;
  if (trigger && !["manual", "schedule", "event", "eval"].includes(trigger)) throw new Error("Choose a valid trigger.");
  const kind = one(params.kind) || undefined;
  if (kind !== undefined && kind !== "direct" && kind !== "sub-agent") throw new Error("Choose a valid run kind.");
  const page = Number(one(params.page) || 1);
  if (!Number.isInteger(page) || page < 1 || page > 20000) throw new Error("Choose a valid page.");
  return { from, to, group, automation, trigger, kind, page, user: one(params.user) || undefined, agent: one(params.agent) || undefined };
}

export function usageHref(slug: string, filters: UsageFilters, changes: Partial<UsageFilters> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, page: 1, ...changes })) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return `/${encodeURIComponent(slug)}/dashboard/usage?${params}`;
}

export function usageMoney(value: number | null): string {
  if (value !== null && value > 0 && value < 0.0001) return "<$0.0001";
  return value === null ? "Unavailable" : new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4,
  }).format(value);
}
