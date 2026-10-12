import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import catalog from "./model-pricing.json";
import { estimateRequestCost, lookupPricing } from "./pricing";

const canonical = JSON.parse(readFileSync(new URL("../../../api/src/model-pricing.json", import.meta.url), "utf8"));
const cases = JSON.parse(readFileSync(new URL("../../../api/src/pricing-cases.json", import.meta.url), "utf8")) as Array<{
  model: string; input: number; output: number; read: number; write: number; expected: number | null;
}>;

describe("model pricing", () => {
  it("ships the same catalog in both Docker contexts", () => {
    expect(catalog).toEqual(canonical);
    const models = catalog.rates.flatMap((r) => r.models);
    expect(new Set(models).size).toBe(models.length);
  });
  it.each(cases)("prices $model ($input in / $read cached)", (c) => {
    const actual = estimateRequestCost(lookupPricing(c.model), c.input, c.output, c.read, c.write)?.total ?? null;
    if (c.expected === null) expect(actual).toBeNull();
    else expect(actual).toBeCloseTo(c.expected, 9);
  });
  it("uses a saved rate instead of replacing it with today's catalog", () => {
    const saved = structuredClone(lookupPricing("anthropic:claude-sonnet-5")!);
    saved.rate.input = 99;
    expect(estimateRequestCost(saved, 1_000_000, 0)?.total).toBe(99);
    expect(estimateRequestCost(lookupPricing("anthropic:claude-sonnet-5"), 1_000_000, 0)?.total).toBe(2);
  });
  it("preserves the historical Sonnet 5.5 cache rate in saved snapshots", () => {
    const saved = structuredClone(lookupPricing("anthropic:claude-sonnet-5-5")!);
    saved.verifiedOn = "2026-10-07";
    saved.rate.cacheRead = 0.2;
    expect(estimateRequestCost(saved, 0, 0, 1_000_000)?.total).toBe(0.2);
    expect(estimateRequestCost(lookupPricing("anthropic:claude-sonnet-5-5"), 0, 0, 1_000_000)?.total).toBe(0.1);
  });
  it("rejects non-finite token counts", () => {
    expect(estimateRequestCost(lookupPricing("anthropic:claude-sonnet-5"), NaN, 0)).toBeNull();
  });
});
