export const USAGE_TIME_ZONE = "America/New_York";
export const USAGE_PAGE_SIZE = 50;
export type UsageView = "agents" | "users" | "automations" | "runs";
export type UsageFilters = {
  from: string;
  to: string;
  view: UsageView;
  agent?: string;
  user?: string;
  automation?: string;
  trigger?: string;
  page: number;
};
type SearchParams = Record<string, string | string[] | undefined>;
const DAY_MS = 86_400_000;

function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number(value.slice(0, 4)) > 0 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

export function parseUsageFilters(
  sp: SearchParams,
  now = new Date(),
): UsageFilters {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: USAGE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const days = sp.days === "7" ? 7 : sp.days === "90" ? 90 : 30;
  const from =
    typeof sp.from === "string" && sp.from
      ? sp.from
      : new Date(Date.parse(today) - (days - 1) * DAY_MS)
          .toISOString()
          .slice(0, 10);
  const to = typeof sp.to === "string" && sp.to ? sp.to : today;
  if (
    !validDate(from) ||
    !validDate(to) ||
    from > to ||
    Date.parse(to) - Date.parse(from) >= 366 * DAY_MS
  ) {
    throw new Error(
      "Choose valid start and end dates, in order, covering at most 366 days.",
    );
  }
  const view =
    typeof sp.view === "string" &&
    ["users", "automations", "runs"].includes(sp.view)
      ? (sp.view as UsageView)
      : "agents";
  const page = typeof sp.page === "string" ? Number(sp.page) : 1;
  return {
    from,
    to,
    view,
    agent: typeof sp.agent === "string" && sp.agent ? sp.agent : undefined,
    user: typeof sp.user === "string" && sp.user ? sp.user : undefined,
    automation:
      typeof sp.automation === "string" && sp.automation
        ? sp.automation
        : undefined,
    trigger:
      typeof sp.trigger === "string" && sp.trigger ? sp.trigger : undefined,
    page:
      Number.isSafeInteger(page) && page > 0 && page <= 1_000_000 ? page : 1,
  };
}

export function usageHref(
  base: string,
  filters: UsageFilters,
  changes: Partial<UsageFilters> = {},
): string {
  const values = { ...filters, page: 1, ...changes };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !(key === "page" && value === 1))
      query.set(key, String(value));
  }
  return `${base}?${query}`;
}

export function usageDays(from: string, to: string): string[] {
  const result: string[] = [];
  for (let day = Date.parse(from); day <= Date.parse(to); day += DAY_MS) {
    result.push(new Date(day).toISOString().slice(0, 10));
  }
  return result;
}
