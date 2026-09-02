export type DryRunFramework = "pydantic-agentspec" | "cargo-ai";

export type DryRunDelivery = {
  destinations: Array<{
    evidence: { type: "inbox_item" } | { type: "tool_call"; tool: string };
  }>;
};

export const PRODUCE_INBOX_ITEM_TOOL = "produce_inbox_item";

export function dryRunBlockedTools(delivery: DryRunDelivery | undefined): string[] {
  const names = new Set<string>();
  for (const destination of delivery?.destinations ?? []) {
    if (destination.evidence.type === "inbox_item") {
      names.add(PRODUCE_INBOX_ITEM_TOOL);
    } else if (destination.evidence.tool.trim()) {
      names.add(destination.evidence.tool.trim());
    }
  }
  return [...names].sort();
}

export function composioUsesLooseRouter(rawConnections: unknown): boolean {
  if (!Array.isArray(rawConnections)) return false;
  for (const item of rawConnections) {
    if (typeof item === "string") return true;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.type === "string" || typeof obj.toolkit === "string") {
      if (isNonComposioSource(obj.source)) continue;
      if (!hasToolList(obj.tools)) return true;
      continue;
    }
    const keys = Object.keys(obj);
    if (keys.length !== 1) continue;
    const body = obj[keys[0]!];
    if (Array.isArray(body)) {
      if (body.length === 0) return true;
      continue;
    }
    if (body && typeof body === "object") {
      const inner = body as Record<string, unknown>;
      if (isNonComposioSource(inner.source)) continue;
      if (!hasToolList(inner.tools)) return true;
      continue;
    }
    return true;
  }
  return false;
}

export function dryRunUnavailableReason(input: {
  framework: DryRunFramework;
  delivery?: DryRunDelivery;
  connections?: unknown;
}): string | null {
  if (input.framework === "cargo-ai") {
    return "Dry run is not available for Cargo AI agents yet.";
  }
  if (!input.delivery || input.delivery.destinations.length === 0) {
    return "This agent has no delivery: declaration, so TAS cannot tell which tools to block.";
  }
  const hasToolCall = input.delivery.destinations.some(
    (destination) => destination.evidence.type === "tool_call",
  );
  if (hasToolCall && composioUsesLooseRouter(input.connections)) {
    return "This agent uses the Composio tool router, so TAS cannot block only the declared delivery tools.";
  }
  return null;
}

function isNonComposioSource(source: unknown): boolean {
  return source === "native-mcp" || source === "secret";
}

function hasToolList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}
