import { formatCurrency, type PricingSnapshot } from "@/lib/pricing";

export function RunPricing({
  pricing, cost, live, reused,
}: {
  pricing: PricingSnapshot | null;
  cost: number | null;
  live: boolean;
  reused: boolean;
}) {
  return (
    <div className="flex gap-3">
      <dt className="text-foreground-weak w-24 shrink-0 font-medium">Pricing</dt>
      <dd className="text-foreground-weak">
        {reused ? "Reused output · no new model cost" : pricing ? (
          <>
            {formatCurrency(pricing.rate.input)} input / {formatCurrency(pricing.rate.output)} output per 1M tokens
            {" · "}
            <a href={pricing.source} target="_blank" rel="noreferrer" className="underline">
              Rates verified {pricing.verifiedOn}
            </a>
            {!live && cost === null && " · Estimate unavailable"}
          </>
        ) : cost !== null ? (
          "Legacy estimate · rates not recorded"
        ) : (
          "Estimate unavailable · no verified pricing"
        )}
      </dd>
    </div>
  );
}
