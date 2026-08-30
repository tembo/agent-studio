import { describe, expect, it } from "vitest";

import type { AgentVersion } from "./agent-versions";
import { pendingDraftFromContent } from "./agent-draft-status";

const stable: AgentVersion = {
  id: "version-1",
  workspaceId: "workspace-1",
  agentName: "digest",
  agentPath: "agents/pydantic-agentspec/digest.yaml",
  versionNumber: 2,
  framework: "pydantic-agentspec",
  model: "anthropic:claude-sonnet-5",
  specContent: "name: digest\nmodel: old",
  specFormat: "yaml",
  sourceCommitSha: null,
  stage: "stable",
  changeSummary: null,
  createdBy: "user-1",
  createdAt: new Date("2026-08-20T12:00:00Z"),
};

describe("pendingDraftFromContent", () => {
  it("returns null when the draft matches stable", () => {
    expect(
      pendingDraftFromContent({
        agentName: stable.agentName,
        agentPath: stable.agentPath,
        sourceContent: stable.specContent,
        stable,
      }),
    ).toBeNull();
  });

  it("reports the stable version and line changes", () => {
    expect(
      pendingDraftFromContent({
        agentName: stable.agentName,
        agentPath: stable.agentPath,
        sourceContent: "name: digest\nmodel: new\ninstructions: improved",
        stable,
      }),
    ).toMatchObject({
      stableVersionNumber: 2,
      stableChangedAt: stable.createdAt,
      diffStats: { added: 2, removed: 1 },
    });
  });

  it("treats an agent without stable as pending its first promotion", () => {
    expect(
      pendingDraftFromContent({
        agentName: "new-agent",
        agentPath: "agents/pydantic-agentspec/new-agent.yaml",
        sourceContent: "name: new-agent\nmodel: new",
        stable: null,
      }),
    ).toMatchObject({
      stableVersionNumber: null,
      stableChangedAt: null,
      diffStats: { added: 2, removed: 0 },
    });
  });
});
