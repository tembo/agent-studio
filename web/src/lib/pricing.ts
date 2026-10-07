import catalog from "./model-pricing.json";

export type TokenRate = {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
};
export type ModelRate = TokenRate & {
  longContext?: TokenRate & { threshold: number };
};
export type PricingSnapshot = {
  verifiedOn: string;
  source: string;
  rate: ModelRate;
};

export function lookupPricing(model: string): PricingSnapshot | null {
  const name = model.toLowerCase();
  const entry = catalog.rates.find((r) => r.models.includes(name));
  if (!entry) return null;
  const rate: ModelRate = {
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead,
    cacheWrite: entry.cacheWrite,
    ...("longContext" in entry ? { longContext: entry.longContext } : {}),
  };
  const provider = name.split(":")[0] as keyof typeof catalog.sources;
  return {
    verifiedOn: catalog.verifiedOn,
    source: catalog.sources[provider],
    rate,
  };
}

/** One request, with disjoint uncached input / cache read / cache write counts.
 * Thresholds must never be applied to a multi-request run's aggregate usage. */
export function estimateRequestCost(
  pricing: PricingSnapshot | null,
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): { input: number; output: number; total: number } | null {
  if (
    !pricing ||
    [input, output, cacheRead, cacheWrite].some((n) => !Number.isFinite(n) || n < 0)
  ) return null;
  const base = pricing.rate;
  const rate =
    base.longContext && input + cacheRead + cacheWrite > base.longContext.threshold
      ? base.longContext
      : base;
  if (
    (cacheRead > 0 && rate.cacheRead === null) ||
    (cacheWrite > 0 && rate.cacheWrite === null)
  ) return null;
  const inputCost =
    (input * rate.input +
      cacheRead * (rate.cacheRead ?? 0) +
      cacheWrite * (rate.cacheWrite ?? 0)) / 1_000_000;
  const outputCost = output * rate.output / 1_000_000;
  return { input: inputCost, output: outputCost, total: inputCost + outputCost };
}

export function formatTokens(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** 3-significant-figure abbreviation: 9_502 → "9.50k", 15_100 → "15.1k",
 *  152_000 → "152k", 1_520_000 → "1.52M". Sub-1000 shows the plain number. */
export function abbreviateTokens(n: number): string {
  if (n < 1000) return String(n);
  for (const [div, unit] of [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "k"],
  ] as const) {
    if (n >= div) {
      const v = n / div;
      const s = v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(1) : v.toFixed(2);
      return `${s}${unit}`;
    }
  }
  return String(n);
}

/** Cost rounded to the nearest penny, leading zero dropped: 0.048 → "$.05". */
export function formatPenny(usd: number): string {
  return `$${usd.toFixed(2).replace(/^0(?=\.)/, "")}`;
}

export function formatCurrency(usd: number): string {
  // Sub-cent values aren't useful at this UI level; floor to two
  // decimals but bump to three when the cost is below $0.01 so users
  // see something other than "$0.00".
  const decimals = usd < 0.01 ? 4 : usd < 1 ? 3 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(usd);
}
