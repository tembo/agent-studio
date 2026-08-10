import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AuthorizeApiSuccess } from "@/lib/api-auth";
import {
  claimInboxItemFor,
  completeInboxItemFor,
  createAutomationFor,
  createSlackAppFor,
  deleteSlackAppFor,
  getInboxItemFor,
  listInboxItemsFor,
  produceInboxItemFor,
  proposeInboxActionFor,
  requestAgentChange,
  sendSlackMessageFor,
  triggerRun,
  updateSlackAppFor,
  validateSpec,
} from "@/lib/api-v1/actions";
import {
  serializeAgent,
  serializeAutomation,
  serializeConnections,
  serializeInboxItem,
  serializeRunListItem,
  serializeRunRecord,
  serializeSlackApp,
  serializeTool,
} from "@/lib/api-v1/serializers";
import { FRAMEWORKS, type Framework } from "@/lib/agent-framework";
import { listAutomations } from "@/lib/automations-api";
import { listConnectionsForUser } from "@/lib/composio-connections";
import { getPublicOrigin } from "@/lib/config";
import { listNativeConnectionsForUser } from "@/lib/connections";
import { FAVICON_ASSET_VERSION } from "@/lib/favicon-constants";
import { listToolsForUser } from "@/lib/mcp-tools";
import { MCP_OAUTH_WRITE_SCOPE } from "@/lib/mcp-oauth";
import { meetsMinRole } from "@/lib/rbac";
import { getRun } from "@/lib/runs-api";
import { listRunsForWorkspace, type RunListFilters } from "@/lib/runs-db";
import { listSlackApps } from "@/lib/slack-apps";
import { getAgentByName, listAgents } from "@/lib/workspace-agents";

// The MCP server exposed at /mcp. It mirrors the /api/v1 REST surface as MCP
// tools so a client like Claude Code can read a TAS deployment's live state and
// drive it. Stateless: a fresh McpServer is built per request and closes over
// the resolved auth context (which workspace, which acting user, what role) so
// every tool is already scoped — no tool takes a workspace/user argument.
//
// Read tools require viewer (the credential already cleared that in the auth
// boundary); write tools re-check the live role and, for OAuth, mcp:write.

export type McpContext = AuthorizeApiSuccess;

/** Wrap any JSON-serializable payload as an MCP text result. */
function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** An error result the model can read and react to (vs. throwing). */
function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const FRAMEWORK_VALUES = FRAMEWORKS as readonly [Framework, ...Framework[]];

export type McpServerOptions = {
  /** The run that's calling /mcp (when an agent calls it mid-run), recorded as
   *  the parent of any run trigger_run spawns. */
  parentRunId?: string;
};

