import "server-only";

import {
  GUIDANCE_ADDITIONAL_PATH,
  GUIDANCE_CARGO_AI_PATH,
  GUIDANCE_INDEX_PATH,
  GUIDANCE_PYDANTIC_PATH,
  GUIDANCE_ROOT_PATH,
} from "@/lib/agent-guidance";
import type { Framework } from "@/lib/agent-framework";
import type { CommitMode } from "@/lib/commit-mode-constants";

// Thin client for the Tembo Coding Agent Platform task API. The task
// endpoints live under the **/public-api** namespace and authenticate
// with the workspace's Tembo API key as `Authorization: Bearer`. POSTs
// a free-text prompt + repo URL to POST /public-api/session/create and
// returns a task record with an htmlUrl the user can follow; the task
// is what opens the PR. CAP renamed the mount from /public-api/task to
// /public-api/session with no alias (tembo/monorepo#9519, 2026-07-16);
// the old path falls through to a catch-all that 400s with
// {"error":{"message":"invalid request path"}}.

const DEFAULT_TEMBO_API_URL = "https://api.tembo.io";

export interface CreateTaskInput {
  // The plain-English prompt describing what should change in the
  // agent file. We build this from the run context + the user's
  // improvement request. CAP supports file tagging in the prompt.
  prompt: string;
  // Public GitHub URL of the workspace repo, e.g.
  // "https://github.com/owner/name". CAP locates the repo by URL.
  repositoryUrl: string;
  // Default branch to open the PR against (typically "main").
  targetBranch?: string;
  // Optional explicit branch name to use for the work; omitted
  // lets CAP pick one.
  branchName?: string;
}

export interface CreateTaskResult {
  taskId: string;
  title: string;
  status: string;
  htmlUrl: string;
}

export type CapError =
  | { kind: "missing_tembo_key" }
  | { kind: "http"; status: number; body: string; url: string }
  | { kind: "network"; message: string };

export type TemboAccountResult =
  | { ok: true; userId: string; orgId: string }
  | { ok: false; error: "invalid" | "network"; detail?: string };

export async function validateTemboApiKey(
  apiKey: string,
): Promise<TemboAccountResult> {
  const baseUrl = process.env.TEMBO_API_URL ?? DEFAULT_TEMBO_API_URL;
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/public-api/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
  } catch (error) {
    return {
      ok: false,
      error: "network",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: res.status === 401 || res.status === 403 ? "invalid" : "network",
      detail: `Tembo returned ${res.status}`,
    };
  }

  const body = (await res.json().catch(() => null)) as {
    userId?: unknown;
    orgId?: unknown;
  } | null;
  if (typeof body?.userId !== "string" || typeof body.orgId !== "string") {
    return { ok: false, error: "invalid" };
  }
  return { ok: true, userId: body.userId, orgId: body.orgId };
}

