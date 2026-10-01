import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WORKSPACE_ROLES, type WorkspaceRole } from "@/lib/rbac";
import type { RunRecord } from "@/lib/runs-api";
import { FailedReason } from "./failed-reason";

function markup(role: WorkspaceRole, overrides: Partial<RunRecord> = {}) {
  const run = {
    agentName: "hello",
    failureCode: "agent_configuration",
    failureSummary: "The agent configuration is invalid.",
    failureRecommendation: "Review the agent definition.",
    errorMessage: "ValueError: missing required field <model>",
    ...overrides,
  } as RunRecord;
  return renderToStaticMarkup(<FailedReason run={run} workspaceSlug="acme" role={role} />);
}

describe("run failure technical details", () => {
  it.each(WORKSPACE_ROLES)("lets a %s inspect and copy diagnostics", (role) => {
    const html = markup(role);
    expect(html).toContain("Technical details");
    expect(html).toContain("ValueError: missing required field &lt;model&gt;");
    expect(html).toContain('aria-label="Copy technical details to clipboard"');
    expect(html).not.toMatch(/<details[^>]*\bopen(?:[\s=>])/);
  });

  it.each([null, ""])("omits the section when diagnostics are %s", (errorMessage) => {
    const html = markup("operator", { errorMessage });
    expect(html).toContain("The agent configuration is invalid.");
    expect(html).not.toContain("Technical details");
    expect(html).not.toContain("Copy technical details");
  });

  it("keeps historical diagnostics available without a structured summary", () => {
    const html = markup("operator", { failureSummary: null, failureCode: null, failureRecommendation: null });
    expect(html).toContain("The run ended unexpectedly.");
    expect(html).toContain("Technical details");
  });

  it("keeps viewers' recovery guidance read-only", () => {
    const html = markup("viewer");
    expect(html).toContain("Ask an operator or workspace admin to review the agent definition.");
    expect(html).not.toContain('href="/acme/agents/hello/definition"');
  });

  it("keeps provider settings actions restricted to admins", () => {
    for (const role of ["viewer", "operator"] as const) {
      expect(markup(role, { failureCode: "provider_credentials" })).not.toContain('href="/acme/settings/providers"');
    }
    expect(markup("workspace_admin", { failureCode: "provider_credentials" })).toContain('href="/acme/settings/providers"');
  });
});
