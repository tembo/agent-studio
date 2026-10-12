import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { lookupPricing } from "@/lib/pricing";
import { RunPricing } from "./run-pricing";
import { RunSteps } from "./run-steps";

const steps = [{
  ordinal: 1, summary: null, inputTokens: 1_000_000, outputTokens: 1_000_000,
  cacheReadTokens: 0, cacheWriteTokens: 0,
}];

describe("historical pricing display", () => {
  it("labels legacy estimates and retains their saved total without repricing steps", () => {
    const label = renderToStaticMarkup(<RunPricing pricing={null} cost={18} live={false} reused={false} />);
    expect(label).toContain("Legacy estimate");
    const body = renderToStaticMarkup(<RunSteps steps={steps} calls={[]} savedCost={18} />);
    expect(body).toContain("~$18.00");
    expect(body).not.toContain("~$12.00");
    expect(body.match(/~\$/g)).toHaveLength(1);
  });
  it("shows provider rates and their verification date", () => {
    const body = renderToStaticMarkup(<RunPricing pricing={lookupPricing("anthropic:claude-sonnet-5")} cost={12} live={false} reused={false} />);
    expect(body).toContain("$2.00 input / $10.00 output per 1M tokens");
    expect(body).toContain("Rates verified 2026-10-10");
    expect(body).toContain('href="https://platform.claude.com/docs/en/about-claude/pricing"');
  });
  it("does not substitute a current estimate for a missing saved cost", () => {
    const body = renderToStaticMarkup(<RunSteps steps={steps} calls={[]} pricing={lookupPricing("anthropic:claude-sonnet-5")} />);
    expect(body).not.toContain("~$12.00");
  });
  it("adds request costs without applying a long-context rate to the run total", () => {
    const requests = [1, 2].map((ordinal) => ({ ...steps[0], ordinal, inputTokens: 200_000, outputTokens: 1_000 }));
    const body = renderToStaticMarkup(<RunSteps steps={requests} calls={[]} pricing={lookupPricing("openai:gpt-5.5")} live />);
    expect(body).toContain("~$2.06");
    expect(body).not.toContain("~$4.09");
  });
  it("distinguishes reused output from unknown pricing", () => {
    expect(renderToStaticMarkup(<RunPricing pricing={null} cost={0} live={false} reused />)).toContain("no new model cost");
    expect(renderToStaticMarkup(<RunPricing pricing={null} cost={null} live={false} reused={false} />)).toContain("no verified pricing");
  });
  it("keeps sub-cent differences visible", () => {
    const smallStep = [{ ...steps[0], inputTokens: 1_000, outputTokens: 0 }];
    const oldModel = renderToStaticMarkup(<RunSteps steps={smallStep} calls={[]} pricing={lookupPricing("anthropic:claude-sonnet-4-6")} live />);
    const newModel = renderToStaticMarkup(<RunSteps steps={smallStep} calls={[]} pricing={lookupPricing("anthropic:claude-sonnet-5")} live />);
    expect(oldModel).toContain("$0.0030");
    expect(newModel).toContain("$0.0020");
  });
});