export async function createTemboTask(args: {
  apiKey: string;
  input: CreateTaskInput;
}): Promise<{ ok: true; result: CreateTaskResult } | { ok: false; error: CapError }> {
  const baseUrl = process.env.TEMBO_API_URL ?? DEFAULT_TEMBO_API_URL;

  const body = {
    prompt: args.input.prompt,
    repositories: [args.input.repositoryUrl],
    ...(args.input.targetBranch ? { targetBranch: args.input.targetBranch } : {}),
    ...(args.input.branchName ? { branchName: args.input.branchName } : {}),
    queueRightAway: true,
  };

  const url = `${baseUrl}/public-api/session/create`;
  // Breadcrumb only — never log `body`: it embeds the prompt (run input/output,
  // user data) and would leak to plaintext container logs / aggregators (#44).
  console.log("[cap] POST", url);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.apiKey}`,
      },
      cache: "no-store",
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: "network",
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Status only — the response body can echo submitted content (#44). The
    // full body is still returned to the caller for handling, just not logged.
    console.log("[cap] ←", res.status);
    return { ok: false, error: { kind: "http", status: res.status, body: text, url } };
  }

  const json = (await res.json()) as {
    id: string;
    title: string;
    status: string;
    htmlUrl: string;
  };
  return {
    ok: true,
    result: {
      taskId: json.id,
      title: json.title,
      status: json.status,
      htmlUrl: json.htmlUrl,
    },
  };
}

// Derive framework from the agent's repo path. Both callers
// (chat-edit, run-improve) only have agentPath at the call site; the
// framework is implicit in the directory. Falls back to pydantic for
// any path we don't recognize — wrong guidance shipping is worse than
// missing guidance, but pydantic is the canonical authoring format so
// it's the safer default.
function frameworkFromAgentPath(path: string): Framework {
  if (path.startsWith("agents/cargo-ai/")) return "cargo-ai";
  return "pydantic-agentspec";
}

// Step-0 block that the coding agent applies BEFORE the requested
// change: refresh the per-framework guidance files in the repo to
// Point Tembo CAP at the guidance files already committed in the
// customer's repo, instead of embedding the full canonical content
// in every prompt. Trades the prior auto-refresh-on-drift guarantee
// for a much smaller prompt; the customer keeps guidance current by
// running "Sync agent guidance" from Settings (or on a schedule, see
// the backlog). We still scope the pointer list to the framework
// this PR touches so Tembo doesn't waste tokens reading the other
// framework's guide.
function buildGuidancePointerBlock(framework: Framework): string {
  const frameworkGuide =
    framework === "cargo-ai" ? GUIDANCE_CARGO_AI_PATH : GUIDANCE_PYDANTIC_PATH;
  return [
    "**Step 1 — Read the agent guidance first**",
    "",
    "The TAS-managed guidance for this repo is committed and treated as",
    "current. Before making the change, read:",
    "",
    `- \`${GUIDANCE_ROOT_PATH}\` — repo entry point`,
    `- \`${GUIDANCE_INDEX_PATH}\` — agent authoring overview`,
    `- \`${frameworkGuide}\` — framework-specific shape and patterns`,
    `- \`${GUIDANCE_ADDITIONAL_PATH}\` — project-specific overrides (read if present)`,
    "",
    "Trust the on-disk content. Don't refresh or overwrite these files;",
    "they're maintained out-of-band.",
  ].join("\n");
}

function tasInstanceUrlFromToolsBase(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  return baseUrl.endsWith("/for-agents")
    ? baseUrl.slice(0, -"/for-agents".length)
    : baseUrl;
}

function buildScopeBlock(args: {
  repositoryUrl: string;
  defaultBranch: string;
  nativeToolsBaseUrl?: string;
}): string {
  const tasInstanceUrl = tasInstanceUrlFromToolsBase(args.nativeToolsBaseUrl);
  const lines = [
    "**Scope — use this TAS instance and repo**",
    "",
    `This request came from the TAS workspace connected to \`${args.repositoryUrl}\`.`,
    `Make changes only in that connected agents repo, targeting \`${args.defaultBranch}\`.`,
  ];
  if (tasInstanceUrl) {
    lines.push(`Use this TAS instance for runtime/tool references: ${tasInstanceUrl}`);
  }
  lines.push(
    "If surrounding Tembo session context mentions any other repository, TAS",
    "instance, or prior pull request, treat it as unrelated unless it matches",
    `\`${args.repositoryUrl}\` exactly.`,
  );
  return lines.join("\n");
}

// The delivery directive — how the agent should ship the change, and where to
// drop the correlation marker. PR mode (the default) opens a pull request with
// the marker in its description; direct ("YOLO") mode commits straight to the
// default branch with the marker in the commit message, so /improvements can
// still correlate the landed change back to the improvement row. Returns the
// prompt-line array; callers spread it in.
export function evalSidecarPath(agentPath: string): string {
  return agentPath.replace(/\.(ya?ml|json)$/i, "") + ".eval.yaml";
}

