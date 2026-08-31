import "server-only";
import YAML from "yaml";

import type { Framework } from "@/lib/agent-framework";

// Two agent frameworks ship in v0.1: Pydantic AI's AgentSpec (canonical
// authoring format) and Cargo AI's single-file JSON (importable). The
// parser dispatches on shape — see detectFramework below — and returns
// a discriminated union so the type system can tell consumers which
// fields are guaranteed for each framework. See context/shipped/0.1/AGENT_FORMAT.md.

// Re-export so callers that import from agent-format keep working.
export { FRAMEWORKS, FRAMEWORK_LABELS } from "@/lib/agent-framework";
export type { Framework } from "@/lib/agent-framework";

type AgentSpecBase = {
  /**
   * The slug identifier — must match the filename (`name: foo` → `foo.yaml`).
   * Used as the stable key everywhere (URLs, run records, dispatch, versions,
   * automations). Lowercase letters, digits, hyphens.
   */
  name: string;
  /**
   * Optional free-text display name shown in the UI (e.g. "Revenue Rollup").
   * Falls back to `name` when absent — see `agentDisplayName`. Doesn't affect
   * identity: the slug `name` stays the key.
   */
  title?: string;
  description?: string;
  /**
   * Optional labels for grouping + scoping. Normalized lowercase. Used
   * to group the inventory and to scope which TAS-managed Slack app may
   * launch the agent. Parsed from a `labels:` array or comma string.
   */
  labels: string[];
  /** Optional, agent-authored delivery intent snapshotted onto every run. */
  delivery?: AgentDelivery;
  /** Raw parsed object preserved for round-tripping. */
  raw: Record<string, unknown>;
};

export type AgentDeliveryEvidence =
  | { type: "inbox_item" }
  | { type: "tool_call"; tool: string };

export type AgentDeliveryDestination = {
  key: string;
  label: string;
  evidence: AgentDeliveryEvidence;
};

export type AgentDelivery = {
  note: string;
  destinations: AgentDeliveryDestination[];
};

/** Human label for an agent: the free-text `title` if set, else the slug. */
export function agentDisplayName(spec: {
  title?: string;
  name: string;
}): string {
  return spec.title && spec.title.trim() ? spec.title.trim() : spec.name;
}

/** Accept a non-empty `title:` string; trim + cap length. */
function parseTitleField(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v ? v.slice(0, 200) : undefined;
}

/** Accept `labels: [sales, crm]` or `labels: "sales, crm"`; normalize. */
function parseLabelsField(raw: unknown): string[] {
  let values: string[] = [];
  if (Array.isArray(raw)) {
    values = raw.filter((v): v is string => typeof v === "string");
  } else if (typeof raw === "string") {
    values = raw.split(",");
  }
  return Array.from(
    new Set(values.map((s) => s.trim().toLowerCase()).filter(Boolean)),
  );
}

export type AgentConnectionSource = "composio" | "native-mcp" | "secret";

export type AgentConnection = {
  /** Provider slug. For source="composio" this is a Composio toolkit
   *  slug ("gmail", "slack"); for source="native-mcp" it's a slug
   *  from lib/mcp-providers ("attio"). */
  toolkit: string;
  /**
   * Named connection slot — disambiguates when a user has multiple
   * accounts of the same toolkit (e.g. "work" vs "personal" Gmail).
   * Defaults to "default" when the spec uses the loose `- gmail`
   * form.
   */
  name: string;
  /**
   * Which connection mode the runner should use for this entry.
   * Defaults to "composio" so existing specs need no edit. Set
   * "native-mcp" to talk directly to the provider's official MCP
   * server with TAS-managed OAuth (the workspace_connection row
   * the user authorized under Connections).
   */
  source: AgentConnectionSource;
};

export type PydanticAgentSpec = AgentSpecBase & {
  framework: "pydantic-agentspec";
  model: string;
  instructions: string;
  /**
   * External services this agent depends on at run time. Each entry
   * resolves at run time to a Composio connection owned by the user
   * the run is acting as (manual = requesting user; scheduled =
   * automation.owner_user_id).
   */
  connections: AgentConnection[];
  /**
   * Agent Skills this agent opts into, by folder name. Each name maps to a
   * `skills/<name>/` folder (SKILL.md + resources) installed in the connected
   * repo. The runner mounts the named skill folders so the model can load
   * their instructions + run their scripts. Empty = no skills.
   */
  skills: string[];
  /**
   * Optional sidecar Python module of custom tool functions the model
   * may call (e.g. deterministic ETL transforms). A bare filename
   * resolved in the spec's own directory — the runner reads it and
   * exposes its `tools = [...]` export to pydantic-ai. Undefined = no
   * module. See context AGENT_FORMAT.md → "Sidecar tools".
   */
  toolsModule?: string;
};

