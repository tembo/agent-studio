import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EffortPicker } from "./effort-picker";

vi.mock("../chat/actions", () => ({ chatSubmitAction: vi.fn() }));

function render(model: string, canEdit = true, model_settings = {}) {
  return renderToStaticMarkup(<EffortPicker
    source={JSON.stringify({ name: "example-agent", model, instructions: "Hello", model_settings })}
    format="json" workspaceSlug="test" agentName="example-agent" canEdit={canEdit}
  />);
}

describe("effort picker", () => {
  it("shows the provider default without selecting an explicit level", () => {
    const markup = render("anthropic:claude-sonnet-5");
    expect(markup).toContain('value="" selected=""');
    expect(markup).toContain("Provider default (High)");
    expect(markup).toContain('value="xhigh"');
  });
  it("keeps read-only and unsupported models out of the save flow", () => {
    expect(render("anthropic:claude-sonnet-5", false)).not.toContain("<select");
    const unknown = render("anthropic:claude-sonnet-unknown");
    expect(unknown).not.toContain("<select");
    expect(unknown).toContain("no verified effort options");
  });
  it("shows explicit and advanced settings honestly", () => {
    expect(render("openai:gpt-5.5", true, { openai_reasoning_effort: "none" })).toContain('value="none" selected=""');
    const custom = render("anthropic:claude-sonnet-5", true, { thinking: "high" });
    expect(custom).toContain("Custom thinking settings");
    expect(custom).not.toContain("<select");
  });
});
