import "server-only";

// Natural-language routing for channel messages that don't name an agent
// explicitly. A cheap Haiku classifier maps a free-text message to one of
// the app's scoped agents (or none) and extracts the task to run. No tools,
// low max_tokens — this is a router, not the agent itself. Falls back
// gracefully (returns null) on any error so the caller can show the menu.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ROUTER_MODEL = "claude-haiku-4-5";

export type RouterAgent = { name: string; description?: string };

export type RouterResult =
  | { agentName: string; input: string }
  | { agentName: null };

function buildSystemPrompt(agents: RouterAgent[]): string {
  const list = agents
    .map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ""}`)
    .join("\n");
  return [
    "You route a user's message to exactly one agent from a fixed list, or to none.",
    "",
    "Agents:",
    list,
    "",
    "Rules:",
    "- Pick the single best-matching agent by what the user wants done.",
    "- If multiple agents fit and there is no clearly best match, use null.",
    '- If no agent clearly fits (e.g. a greeting, small talk, or an unrelated request), use null.',
    "- `input` is the task to hand the agent: the user's message, lightly cleaned, with any agent-naming removed. Keep their intent and details verbatim.",
    '- Respond with ONLY a JSON object, no prose: {"agent": "<name>"|null, "input": "<task>"}.',
    "- `agent` must be exactly one of the names above, or null.",
  ].join("\n");
}

/** Split "<agent> <input…>" using the first whitespace-delimited token. */
export function parseAgentMessage(text: string): {
  agentName: string;
  input: string;
} {
  const trimmed = text.trim();
  if (!trimmed) return { agentName: "", input: "" };
  const match = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
  if (!match) return { agentName: "", input: "" };
  return { agentName: match[1], input: match[2].trim() };
}

export function matchExplicitAgent(
  agents: RouterAgent[],
  message: string,
): { agentName: string; input: string } | null {
  const parsed = parseAgentMessage(message);
  const agent = agents.find(
    (candidate) => candidate.name.toLowerCase() === parsed.agentName.toLowerCase(),
  );
  return agent ? { agentName: agent.name, input: parsed.input } : null;
}

/** Extract the first JSON object from a model response (may be prose-wrapped). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function classifyMessage(args: {
  apiKey: string;
  agents: RouterAgent[];
  message: string;
}): Promise<RouterResult> {
  const { apiKey, agents, message } = args;
  if (agents.length === 0 || !message.trim()) return { agentName: null };

  let data: unknown;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      cache: "no-store",
      body: JSON.stringify({
        model: ROUTER_MODEL,
        max_tokens: 400,
        system: buildSystemPrompt(agents),
        messages: [{ role: "user", content: message }],
      }),
    });
    if (!res.ok) return { agentName: null };
    data = await res.json();
  } catch {
    return { agentName: null };
  }

  // Anthropic responses: { content: [{ type: "text", text: "..." }] }
  const text =
    (data as { content?: { type?: string; text?: string }[] })?.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("") ?? "";

  const parsed = extractJson(text) as { agent?: unknown; input?: unknown } | null;
  if (!parsed || typeof parsed.agent !== "string") return { agentName: null };

  // Trust but verify: the agent must be one we offered.
  const valid = agents.some((a) => a.name === parsed.agent);
  if (!valid) return { agentName: null };

  const input = typeof parsed.input === "string" ? parsed.input : message;
  return { agentName: parsed.agent, input };
}