export type CargoAiSpec = AgentSpecBase & {
  framework: "cargo-ai";
  /** Cargo AI agents don't always expose a top-level `model` field. */
  model: string | null;
};

export type AgentSpec = PydanticAgentSpec | CargoAiSpec;

export type AgentFileFormat = "yaml" | "json";

export type ParseAgentError =
  | "unsupported-extension"
  | "invalid-yaml"
  | "invalid-json"
  | "not-an-object"
  | "unrecognized-shape"
  | "missing-name"
  | "missing-model"
  | "missing-instructions"
  | "invalid-delivery"
  | "invalid-name";

export type ParseAgentResult =
  | { ok: true; spec: AgentSpec; format: AgentFileFormat }
  | { ok: false; error: ParseAgentError; detail?: string };

export function detectFormat(filename: string): AgentFileFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".json")) return "json";
  return null;
}

/** Kebab slug; the filename is `{name}.{ext}`. An optional single `{handle}.`
 *  prefix is allowed so a fork can be owner-namespaced (e.g. `ryw.sales-gen`)
 *  without colliding with the original. Plain names still validate. */
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const NAME_RE = new RegExp(`^(?:${SLUG}\\.)?${SLUG}$`);

export function validateAgentName(name: string): boolean {
  return name.length >= 2 && name.length <= 64 && NAME_RE.test(name);
}

function parseDeliveryField(
  raw: unknown,
): { ok: true; delivery?: AgentDelivery } | { ok: false; detail: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: "`delivery` must be an object." };
  }
  const value = raw as Record<string, unknown>;
  const note = typeof value.note === "string" ? value.note.trim() : "";
  if (!note) {
    return { ok: false, detail: "`delivery.note` must be a non-empty string." };
  }
  if (!Array.isArray(value.destinations) || value.destinations.length === 0) {
    return {
      ok: false,
      detail: "`delivery.destinations` must contain at least one destination.",
    };
  }

  const destinations: AgentDeliveryDestination[] = [];
  const keys = new Set<string>();
  for (const entry of value.destinations) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, detail: "Each delivery destination must be an object." };
    }
    const destination = entry as Record<string, unknown>;
    const key = typeof destination.key === "string" ? destination.key.trim() : "";
    const label =
      typeof destination.label === "string" ? destination.label.trim() : "";
    if (!key || !label) {
      return {
        ok: false,
        detail: "Each delivery destination needs non-empty `key` and `label` fields.",
      };
    }
    if (keys.has(key)) {
      return { ok: false, detail: `Duplicate delivery destination key: ${key}.` };
    }
    keys.add(key);

    const rawEvidence = destination.evidence;
    if (!rawEvidence || typeof rawEvidence !== "object" || Array.isArray(rawEvidence)) {
      return { ok: false, detail: `Delivery destination ${key} needs evidence.` };
    }
    const evidence = rawEvidence as Record<string, unknown>;
    if (evidence.type === "inbox_item") {
      destinations.push({ key, label, evidence: { type: "inbox_item" } });
      continue;
    }
    if (evidence.type === "tool_call") {
      const tool = typeof evidence.tool === "string" ? evidence.tool.trim() : "";
      if (!tool) {
        return {
          ok: false,
          detail: `Tool-call delivery destination ${key} needs a non-empty tool name.`,
        };
      }
      destinations.push({ key, label, evidence: { type: "tool_call", tool } });
      continue;
    }
    return {
      ok: false,
      detail: `Unsupported evidence type for delivery destination ${key}.`,
    };
  }

  return { ok: true, delivery: { note, destinations } };
}

/** A kebab handle from a user's email local-part (`ryw@tembo.io` → `ryw`), for
 *  owner-prefixed fork names. */
export function ownerHandle(email: string): string {
  const local = (email.split("@")[0] ?? "").toLowerCase();
  return local.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "user";
}

/** The base slug with any leading `{handle}.` owner prefix stripped, so forking
 *  a fork re-prefixes the base rather than nesting (`alice.sales-gen`, not
 *  `alice.ryw.sales-gen`). */