/** Operator opt-in for a colocated eval sidecar. Default on. */
export function evalsDirective(includeEvals: boolean, agentPath: string): string[] {
  const sidecar = evalSidecarPath(agentPath);
  if (!includeEvals) {
    return [
      "**Evals: off.** The operator declined regression evals. Do not create, edit, or delete an eval sidecar (`*.eval.yaml`). Agents without one stay ungated.",
      "",
    ];
  }
  return [
    `**Evals: on.** The operator opted in. Write or update a colocated eval sidecar at \`${sidecar}\` — same stem as the agent file; it is not itself an agent. Read the eval sidecar section in the framework AGENT_GUIDE.`,
    "",
    "Shape:",
    "```yaml",
    "cases:",
    "  - name: greets",
    "    input: Hello",
    "    assert:",
    "      contains: hello",
    "  - name: tone",
    "    input: Hey",
    "    judge:",
    "      rubric: Friendly greeting.",
    "```",
    "",
    "- 2–5 cases covering the agent's main job.",
    "- Prefer `assert` (`contains`, `not_contains`, `regex`, `equals`, `max_chars`) — those gate Promote and authoring PRs.",
    "- `judge.rubric` is optional and informational; it does not fail the gate.",
    "- If a sidecar already exists, keep it in sync with this change. Do not put evals inside the agent spec.",
    "",
  ];
}

function deliveryDirective(
  commitMode: CommitMode,
  defaultBranch: string,
  marker: string,
): string[] {
  if (commitMode === "direct") {
    return [
      `Commit the change directly to the \`${defaultBranch}\` branch. Do not open a pull request.`,
      "",
      "IMPORTANT: Include this exact line on its own in the commit message so",
      "Tembo Agent Studio can correlate the commit with the user's request:",
      "",
      marker,
    ];
  }
  return [
    "Open a pull request with the change.",
    "",
    "IMPORTANT: Include this exact line on its own at the end of the pull",
    "request description so Tembo Agent Studio can correlate the PR with the",
    "user's request:",
    "",
    marker,
  ];
}

// Build a chat-to-create prompt. Pass the user's description through
// verbatim and point Tembo CAP at the repo's checked-in guides for
// path/shape conventions. We assume external-service connections
// already exist — TAS bootstraps those separately, so the coding
// agent shouldn't scaffold provider config in the same PR. The
// marker line is the one piece of TAS scaffolding kept — without
// it the PR scanner can't correlate the merged PR back to the
// improvement row.
export type AvailableConnectionSlots = Record<string, string[]>;