export function buildMcpServer(
  ctx: McpContext,
  options: McpServerOptions = {},
): McpServer {
  const publicOrigin = getPublicOrigin();
  const server = new McpServer({
    name: "tembo-agent-studio",
    title: "Tembo Agent Studio",
    version: "1.0.0",
    icons: [
      {
        src: `${publicOrigin}/favicons/default-tembo.png?v=${FAVICON_ASSET_VERSION}`,
        mimeType: "image/png",
        sizes: ["256x256"],
      },
    ],
    websiteUrl: publicOrigin,
  });

  server.registerTool(
    "list_agents",
    {
      description:
        "List every agent in this workspace's connected repo, including specs " +
        "that fail to parse (so you can see and fix them). Returns each agent's " +
        "name, file path, framework, validity, and parsed spec.",
    },
    async () => {
      const result = await listAgents(ctx.workspace.id);
      if (!result.ok) {
        return errorResult(
          result.error === "no-repo"
            ? "No repository is connected to this workspace."
            : `Could not read agents: ${result.error}${result.detail ? ` (${result.detail})` : ""}`,
        );
      }
      return json({ agents: result.agents.map(serializeAgent) });
    },
  );

  server.registerTool(
    "get_agent",
    {
      description:
        "Get one agent by its declared name, including the raw on-disk spec " +
        "text and any sidecar tools-module / skills content. Use this to read " +
        "exactly what's deployed before proposing an edit.",
      inputSchema: { name: z.string().describe("The agent's declared name (matches its filename).") },
    },
    async ({ name }) => {
      const found = await getAgentByName(ctx.workspace.id, name);
      if (!found) return errorResult(`No agent named "${name}" in this workspace.`);
      return json({
        agent: serializeAgent(found.agent),
        raw: found.raw,
        toolsModuleContent: found.toolsModuleContent ?? null,
        skillsContent: found.skillsContent ?? null,
      });
    },
  );

  server.registerTool(
    "list_runs",
    {
      description:
        "List recent agent runs for this workspace, newest first. Filter by " +
        "status, agent name, and/or trigger. Returns compact rows (status, " +
        "cost, previews) — call get_run for full output.",
      inputSchema: {
        status: z
          .enum(["queued", "running", "succeeded", "failed", "cancelled"])
          .array()
          .optional()
          .describe("Only runs in these statuses."),
        agent: z.string().optional().describe("Only runs of this agent."),
        trigger: z
          .enum(["manual", "schedule", "event"])
          .array()
          .optional()
          .describe("Only runs from these triggers."),
        limit: z.number().int().min(1).max(50).optional().describe("Max rows (default 50)."),
      },
    },
    async ({ status, agent, trigger, limit }) => {
      const filters: RunListFilters = {
        ...(status?.length ? { statuses: status } : {}),
        ...(trigger?.length ? { triggers: trigger } : {}),
        ...(agent ? { agentName: agent } : {}),
      };
      const runs = await listRunsForWorkspace(ctx.workspace.id, filters, {
        ...(limit ? { limit } : {}),
      });
      return json({ runs: runs.map(serializeRunListItem) });
    },
  );

  server.registerTool(
    "get_run",
    {
      description:
        "Get one run by id with its full output, live streamed output, error " +
        "message, and token usage. Use after trigger_run, or to inspect why a " +
        "run failed.",
      inputSchema: { id: z.string().describe("The run id.") },
    },
    async ({ id }) => {
      let run;
      try {
        run = await getRun(id, ctx.workspace.id);
      } catch {
        return errorResult("Could not reach the run service.");
      }
      if (!run) return errorResult(`No run with id "${id}" in this workspace.`);
      return json({ run: serializeRunRecord(run) });
    },
  );

  server.registerTool(
    "list_tools",
    {
      description:
        "List the cached tool catalog for the authenticated user (composio + " +
        "native-mcp). Each tool's `slug` is what goes into an agent's " +
        "`connections: tools: [...]` — use this when authoring connections.",
    },
    async () => {
      const tools = await listToolsForUser(ctx.workspace.id, ctx.userId);
      return json({ tools: tools.map(serializeTool) });
    },
  );

  server.registerTool(
    "list_connections",
    {
      description:
        "List the authenticated user's per-user connection status (composio + " +
        "native-mcp): provider, slot name, and whether it's active. Use to " +
        "check an agent's declared connections are authorized before a run. " +
        "No tokens are returned.",
    },
    async () => {
      const [composio, nativeMcp] = await Promise.all([
        listConnectionsForUser(ctx.workspace.id, ctx.userId),
        listNativeConnectionsForUser(ctx.workspace.id, ctx.userId),
      ]);
      return json({ connections: serializeConnections(composio, nativeMcp) });
    },
  );

  server.registerTool(
    "list_automations",
    {
      description: "List the workspace's scheduled automations (cron-triggered agent runs).",
    },
    async () => {
      const automations = await listAutomations(ctx.workspace.id);
      return json({ automations: automations.map(serializeAutomation) });
    },
  );

  server.registerTool(
    "list_slack_apps",
    {
      description: "List the workspace's Slack bots (secret-safe — no tokens).",
    },
    async () => {
      const apps = await listSlackApps(ctx.workspace.id);
      return json({ slackApps: apps.map(serializeSlackApp) });
    },
  );

  server.registerTool(
    "list_inbox_items",
    {
      description:
        "List/search Tasks Inbox items for this workspace — the shared queue " +
        "humans and agents work. Filter by status, source, and item type; " +
        "free-text `search` matches the title + the item's context payload; " +
        "sort by any column. 'open' items need a proposal or a claim; " +
        "'awaiting_human' items have a proposed action a person should review; " +
        "'done'/'dismissed' are resolved.",
      inputSchema: {
        status: z
          .enum(["open", "claimed", "awaiting_human", "done", "dismissed"])
          .array()
          .optional()
          .describe("Only items in these statuses."),
        source: z.string().optional().describe("Only items from this source (e.g. 'linkedin')."),
        itemType: z
          .string()
          .optional()
          .describe("Only this item type (e.g. 'connection_request')."),
        search: z
          .string()
          .optional()
          .describe("Free-text match against the title and context payload."),
        sort: z
          .enum(["created_at", "updated_at", "title", "item_type", "source", "status"])
          .optional()
          .describe("Sort column (default created_at)."),
        dir: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc)."),
        limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 100)."),
      },
    },
    async ({ status, source, itemType, search, sort, dir, limit }) => {
      const res = await listInboxItemsFor(
        ctx,
        {
          ...(status?.length ? { statuses: status } : {}),
          ...(source ? { source } : {}),
          ...(itemType ? { itemType } : {}),
          ...(search ? { search } : {}),
          ...(sort ? { sort } : {}),
          ...(dir ? { dir } : {}),
        },
        limit,
      );
      return json({ inboxItems: res.items.map(serializeInboxItem) });
    },
  );

  server.registerTool(
    "get_inbox_item",
    {
      description:
        "Get one Tasks Inbox item by id — its full context payload, the agent's " +
        "proposed action, and any human final action.",
      inputSchema: { id: z.string().describe("The inbox item id.") },
    },
    async ({ id }) => {
      const res = await getInboxItemFor(ctx, id);
      if (!res.ok) return errorResult(res.error);
      return json({ inboxItem: serializeInboxItem(res.item) });
    },
  );

  // ── Write tools (operator) ──────────────────────────────────────────
  // Connecting only required viewer; these re-check operator on the resolved
  // role so a viewer key can read but not act.
  const oauthAllowsWrite =
    !ctx.oauthScopes || ctx.oauthScopes.includes(MCP_OAUTH_WRITE_SCOPE);
  const isOperator =
    oauthAllowsWrite && meetsMinRole(ctx.role, "operator");
  const operatorOnly = () =>
    errorResult(
      !oauthAllowsWrite
        ? "This OAuth connection did not grant the mcp:write scope. Reconnect it with write access."
        : "This action requires the operator role; the authenticated user is a viewer.",
    );
  const isAdmin =
    oauthAllowsWrite && meetsMinRole(ctx.role, "workspace_admin");
  const adminOnly = () =>
    errorResult(
      "This action requires the workspace_admin role.",
    );

  server.registerTool(
    "validate_agent_spec",
    {
      description:
        "Parse an agent spec WITHOUT writing it to the repo — use this to check " +
        "a draft before committing. Provide `format` (yaml|json) or a `filename` " +
        "to infer it. Returns validity plus the detected framework and name.",
      inputSchema: {
        content: z.string().describe("The full spec text."),
        format: z.enum(["yaml", "json"]).optional(),
        filename: z.string().optional().describe("Used to infer format if not given."),
      },
    },
    async ({ content, format, filename }) => {
      const out = validateSpec({ content, format, filename });
      if (!out.ok) return errorResult(out.error);
      return json(out.result);
    },
  );

  server.registerTool(
    "trigger_run",
    {
      description:
        "Run an agent now, acting as this API key's user (so the run uses that " +
        "user's connections). Returns the run id — poll get_run for output. " +
        "Runs the stable version by default; set preferDraft to run the live file.",
      inputSchema: {
        agent: z.string().describe("The agent's declared name."),
        message: z.string().optional().describe("Optional user input for the run."),
        preferDraft: z.boolean().optional().describe("Run the live draft instead of stable."),
      },
    },
    async ({ agent, message, preferDraft }) => {
      if (!isOperator) return operatorOnly();
      const res = await triggerRun(ctx, {
        agent,
        message,
        preferDraft,
        parentRunId: options.parentRunId,
      });
      if (!res.ok) return errorResult(res.error);
      return json({ runId: res.runId });
    },
  );

  server.registerTool(
    "create_automation",
    {
      description:
        "Schedule an agent to run on a cron expression. The scheduled run acts " +
        "as this API key's user. Returns the created automation.",
      inputSchema: {
        name: z.string().describe("Human label for the automation."),
        agent: z.string().describe("The agent to run."),
        cron: z.string().describe("Cron expression, e.g. '0 9 * * 1' (Mon 9am)."),
        inputMessage: z.string().optional().describe("Optional input passed to each run."),
        enabled: z.boolean().optional().describe("Start enabled (default true)."),
        useDraft: z.boolean().optional().describe("Run the live draft instead of stable."),
      },
    },
    async ({ name, agent, cron, inputMessage, enabled, useDraft }) => {
      if (!isOperator) return operatorOnly();
      const res = await createAutomationFor(ctx, {
        name,
        agent,
        cron,
        inputMessage,
        enabled,
        useDraft,
      });
      if (!res.ok) return errorResult(res.error);
      return json({ automation: serializeAutomation(res.automation) });
    },
  );

  server.registerTool(
    "request_agent_change",
    {
      description:
        "Hand an authoring request to the Tembo Coding Agent, which opens a PR " +
        "(or commits directly, per workspace settings). To EDIT an existing " +
        "agent pass `agent` + `description`; to CREATE one pass `name` + " +
        "`description` (+ optional framework). Returns the Tembo task URL. " +
        "Tip: if you can edit the repo files directly, that's usually faster " +
        "than this — use this when you want TAS to drive the change.",
      inputSchema: {
        description: z.string().describe("What to change, or what the new agent should do."),
        agent: z.string().optional().describe("Existing agent to edit (omit to create)."),
        name: z.string().optional().describe("Display name for a NEW agent."),
        framework: z.enum(FRAMEWORK_VALUES).optional().describe("New-agent framework (default pydantic-agentspec)."),
      },
    },
    async ({ description, agent, name, framework }) => {
      if (!isOperator) return operatorOnly();
      const res = await requestAgentChange(ctx, { description, agent, name, framework });
      if (!res.ok) return errorResult(res.error);
      return json(res.result);
    },
  );

  server.registerTool(
    "produce_inbox_item",
    {
      description:
        "Add an item to the Tasks Inbox — the way an agent surfaces something a " +
        "human should review. Include your best-guess `proposedAction` (text " +
        "and/or structured fields) so the human reviews-and-edits rather than " +
        "starts from scratch; the diff between your guess and what they submit " +
        "trains future autonomy. With a proposal the item is ready for review; " +
        "without one it sits 'open' for someone to pick up. To point one item at " +
        "several things to review (e.g. the top 10 Linear triage tickets as one " +
        "task), pass `links: [{ label, url }]` — they render as a clickable list, " +
        "preferable to a Markdown link list in proposedActionText. For a narrative " +
        "digest, pass the document as a plain-string Markdown `context` (rendered " +
        "full-width at reading size) with sources linked inline, and mirror them " +
        "in `links`. Returns the item.",
      inputSchema: {
        itemType: z
          .string()
          .describe("e.g. 'connection_request' | 'message_reply' | 'notification' | 'post_engagement'."),
        title: z.string().describe("Short label for the triage list row."),
        source: z.string().optional().describe("Where it came from (default 'agent')."),
        externalRef: z.string().optional().describe("Producer's id for idempotent re-pushes."),
        url: z
          .string()
          .optional()
          .describe(
            "Deep link to the source object (Linear issue / Pylon ticket / " +
            "Attio record / task URL). Shown as an 'Open in …' link on the item.",
          ),
        externalTs: z
          .number()
          .optional()
          .describe(
            "Source's latest-activity time (epoch ms). If a later run reports a " +
            "NEWER value for the same externalRef, the item reopens + refreshes " +
            "(e.g. a reply to an archived thread comes back).",
          ),
        context: z
          .union([z.record(z.string(), z.unknown()), z.string()])
          .optional()
          .describe(
            "The raw payload to review — a JSON object (rendered as labeled " +
            "fields), or a plain string (stored as { text }). A plain string " +
            "that is Markdown renders as a full-width document — write " +
            "digests/newsletters this way, most important items first, with " +
            "every claim's source linked inline.",
          ),
        proposedActionText: z.string().optional().describe("Your proposed reply / decision."),
        proposedActionFields: z.record(z.string(), z.unknown()).optional().describe("Structured proposal params."),
        options: z
          .array(
            z.object({
              id: z.string().describe("Stable option id, e.g. 'reply' | 'archive' | 'ignore'."),
              label: z.string().describe("Button label, e.g. 'Send reply'."),
              kind: z.enum(["reply", "oneclick"]).describe("'reply' shows an editable draft; 'oneclick' is one-tap."),
              draft: z.string().optional().describe("For kind 'reply': the suggested text (editable)."),
              recommended: z.boolean().optional().describe("Mark the agent's default pick."),
              execute: z
                .object({
                  provider: z.string().describe("Executor key, e.g. 'linkedin'."),
                  op: z.string().describe("Operation, e.g. 'send' | 'archive'."),
                  params: z.record(z.string(), z.unknown()).optional().describe("e.g. { convId }."),
                })
                .optional()
                .describe(
                  "How to perform this action on click. Omit ONLY when clicking " +
                  "should just resolve the item with no side effect (e.g. 'Ignore') " +
                  "— an option with no execute still COMPLETES the item.",
                ),
            }),
          )
          .optional()
          .describe(
            "Action menu rendered as buttons. EVERY option RESOLVES (completes) " +
            "the item when clicked — options are for acting on the item (reply, " +
            "archive, complete, ignore), NOT for navigation. To let the human " +
            "OPEN a record/link without closing the task, use `url` (the 'Open " +
            "in …' link) or `links` — never an option. Pick one recommended; " +
            "reply options carry a draft.",
          ),
        links: z
          .array(
            z.object({
              label: z.string().optional().describe("Row text (falls back to the url)."),
              url: z.string().describe("http(s) link to open."),
            }),
          )
          .optional()
          .describe(
            "Deep links for the human to open, one row each — e.g. the Linear tickets " +
            "behind a single triage item. Rendered as a clickable 'Links' list below " +
            "the context (separate from the single `url` source link; collapses " +
            "behind a count past 5 links, so a long source list stays out of the " +
            "way). Non-http(s) urls are dropped.",
          ),
      },
    },
    async ({ itemType, title, source, externalRef, url, externalTs, context, proposedActionText, proposedActionFields, options: actionOptions, links }) => {
      if (!isOperator) return operatorOnly();
      const proposedAction =
        proposedActionText || proposedActionFields
          ? {
              ...(proposedActionText ? { text: proposedActionText } : {}),
              ...(proposedActionFields ? { fields: proposedActionFields } : {}),
            }
          : undefined;
      const res = await produceInboxItemFor(ctx, {
        itemType,
        title,
        source,
        externalRef,
        url,
        externalTs,
        context,
        proposedAction,
        options: actionOptions,
        links,
        parentRunId: options.parentRunId,
      });
      if (!res.ok) return errorResult(res.error);
      return json({ inboxItem: serializeInboxItem(res.item) });
    },
  );

  server.registerTool(
    "claim_inbox_item",
    {
      description:
        "Claim an 'open' inbox item to work it — recorded as this agent (when " +
        "called from inside a run) so humans can see who picked it up. Follow " +
        "with propose_inbox_action (for human review) or complete_inbox_item " +
        "(to resolve it autonomously).",
      inputSchema: { id: z.string().describe("The inbox item id.") },
    },
    async ({ id }) => {
      if (!isOperator) return operatorOnly();
      const res = await claimInboxItemFor(ctx, { id, parentRunId: options.parentRunId });
      if (!res.ok) return errorResult(res.error);
      return json({ inboxItem: serializeInboxItem(res.item) });
    },
  );

  server.registerTool(
    "propose_inbox_action",
    {
      description:
        "Attach your best-guess action to an inbox item and send it for human " +
        "review (moves it to 'awaiting_human'). Use after claiming a source- " +
        "pushed 'open' item. The human's edits to your proposal are the signal " +
        "that trains future autonomy.",
      inputSchema: {
        id: z.string().describe("The inbox item id."),
        text: z.string().optional().describe("Proposed reply / decision."),
        fields: z.record(z.string(), z.unknown()).optional().describe("Structured proposal params."),
      },
    },
    async ({ id, text, fields }) => {
      if (!isOperator) return operatorOnly();
      const res = await proposeInboxActionFor(ctx, {
        id,
        proposedAction: {
          ...(text ? { text } : {}),
          ...(fields ? { fields } : {}),
        },
      });
      if (!res.ok) return errorResult(res.error);
      return json({ inboxItem: serializeInboxItem(res.item) });
    },
  );

  server.registerTool(
    "complete_inbox_item",
    {
      description:
        "Resolve an inbox item with the final action taken — use this when an " +
        "agent handles an item autonomously (no human review needed). Records " +
        "the (proposed, final) pair as a learning signal.",
      inputSchema: {
        id: z.string().describe("The inbox item id."),
        text: z.string().optional().describe("The final reply / decision taken."),
        fields: z.record(z.string(), z.unknown()).optional().describe("Structured final params."),
      },
    },
    async ({ id, text, fields }) => {
      if (!isOperator) return operatorOnly();
      const res = await completeInboxItemFor(ctx, {
        id,
        finalAction: {
          ...(text ? { text } : {}),
          ...(fields ? { fields } : {}),
        },
      });
      if (!res.ok) return errorResult(res.error);
      return json({ inboxItem: serializeInboxItem(res.item) });
    },
  );

  server.registerTool(
    "send_slack_message",
    {
      description:
        "Send a Slack message from one of this workspace's Slack apps — the way " +
        "to actually notify a person. DM someone by `toEmail` (they get a real " +
        "DM + notification), or post to a channel by `channel` (Slack id). This " +
        "is NOT the Composio Slack tool, whose 'DM' posts to the bot's own " +
        "account where nobody sees it. Provide exactly one of toEmail / channel.",
      inputSchema: {
        text: z.string().describe("The message text (Slack mrkdwn)."),
        toEmail: z
          .string()
          .optional()
          .describe("DM this person by email (resolved to their Slack user)."),
        channel: z
          .string()
          .optional()
          .describe("Or post to this Slack channel/user id (e.g. C0123, U0123)."),
        slackApp: z
          .string()
          .optional()
          .describe("Which Slack app to send from (by name); optional if one."),
        threadTs: z.string().optional().describe("Reply under this thread ts."),
      },
    },
    async ({ text, toEmail, channel, slackApp, threadTs }) => {
      if (!isOperator) return operatorOnly();
      const res = await sendSlackMessageFor(ctx, {
        text,
        toEmail,
        channel,
        slackApp,
        threadTs,
      });
      if (!res.ok) return errorResult(res.error);
      return json({ sent: true, channel: res.channel, ts: res.ts });
    },
  );

  // ── Slack-app management (workspace_admin) ──────────────────────────
  server.registerTool(
    "create_slack_app",
    {
      description:
        "Create a Slack bot for this workspace (admin only). This creates the " +
        "app in a `configuring` state with metadata only — finish setup with " +
        "the one-time browser OAuth install under Settings -> Slack apps before " +
        "it can run. `agentLabels` are the agent labels this bot may launch.",
      inputSchema: {
        name: z.string().describe("Display name (<=35 chars, Slack's limit)."),
        agentLabels: z.string().array().optional().describe("Agent labels this bot may launch."),
        defaultOwnerUserId: z.string().optional().describe("Member whose credentials its runs use (defaults to you)."),
        slackAppId: z.string().optional(),
        signingSecret: z.string().optional(),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
      },
    },
    async ({ name, agentLabels, defaultOwnerUserId, slackAppId, signingSecret, clientId, clientSecret }) => {
      if (!isAdmin) return adminOnly();
      const res = await createSlackAppFor(ctx, {
        name,
        agentLabels,
        defaultOwnerUserId,
        slackAppId,
        signingSecret,
        clientId,
        clientSecret,
      });
      if (!res.ok) return errorResult(res.error);
      return json({ slackApp: serializeSlackApp(res.slackApp) });
    },
  );

  server.registerTool(
    "update_slack_app",
    {
      description:
        "Update a Slack bot (admin only): name, the agent labels it may launch, " +
        "default owner, Slack app id, or secrets. Omitted fields are left " +
        "unchanged; secrets are only written when a non-empty value is given.",
      inputSchema: {
        id: z.string().describe("The Slack app's id."),
        name: z.string().optional(),
        agentLabels: z.string().array().optional(),
        defaultOwnerUserId: z.string().optional(),
        slackAppId: z.string().optional(),
        signingSecret: z.string().optional(),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
      },
    },
    async ({ id, name, agentLabels, defaultOwnerUserId, slackAppId, signingSecret, clientId, clientSecret }) => {
      if (!isAdmin) return adminOnly();
      const res = await updateSlackAppFor(ctx, id, {
        name,
        agentLabels,
        defaultOwnerUserId,
        slackAppId,
        signingSecret,
        clientId,
        clientSecret,
      });
      if (!res.ok) return errorResult(res.error);
      return json({ slackApp: serializeSlackApp(res.slackApp) });
    },
  );

  server.registerTool(
    "delete_slack_app",
    {
      description: "Delete a Slack bot from this workspace (admin only).",
      inputSchema: { id: z.string().describe("The Slack app's id.") },
    },
    async ({ id }) => {
      if (!isAdmin) return adminOnly();
      const res = await deleteSlackAppFor(ctx, id);
      if (!res.ok) return errorResult(res.error);
      return json({ deleted: true, id });
    },
  );

  return server;
}