export function baseAgentSlug(name: string): string {
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(dot + 1) : name;
}

/**
 * Dispatch on the parsed object's shape:
 *  - `instructions: string` → Pydantic AgentSpec
 *  - `agent_schema` object  → Cargo AI (native shape)
 *  - `inputs` or `actions` array → Cargo AI (looser fallback)
 *  - otherwise              → unrecognized
 *
 * If a file happens to have both (someone wrote a hybrid), we prefer
 * Pydantic AgentSpec because that's our canonical authoring format.
 */
function detectFramework(obj: Record<string, unknown>): Framework | null {
  const hasInstructions =
    typeof obj.instructions === "string" && obj.instructions.trim() !== "";
  if (hasInstructions) return "pydantic-agentspec";
  const hasAgentSchema =
    obj.agent_schema !== undefined &&
    obj.agent_schema !== null &&
    typeof obj.agent_schema === "object" &&
    !Array.isArray(obj.agent_schema);
  if (hasAgentSchema) return "cargo-ai";
  if (Array.isArray(obj.inputs) || Array.isArray(obj.actions)) return "cargo-ai";
  return null;
}

function parsePydanticSpec(
  obj: Record<string, unknown>,
  base: AgentSpecBase,
): ParseAgentResult | { spec: PydanticAgentSpec } {
  const model = obj.model;
  if (typeof model !== "string" || !model.trim()) {
    return { ok: false, error: "missing-model" };
  }
  const instructions = obj.instructions;
  if (typeof instructions !== "string" || !instructions.trim()) {
    return { ok: false, error: "missing-instructions" };
  }
  const connections = parseConnectionsField(obj.connections);
  return {
    spec: {
      ...base,
      framework: "pydantic-agentspec",
      model,
      instructions,
      connections,
      skills: parseSkillsField(obj.skills),
      toolsModule: parseToolsModuleField(obj.tools_module),
    },
  };
}

/**
 * Accept `skills: [pdf, my-skill]` or `skills: "pdf, my-skill"`. Each entry is
 * the folder name of a skill installed under `skills/<name>/` in the repo
 * (lowercase, hyphenated, matching the SKILL.md name). Normalized + deduped.
 * Path separators are stripped so an entry can only name a top-level skill
 * folder. Malformed entries are dropped — the runner mounts what it finds.
 */
function parseSkillsField(raw: unknown): string[] {
  let values: string[] = [];
  if (Array.isArray(raw)) {
    values = raw.filter((v): v is string => typeof v === "string");
  } else if (typeof raw === "string") {
    values = raw.split(",");
  }
  return Array.from(
    new Set(
      values
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s && !s.includes("/") && !s.includes("\\")),
    ),
  );
}

/**
 * Accept `tools_module: foo.py` — a bare `.py` filename resolved in the
 * spec's own directory. Reject anything with a path separator (no
 * `../`, no absolute paths): the module must be a sibling of the spec.
 * Returns undefined for absent / malformed values so the agent runs
 * with no sidecar tools.
 */
function parseToolsModuleField(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!v || v.includes("/") || v.includes("\\")) return undefined;
  if (!v.toLowerCase().endsWith(".py")) return undefined;
  return v;
}

/**
 * Extract `connections:` as a list of {toolkit, name} pairs.
 * Accepted shapes (loose → most explicit):
 *
 *   connections: [slack, googlesheets]
 *     → [{toolkit: "slack", name: "default"},
 *        {toolkit: "googlesheets", name: "default"}]
 *
 *   connections: [{slack: [SLACK_SEND_MESSAGE]}]
 *     → [{toolkit: "slack", name: "default"}]    (tools dropped — the
 *                                                 runner reads them)
 *
 *   connections: [{slack: {tools: [...]}}]
 *     → same as above
 *
 *   connections:
 *     - gmail: { name: "work" }
 *     - gmail: { name: "personal", tools: [...] }
 *     → two pairs, both toolkit gmail, names "work" and "personal".
 *
 *   connections: [{type: slack, name: "alt"}]
 *     → [{toolkit: "slack", name: "alt"}]    (verbose form)
 *
 * The runner uses the named slot to look up the right
 * workspace_composio_connection row at run time. Malformed entries
 * are dropped — the runner does the strict validation.
 */