export function buildCreateAgentPrompt(args: {
  framework: Framework;
  agentName: string;
  /** Free-text display name to write as the spec's `title:`. */
  title: string;
  agentPath: string;
  description: string;
  improvementMarker: string;
  commitMode: CommitMode;
  defaultBranch: string;
  /** Connected workspace repo URL CAP must edit, e.g. https://github.com/owner/name. */
  repositoryUrl: string;
  /**
   * Toolkit → authorized slot names for the user creating this
   * agent. When present, the prompt tells Tembo to prefer these
   * concrete slot names over `default`. Empty/missing = none
   * authorized yet, so the prompt falls back to `default`.
   */
  availableSlots?: AvailableConnectionSlots;
  /**
   * Native-MCP provider slug → authorized slot names for the user.
   * Rendered as a separate block from `availableSlots`: native connections
   * must be declared with `source: native-mcp`, and CAP looks up their exact
   * tool slugs at the TAS-served reference (nativeToolsBaseUrl + nativeToolsKey)
   * rather than inline.
   */
  nativeSlots?: AvailableConnectionSlots;
  /** Origin + path of this instance's /for-agents reference, e.g.
   *  "https://tas.example.com/for-agents". */
  nativeToolsBaseUrl?: string;
  /** Signed token CAP appends as `?key=` when fetching the reference. */
  nativeToolsKey?: string;
  /** Operator opted into a colocated eval sidecar. Default on. */
  includeEvals?: boolean;
}): string {
  const frameworkGuide =
    args.framework === "cargo-ai" ? GUIDANCE_CARGO_AI_PATH : GUIDANCE_PYDANTIC_PATH;
  return [
    buildScopeBlock({
      repositoryUrl: args.repositoryUrl,
      defaultBranch: args.defaultBranch,
      nativeToolsBaseUrl: args.nativeToolsBaseUrl,
    }),
    "",
    `Create an agent at \`${args.agentPath}\` named \`${args.agentName}\` using these docs in the connected repo as your guide:`,
    "",
    `- \`${GUIDANCE_ROOT_PATH}\` — repo conventions`,
    `- \`${GUIDANCE_INDEX_PATH}\` — agent layout and per-framework directories`,
    `- \`${frameworkGuide}\` — framework-specific shape and patterns`,
    `- \`${GUIDANCE_ADDITIONAL_PATH}\` — any customer-specific overrides (read if present)`,
    "",
    `The agent's \`name:\` field must be exactly \`${args.agentName}\` (it matches the filename). Also set a \`title:\` field to the human display name "${args.title}" (free text — this is what the UI shows). Don't put the file anywhere other than \`${args.agentPath}\`.`,
    "",
    ...evalsDirective(args.includeEvals !== false, args.agentPath),
    ...renderAvailableSlots(args.availableSlots),
    ...renderNativeSlots(
      args.nativeSlots,
      args.nativeToolsBaseUrl,
      args.nativeToolsKey,
    ),
    "If the agent needs to call external services (Slack, Gmail, Google",
    "Sheets, Notion, GitHub, Linear, HubSpot, etc.), declare them via the",
    "`connections:` field. The slug is whatever Composio uses (lowercase,",
    "no spaces) — see https://composio.dev/toolkits for the full catalog.",
    "Don't restrict yourself to a hand-curated list; if the user's task",
    "needs Gmail, declare it and TAS will surface a Connect button for",
    "it. Don't scaffold provider SDK config, environment variables, or",
    "credential plumbing in the agent file — the runtime injects the",
    "tools once the user authorizes the toolkit in Settings → Connections.",
    "",
    "**Always use the named-slot + narrow-tools form for connections.**",
    "Pick a short name and list the exact tool slugs the agent uses.",
    "If the user has already authorized a slot in this workspace, use",
    "that name (the prompt header above lists them). Use `default` only",
    "when no slot exists for the toolkit yet. Example:",
    "",
    "```yaml",
    "connections:",
    "  - gmail:",
    "      name: default",
    "      tools: [GMAIL_SEND_EMAIL]",
    "  - googlesheets:",
    "      name: default",
    "      tools: [GOOGLESHEETS_BATCH_GET]",
    "```",
    "",
    "Why the named + narrow form is the default:",
    "",
    "- Naming the slot lets users hold multiple accounts of the same",
    "  toolkit (e.g. work + personal Gmail) and have the agent target",
    "  a specific one. Even when the agent uses just one account today,",
    "  declaring `name: default` makes future multi-account refactors",
    "  trivial (rename one slot, add another, agent file stays clean).",
    "- Narrowing tools turns on the DIRECT_TOOLS preset at run time,",
    "  which preloads only the listed tools instead of every action",
    "  Composio supports for that toolkit. That drops input token cost",
    "  by ~10× per run and keeps the model focused on actions you",
    "  actually want it to call.",
    "",
    "Pick the tool slugs from https://composio.dev/toolkits — each",
    "toolkit's page lists the action slugs (UPPER_SNAKE_CASE).",
    "",
    "Connections are per-user: manual runs use the requesting user's",
    "credentials, scheduled runs use the automation's `Run as` owner",
    "(set on the automation form).",
    "",
    "For the agent's `model:` field, default to `anthropic:claude-sonnet-5`",
    "for most agents (tools or not) — it's agentic enough not to hedge on",
    "tool use and close to Opus 4.8 at lower cost. Step up to",
    "`anthropic:claude-opus-4-8` for the most demanding reasoning, and to",
    "`anthropic:claude-fable-5` for the hardest / long-horizon agentic work",
    "(~2× Opus cost — only when Opus 4.8 isn't enough). See the guide's",
    "\"Choosing a model\" section for the full reasoning.",
    "",
    "---",
    "",
    args.description.trim(),
    "",
    "---",
    "",
    ...deliveryDirective(
      args.commitMode,
      args.defaultBranch,
      args.improvementMarker,
    ),
  ].join("\n");
}

