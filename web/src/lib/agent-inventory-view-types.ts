export type AgentInventoryStatus =
  | "active"
  | "idle"
  | "error"
  | "pending"
  | "invalid";

export type AgentInventorySort =
  | "last-run"
  | "name"
  | "status"
  | "runs"
  | "cost"
  | "success";

export type AgentInventoryType = "orchestrator" | "sub-agent";
export type AgentInventoryViewVisibility = "personal" | "shared";

export type AgentInventoryFilters = {
  query: string;
  membership: "mine" | "all";
  status: AgentInventoryStatus | null;
  promotionOnly: boolean;
  label: string;
  model: string;
  mcp: string;
  agentType: AgentInventoryType | "";
  orchestrator: string;
  sort: AgentInventorySort;
};

export type AgentInventoryView = {
  id: string;
  name: string;
  visibility: AgentInventoryViewVisibility;
  createdBy: string;
  filters: AgentInventoryFilters;
};

const STATUSES: AgentInventoryStatus[] = [
  "active",
  "idle",
  "error",
  "pending",
  "invalid",
];
const SORTS: AgentInventorySort[] = [
  "last-run",
  "name",
  "status",
  "runs",
  "cost",
  "success",
];
const TYPES: AgentInventoryType[] = ["orchestrator", "sub-agent"];

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function shortString(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeAgentInventoryFilters(
  value: unknown,
): AgentInventoryFilters {
  const input = record(value);
  return {
    query: shortString(input.query),
    membership: input.membership === "mine" ? "mine" : "all",
    status: STATUSES.includes(input.status as AgentInventoryStatus)
      ? (input.status as AgentInventoryStatus)
      : null,
    promotionOnly: input.promotionOnly === true,
    label: shortString(input.label),
    model: shortString(input.model),
    mcp: shortString(input.mcp),
    agentType: TYPES.includes(input.agentType as AgentInventoryType)
      ? (input.agentType as AgentInventoryType)
      : "",
    orchestrator: shortString(input.orchestrator),
    sort: SORTS.includes(input.sort as AgentInventorySort)
      ? (input.sort as AgentInventorySort)
      : "last-run",
  };
}

export function matchesAgentRelationshipFilters(
  agent: {
    kind: string;
    subAgentNames?: string[];
    orchestratorNames?: string[];
  },
  agentType: AgentInventoryType | "",
  orchestrator: string,
): boolean {
  if (!agentType && !orchestrator) return true;
  if (agent.kind !== "live") return false;

  const children = agent.subAgentNames ?? [];
  const parents = agent.orchestratorNames ?? [];
  if (agentType === "orchestrator" && children.length === 0) return false;
  if (agentType === "sub-agent" && parents.length === 0) return false;
  return !orchestrator || parents.includes(orchestrator);
}
