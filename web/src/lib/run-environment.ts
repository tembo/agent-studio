export const RUN_ENVIRONMENTS = ["production", "development"] as const;

export type RunEnvironment = (typeof RUN_ENVIRONMENTS)[number];
export type RunEnvironmentFilter = RunEnvironment | "all";

export function parseRunEnvironmentFilter(
  raw: string | string[] | undefined,
  fallback: RunEnvironmentFilter = "production",
): RunEnvironmentFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "production" || value === "development" || value === "all"
    ? value
    : fallback;
}

export function runEnvironmentLabel(environment: RunEnvironment): string {
  return environment === "production" ? "Production" : "Development";
}