// Format the "available slots" preamble for the create-agent prompt.
// Returns the prompt-line array (caller spreads it in). Empty input
// returns []  so the prompt falls back to the generic "use `default`"
// guidance further down.
function renderAvailableSlots(
  slots: AvailableConnectionSlots | undefined,
): string[] {
  if (!slots) return [];
  const entries = Object.entries(slots).filter(
    ([, names]) => names.length > 0,
  );
  if (entries.length === 0) return [];
  entries.sort(([a], [b]) => a.localeCompare(b));
  const lines: string[] = [
    "**Connection slots already authorized in this workspace:**",
    "",
  ];
  for (const [toolkit, names] of entries) {
    lines.push(`- \`${toolkit}\`: ${names.map((n) => `\`${n}\``).join(", ")}`);
  }
  lines.push("");
  lines.push(
    "When the agent declares a `connections:` entry for one of these",
  );
  lines.push(
    "toolkits, use the existing slot name (not `default`) so the user",
  );
  lines.push(
    "doesn't have to re-authorize. For a toolkit not listed above, use",
  );
  lines.push("`default` and TAS will surface a Connect button.");
  lines.push("");
  return lines;
}

// Native-MCP slots block. Native connections must be declared with
// `source: native-mcp`; their tool slugs aren't inlined (the catalogs are
// large and provider-specific) — instead CAP fetches a per-provider reference
// served by this TAS instance, authorized by a signed bearer token sent in the
// `Authorization` header. Empty slots, or a missing base/token, returns [].
function renderNativeSlots(
  slots: AvailableConnectionSlots | undefined,
  baseUrl: string | undefined,
  token: string | undefined,
): string[] {
  if (!slots || !baseUrl || !token) return [];
  const entries = Object.entries(slots).filter(([, names]) => names.length > 0);
  if (entries.length === 0) return [];
  entries.sort(([a], [b]) => a.localeCompare(b));
  const [firstProvider, firstNames] = entries[0];
  const lines: string[] = [
    "**Native MCP connection slots already authorized in this workspace:**",
    "",
  ];
  for (const [provider, names] of entries) {
    lines.push(`- \`${provider}\`: ${names.map((n) => `\`${n}\``).join(", ")}`);
  }
  lines.push("");
  lines.push(
    "These talk to the provider's official MCP server. Declare them with",
  );
  lines.push(
    "`source: native-mcp` and the existing slot name above. Before writing the",
  );
  lines.push(
    "`tools:` list, fetch the provider's tool reference (it lists the exact tool",
  );
  lines.push(
    "slugs) and narrow to what you need. Each page requires this HTTP header:",
  );
  lines.push("");
  lines.push(`    Authorization: Bearer ${token}`);
  lines.push("");
  lines.push("Reference pages (one per provider):");
  lines.push("");
  for (const [provider] of entries) {
    lines.push(`- \`${provider}\` → ${baseUrl}/${provider}.md`);
  }
  lines.push("");
  lines.push(
    `e.g. \`curl -H "Authorization: Bearer ${token}" ${baseUrl}/${firstProvider}.md\``,
  );
  lines.push("");
  lines.push("Example:");
  lines.push("");
  lines.push("```yaml");
  lines.push("connections:");
  lines.push(`  - ${firstProvider}:`);
  lines.push("      source: native-mcp");
  lines.push(`      name: ${firstNames[0]}`);
  lines.push("      tools: [<slug-from-the-reference-page>]");
  lines.push("```");
  lines.push("");
  return lines;
}