function coerceSource(raw: unknown): AgentConnectionSource {
  if (raw === "native-mcp") return "native-mcp";
  // A "secret" connection is a workspace API key (e.g. Clay) read by the
  // agent's sidecar tools — it attaches no tools and is invisible to the
  // model. Declaring it only surfaces the missing-secret prompt.
  if (raw === "secret") return "secret";
  return "composio";
}

function parseConnectionsField(raw: unknown): AgentConnection[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentConnection[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push({ toolkit: item.trim(), name: "default", source: "composio" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;

    // Verbose form: { type|toolkit: "slack", name?: "alt", source?: "..." }
    const slug = o.type ?? o.toolkit;
    if (typeof slug === "string" && slug.trim()) {
      const name =
        typeof o.name === "string" && o.name.trim() ? o.name.trim() : "default";
      out.push({
        toolkit: slug.trim(),
        name,
        source: coerceSource(o.source),
      });
      continue;
    }

    // Compact form: single-key dict where the key IS the toolkit slug.
    // Value can be: list of tool slugs (narrow tools, no name), or
    // a dict carrying { name, tools, source }.
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0].trim()) {
      const toolkit = keys[0].trim();
      const body = o[keys[0]];
      let name = "default";
      let source: AgentConnectionSource = "composio";
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const b = body as Record<string, unknown>;
        if (typeof b.name === "string" && b.name.trim()) {
          name = b.name.trim();
        }
        source = coerceSource(b.source);
      }
      out.push({ toolkit, name, source });
    }
  }
  return out;
}

function parseCargoAiSpec(
  obj: Record<string, unknown>,
  base: AgentSpecBase,
): ParseAgentResult | { spec: CargoAiSpec } {
  // The web layer's job is to extract `model` for run routing and pass
  // the raw bytes through; cargo-ai itself validates the rest of the
  // schema. Model placement varies (top-level vs `runtime_vars.model`);
  // we accept either flat shape, with null as the honest "didn't find
  // one" value so the UI renders "—" rather than guessing.
  let model: string | null = null;
  if (typeof obj.model === "string" && obj.model.trim()) {
    model = obj.model;
  } else if (
    obj.runtime_vars &&
    typeof obj.runtime_vars === "object" &&
    !Array.isArray(obj.runtime_vars)
  ) {
    const m = (obj.runtime_vars as Record<string, unknown>).model;
    if (typeof m === "string" && m.trim()) model = m;
  }

  return { spec: { ...base, framework: "cargo-ai", model } };
}

export function parseAgentContent(
  content: string,
  format: AgentFileFormat,
): ParseAgentResult {
  let parsed: unknown;
  try {
    parsed = format === "yaml" ? YAML.parse(content) : JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      error: format === "yaml" ? "invalid-yaml" : "invalid-json",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "not-an-object" };
  }

  const obj = parsed as Record<string, unknown>;

  const name = obj.name;
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, error: "missing-name" };
  }
  if (!validateAgentName(name)) {
    return {
      ok: false,
      error: "invalid-name",
      detail:
        "Agent name must be 2–64 chars, lowercase letters, digits, and hyphens.",
    };
  }

  const description =
    typeof obj.description === "string" ? obj.description : undefined;
  const delivery = parseDeliveryField(obj.delivery);
  if (!delivery.ok) {
    return { ok: false, error: "invalid-delivery", detail: delivery.detail };
  }
  const base: AgentSpecBase = {
    name,
    title: parseTitleField(obj.title),
    description,
    labels: parseLabelsField(obj.labels),
    delivery: delivery.delivery,
    raw: obj,
  };

  const framework = detectFramework(obj);
  if (framework === null) {
    return {
      ok: false,
      error: "unrecognized-shape",
      detail:
        "Not a recognized agent format. Pydantic AgentSpec needs `instructions`; Cargo AI needs an `agent_schema` (or `inputs` / `actions`) array.",
    };
  }

  if (framework === "pydantic-agentspec") {
    const result = parsePydanticSpec(obj, base);
    if ("ok" in result) return result;
    return { ok: true, format, spec: result.spec };
  }

  // framework === 'cargo-ai'
  const result = parseCargoAiSpec(obj, base);
  if ("ok" in result) return result;
  return { ok: true, format, spec: result.spec };
}

export function parseAgentFile(
  filename: string,
  content: string,
): ParseAgentResult {
  const format = detectFormat(filename);
  if (!format) {
    return { ok: false, error: "unsupported-extension" };
  }
  return parseAgentContent(content, format);
}
