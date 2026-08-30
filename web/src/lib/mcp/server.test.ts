import { beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Exercise the MCP server end-to-end over the protocol (tools/list, tools/call)
// using the SDK's in-memory transport pair — no HTTP, no DB. We mock the
// service-layer boundary so each tool's wiring + serialization is verified.
vi.mock("@/lib/workspace-agents", () => ({
  listAgents: vi.fn(),
  getAgentByName: vi.fn(),
}));
vi.mock("@/lib/runs-api", () => ({ getRun: vi.fn() }));
vi.mock("@/lib/runs-db", () => ({ listRunsForWorkspace: vi.fn() }));
vi.mock("@/lib/config", () => ({
  getPublicOrigin: () => "https://tas.example.com",
}));
// The write tools delegate to the shared action layer; mock it so we test the
// MCP wiring + role gate, not the (separately tested) action internals.
vi.mock("@/lib/api-v1/actions", () => ({
  triggerRun: vi.fn(),
  validateSpec: vi.fn(),
  createAutomationFor: vi.fn(),
  requestAgentChange: vi.fn(),
  createSlackAppFor: vi.fn(),
  updateSlackAppFor: vi.fn(),
  deleteSlackAppFor: vi.fn(),
  sendSlackMessageFor: vi.fn(),
}));

import { buildMcpServer, type McpContext } from "./server";
import { getAgentByName, listAgents } from "@/lib/workspace-agents";
import { getRun } from "@/lib/runs-api";
import { listRunsForWorkspace } from "@/lib/runs-db";
import {
  createSlackAppFor,
  sendSlackMessageFor,
  triggerRun,
  validateSpec,
} from "@/lib/api-v1/actions";
import type { WorkspaceRole } from "@/lib/rbac";

const mockListAgents = vi.mocked(listAgents);
const mockGetAgent = vi.mocked(getAgentByName);
const mockGetRun = vi.mocked(getRun);
const mockListRuns = vi.mocked(listRunsForWorkspace);
const mockTriggerRun = vi.mocked(triggerRun);
const mockValidate = vi.mocked(validateSpec);
const mockCreateSlackApp = vi.mocked(createSlackAppFor);
const mockSendSlackMessage = vi.mocked(sendSlackMessageFor);

function makeCtx(
  role: WorkspaceRole = "operator",
  oauthScopes?: readonly string[],
): McpContext {
  return {
    ok: true,
    workspace: {
      id: "ws-1",
      slug: "demo",
      name: "Demo",
      createdBy: "u-1",
      createdAt: new Date(),
      updatedAt: new Date(),
      faviconKind: "default-tembo",
      commitMode: "pull_request",
    },
    userId: "u-1",
    role,
    apiKeyId: "key-1",
    surface: "mcp" as const,
    ...(oauthScopes ? { oauthScopes } : {}),
  };
}

const ctx = makeCtx("operator");

async function connectedClientFor(c: McpContext): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(c);
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function connectedClient(): Promise<Client> {
  return connectedClientFor(ctx);
}

function parse(result: unknown): unknown {
  const r = result as { content: { type: string; text: string }[]; isError?: boolean };
  return JSON.parse(r.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildMcpServer", () => {
  it("advertises the TAS display name and public icon", async () => {
    const client = await connectedClient();
    expect(client.getServerVersion()).toEqual({
      name: "tembo-agent-studio",
      title: "Tembo Agent Studio",
      version: "1.0.0",
      icons: [
        {
          src: "https://tas.example.com/favicons/default-tembo.png?v=3",
          mimeType: "image/png",
          sizes: ["256x256"],
        },
      ],
      websiteUrl: "https://tas.example.com",
    });
  });

  it("advertises the full read + write tool set", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "claim_inbox_item",
      "complete_inbox_item",
      "create_automation",
      "create_slack_app",
      "delete_slack_app",
      "get_agent",
      "get_inbox_item",
      "get_run",
      "list_agents",
      "list_automations",
      "list_connections",
      "list_inbox_items",
      "list_runs",
      "list_slack_apps",
      "list_tools",
      "produce_inbox_item",
      "propose_inbox_action",
      "request_agent_change",
      "send_slack_message",
      "trigger_run",
      "update_slack_app",
      "validate_agent_spec",
    ]);
  });

  it("list_agents returns serialized agents", async () => {
    mockListAgents.mockResolvedValue({
      ok: true,
      agents: [
        {
          ok: true,
          filename: "greet.yaml",
          path: "agents/pydantic-agentspec/greet.yaml",
          format: "yaml",
          sourceContent: "name: greet\n",
          spec: { framework: "pydantic-agentspec", name: "greet" } as never,
        },
      ],
    });
    const client = await connectedClient();
    const out = parse(await client.callTool({ name: "list_agents", arguments: {} })) as {
      agents: { name: string; valid: boolean }[];
    };
    expect(out.agents[0]).toMatchObject({ name: "greet", valid: true });
    expect(mockListAgents).toHaveBeenCalledWith("ws-1");
  });

  it("list_agents surfaces no-repo as an error result", async () => {
    mockListAgents.mockResolvedValue({ ok: false, error: "no-repo" });
    const client = await connectedClient();
    const res = (await client.callTool({ name: "list_agents", arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no repository/i);
  });

  it("get_agent passes the name through and returns raw spec", async () => {
    mockGetAgent.mockResolvedValue({
      agent: {
        ok: true,
        filename: "greet.yaml",
        path: "agents/pydantic-agentspec/greet.yaml",
        format: "yaml",
        sourceContent: "name: greet\n",
        spec: { framework: "pydantic-agentspec", name: "greet" } as never,
      },
      raw: "name: greet\n",
    });
    const client = await connectedClient();
    const out = parse(await client.callTool({ name: "get_agent", arguments: { name: "greet" } })) as {
      raw: string;
    };
    expect(out.raw).toBe("name: greet\n");
    expect(mockGetAgent).toHaveBeenCalledWith("ws-1", "greet");
  });

  it("get_agent reports a missing agent as an error result", async () => {
    mockGetAgent.mockResolvedValue(null);
    const client = await connectedClient();
    const res = (await client.callTool({ name: "get_agent", arguments: { name: "ghost" } })) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
  });

  it("list_runs forwards filters and serializes rows", async () => {
    mockListRuns.mockResolvedValue([
      {
        id: "run-1",
        agentName: "greet",
        status: "succeeded",
        trigger: "manual",
        automationId: null,
        createdAt: new Date("2026-06-13T00:00:00Z"),
        startedAt: null,
        completedAt: null,
        userMessagePreview: "hi",
        errorMessagePreview: null,
        costUsd: 0.01,
        createdByName: null,
        createdByEmail: null,
        slack: null,
        agentVersionLabel: "v1",
      },
    ]);
    const client = await connectedClient();
    const out = parse(
      await client.callTool({ name: "list_runs", arguments: { status: ["succeeded"], limit: 10 } }),
    ) as { runs: { id: string; createdAt: string }[] };
    expect(out.runs[0].id).toBe("run-1");
    expect(out.runs[0].createdAt).toBe("2026-06-13T00:00:00.000Z");
    const [wsId, filters, options] = mockListRuns.mock.calls[0];
    expect(wsId).toBe("ws-1");
    expect(filters).toEqual({ statuses: ["succeeded"] });
    expect(options).toEqual({ limit: 10 });
  });

  it("get_run returns the full record", async () => {
    mockGetRun.mockResolvedValue({
      id: "run-1",
      workspaceId: "ws-1",
      agentName: "greet",
      agentPath: "agents/pydantic-agentspec/greet.yaml",
      userMessage: "hi",
      model: "anthropic:claude-sonnet-5",
      status: "succeeded",
      output: "Hello!",
      streamedOutput: null,
      errorMessage: null,
      failureCode: null,
      failureSummary: null,
      failureRecommendation: null,
      createdBy: "u-1",
      createdAt: "2026-06-13T00:00:00Z",
      startedAt: null,
      completedAt: null,
      tokensInput: 10,
      tokensOutput: 5,
      scaledownOriginalTokens: null,
      scaledownCompressedTokens: null,
      trigger: "manual",
      automationId: null,
      agentVersionId: null,
      agentVersionLabel: null,
      resumeCount: 0,
      resumedAt: null,
    });
    const client = await connectedClient();
    const out = parse(await client.callTool({ name: "get_run", arguments: { id: "run-1" } })) as {
      run: { output: string };
    };
    expect(out.run.output).toBe("Hello!");
    expect(mockGetRun).toHaveBeenCalledWith("run-1", "ws-1");
  });

  it("adds diagnostics only for workspace admins", async () => {
    mockGetRun.mockResolvedValue({
      id: "run-failed",
      workspaceId: "ws-1",
      agentName: "greet",
      agentPath: "agents/pydantic-agentspec/greet.yaml",
      userMessage: "hi",
      model: "anthropic:claude-sonnet-5",
      status: "failed",
      output: "",
      streamedOutput: null,
      errorMessage: "Traceback: private diagnostic detail",
      failureCode: "provider_unavailable",
      failureSummary: "A provider was temporarily unavailable.",
      failureRecommendation: "Run the agent again.",
      createdBy: "u-1",
      createdAt: "2026-06-13T00:00:00Z",
      startedAt: null,
      completedAt: "2026-06-13T00:00:01Z",
      tokensInput: null,
      tokensOutput: null,
      scaledownOriginalTokens: null,
      scaledownCompressedTokens: null,
      trigger: "manual",
      automationId: null,
      agentVersionId: null,
      agentVersionLabel: null,
      resumeCount: 0,
      resumedAt: null,
    });

    for (const role of ["viewer", "operator"] as const) {
      const regularUser = await connectedClientFor(makeCtx(role));
      const regularOut = parse(
        await regularUser.callTool({
          name: "get_run",
          arguments: { id: "run-failed" },
        }),
      ) as { run: Record<string, unknown> };
      expect(regularOut.run.errorMessage).toBe(
        "A provider was temporarily unavailable.",
      );
      expect(regularOut.run).not.toHaveProperty("errorDetails");
    }

    const admin = await connectedClientFor(makeCtx("workspace_admin"));
    const adminOut = parse(
      await admin.callTool({ name: "get_run", arguments: { id: "run-failed" } }),
    ) as { run: Record<string, unknown> };
    expect(adminOut.run.errorMessage).toBe(
      "A provider was temporarily unavailable.",
    );
    expect(adminOut.run.errorDetails).toBe(
      "Traceback: private diagnostic detail",
    );
  });

  it("validate_agent_spec is available to a viewer (read-only)", async () => {
    mockValidate.mockReturnValue({
      ok: true,
      result: { valid: true, framework: "pydantic-agentspec", name: "greet", format: "yaml" },
    });
    const client = await connectedClientFor(makeCtx("viewer"));
    const out = parse(
      await client.callTool({
        name: "validate_agent_spec",
        arguments: { content: "name: greet", format: "yaml" },
      }),
    ) as { valid: boolean };
    expect(out.valid).toBe(true);
  });

  it("trigger_run is denied for a viewer and never calls the action", async () => {
    const client = await connectedClientFor(makeCtx("viewer"));
    const res = (await client.callTool({
      name: "trigger_run",
      arguments: { agent: "greet" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/operator/i);
    expect(mockTriggerRun).not.toHaveBeenCalled();
  });

  it("trigger_run as operator delegates and returns the run id", async () => {
    mockTriggerRun.mockResolvedValue({ ok: true, runId: "run-9" });
    const client = await connectedClientFor(makeCtx("operator"));
    const out = parse(
      await client.callTool({ name: "trigger_run", arguments: { agent: "greet", message: "hi" } }),
    ) as { runId: string };
    expect(out.runId).toBe("run-9");
    expect(mockTriggerRun).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-1" }),
      { agent: "greet", message: "hi", preferDraft: undefined },
    );
  });

  it("trigger_run surfaces an action failure as an error result", async () => {
    mockTriggerRun.mockResolvedValue({ ok: false, status: 422, error: "missing connection" });
    const client = await connectedClientFor(makeCtx("operator"));
    const res = (await client.callTool({
      name: "trigger_run",
      arguments: { agent: "greet" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("missing connection");
  });

  it("send_slack_message is denied for a viewer (operator-only) and never calls the action", async () => {
    const client = await connectedClientFor(makeCtx("viewer"));
    const res = (await client.callTool({
      name: "send_slack_message",
      arguments: { text: "hi", toEmail: "a@b.com" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/operator/i);
    expect(mockSendSlackMessage).not.toHaveBeenCalled();
  });

  it("write tools reject an operator OAuth token without mcp:write", async () => {
    const client = await connectedClientFor(
      makeCtx("operator", ["mcp:read"]),
    );
    const res = (await client.callTool({
      name: "send_slack_message",
      arguments: { text: "hi", toEmail: "a@b.com" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/mcp:write/i);
    expect(mockSendSlackMessage).not.toHaveBeenCalled();
  });

  it("send_slack_message as operator delegates and returns the result", async () => {
    mockSendSlackMessage.mockResolvedValue({
      ok: true,
      channel: "U123",
      ts: "1700000000.000100",
    });
    const client = await connectedClientFor(makeCtx("operator"));
    const res = (await client.callTool({
      name: "send_slack_message",
      arguments: { text: "ping", toEmail: "a@b.com", slackApp: "Helper" },
    })) as { content: { text: string }[] };
    expect(mockSendSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "operator" }),
      expect.objectContaining({ text: "ping", toEmail: "a@b.com", slackApp: "Helper" }),
    );
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      sent: true,
      channel: "U123",
    });
  });

  it("create_slack_app is denied for an operator (admin-only) and never calls the action", async () => {
    const client = await connectedClientFor(makeCtx("operator"));
    const res = (await client.callTool({
      name: "create_slack_app",
      arguments: { name: "Helper" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/workspace_admin/i);
    expect(mockCreateSlackApp).not.toHaveBeenCalled();
  });

  it("create_slack_app as workspace_admin delegates and returns the app", async () => {
    mockCreateSlackApp.mockResolvedValue({
      ok: true,
      slackApp: {
        id: "app-1",
        workspaceId: "ws-1",
        name: "Helper",
        slackAppId: null,
        hasSigningSecret: false,
        clientId: null,
        hasClientSecret: false,
        hasBotToken: false,
        teamId: null,
        botUserId: null,
        defaultOwnerUserId: "u-1",
        agentLabels: ["support"],
        status: "configuring",
        createdBy: "u-1",
        createdAt: new Date("2026-06-13T00:00:00Z"),
        updatedAt: new Date("2026-06-13T00:00:00Z"),
      },
    });
    const client = await connectedClientFor(makeCtx("workspace_admin"));
    const out = parse(
      await client.callTool({
        name: "create_slack_app",
        arguments: { name: "Helper", agentLabels: ["support"] },
      }),
    ) as { slackApp: { id: string; status: string; hasBotToken: boolean } };
    expect(out.slackApp).toMatchObject({ id: "app-1", status: "configuring", hasBotToken: false });
    expect(mockCreateSlackApp).toHaveBeenCalledWith(
      expect.objectContaining({ role: "workspace_admin" }),
      expect.objectContaining({ name: "Helper", agentLabels: ["support"] }),
    );
  });
});