// Build a chat-to-edit prompt. No specific run is anchored; this is
// the agent-level "I want to change X about this agent" path. Same
// marker contract as the run-anchored variant so the same scanner
// works for both.
export function buildChatEditPrompt(args: {
  agentPath: string;
  improvement: string;
  improvementMarker: string;
  commitMode: CommitMode;
  defaultBranch: string;
  /** Connected workspace repo URL CAP must edit, e.g. https://github.com/owner/name. */
  repositoryUrl: string;
  /** Composio toolkit → authorized slot names. Lets CAP add/reference real
   *  slots when the edit touches `connections:`. */
  availableSlots?: AvailableConnectionSlots;
  /** Native-MCP provider slug → authorized slot names. */
  nativeSlots?: AvailableConnectionSlots;
  /** Origin + path of this instance's /for-agents reference. */
  nativeToolsBaseUrl?: string;
  /** Signed token CAP sends as `Authorization: Bearer` to the reference. */
  nativeToolsKey?: string;
  includeEvals?: boolean;
}): string {
  const framework = frameworkFromAgentPath(args.agentPath);
  return [
    buildScopeBlock({
      repositoryUrl: args.repositoryUrl,
      defaultBranch: args.defaultBranch,
      nativeToolsBaseUrl: args.nativeToolsBaseUrl,
    }),
    "",
    buildGuidancePointerBlock(framework),
    "",
    ...evalsDirective(args.includeEvals !== false, args.agentPath),
    "**Step 2 — Delivery**",
    "",
    ...deliveryDirective(
      args.commitMode,
      args.defaultBranch,
      args.improvementMarker,
    ),
    "",
    // If the edit adds/changes a `connections:` entry, these tell CAP the real
    // authorized slot names + where to look up native-MCP tool slugs.
    ...renderAvailableSlots(args.availableSlots),
    ...renderNativeSlots(
      args.nativeSlots,
      args.nativeToolsBaseUrl,
      args.nativeToolsKey,
    ),
    // Keep the file target adjacent to the user's request (TAS fills the path
    // in from the agent's route, not the user's words) so it stays in front of
    // CAP right where the instruction is.
    "## Requested change",
    "",
    `Improve the agent defined at @${args.agentPath}:`,
    "",
    args.improvement.trim(),
  ].join("\n");
}

// Build the prompt we send to CAP from the run context + the user's
// freeform improvement request. We tag the agent file path so CAP
// knows which file to edit; the run input/output give it the concrete
// failure to fix; the improvement marker is what lets us later
// correlate the merged PR back to the improvement row that triggered
// it.
export function buildImprovePrompt(args: {
  agentPath: string;
  model: string;
  userMessage: string;
  output: string;
  improvement: string;
  improvementMarker: string;
  commitMode: CommitMode;
  defaultBranch: string;
  /** Connected workspace repo URL CAP must edit, e.g. https://github.com/owner/name. */
  repositoryUrl: string;
  includeEvals?: boolean;
}): string {
  const framework = frameworkFromAgentPath(args.agentPath);
  const trimmedOutput = args.output.length > 4000
    ? args.output.slice(0, 4000) + "\n…[truncated]"
    : args.output;

  return [
    buildScopeBlock({
      repositoryUrl: args.repositoryUrl,
      defaultBranch: args.defaultBranch,
    }),
    "",
    buildGuidancePointerBlock(framework),
    "",
    "**Step 2 — Delivery**",
    "",
    ...deliveryDirective(
      args.commitMode,
      args.defaultBranch,
      args.improvementMarker,
    ),
    "",
    ...evalsDirective(args.includeEvals !== false, args.agentPath),
    // Keep the file target next to the user's request (TAS fills the path in
    // from the run's agent, not the user's words).
    "## Improvement requested by the user",
    "",
    `Improve the agent defined at @${args.agentPath}:`,
    "",
    args.improvement.trim(),
    "",
    "## Context: the run that prompted this request",
    `- Model: ${args.model}`,
    `- User message: ${args.userMessage || "(empty)"}`,
    "",
    "### Agent output",
    "```",
    trimmedOutput,
    "```",
  ].join("\n");
}
