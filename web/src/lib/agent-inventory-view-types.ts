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
export type AgentInventoryOwner = "me" | "others";
export type AgentInventoryViewVisibility = "personal" | "shared";
export type AgentInventoryFilterOperator = "is" | "is-not";
export type AgentInventoryFilterKey =
  | "owner"
  | "starred"
  | "status"
  | "promotionOnly"
  | "label"
  | "model"
  | "mcp"
  | "agentType"
  | "orchestrator";

export type AgentInventoryFilterOperators = Record<
  AgentInventoryFilterKey,
  AgentInventoryFilterOperator
>;

export type AgentInventoryFilters = {
  query: string;
  owner: AgentInventoryOwner[];
  starred: boolean[];
  status: AgentInventoryStatus[];
  promotionOnly: boolean;
  label: string[];
  model: string[];
  mcp: string[];
  agentType: AgentInventoryType[];
  orchestrator: string[];
  operators: AgentInventoryFilterOperators;
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
const OWNERS: AgentInventoryOwner[] = ["me", "others"];
const FILTER_KEYS: AgentInventoryFilterKey[] = [
  "owner",
  "starred",
  "status",
  "promotionOnly",
  "label",
  "model",
  "mcp",
  "agentType",
  "orchestrator",
];

export function defaultAgentInventoryFilterOperators(): AgentInventoryFilterOperators {
  return {
    owner: "is",
    starred: "is",
    status: "is",
    promotionOnly: "is",
    label: "is",
    model: "is",
    mcp: "is",
    agentType: "is",
    orchestrator: "is",
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function shortString(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringList<T extends string>(
  value: unknown,
  allowed?: readonly T[],
): T[] {
  const input = Array.isArray(value) ? value : [value];
  const result: T[] = [];
  for (const candidate of input.slice(0, 50)) {
    const normalized = shortString(candidate) as T;
    if (
      normalized &&
      (!allowed || allowed.includes(normalized)) &&
      !result.includes(normalized)
    ) {
      result.push(normalized);
    }
  }
  return result;
}

function booleanList(value: unknown): boolean[] {
  const input = Array.isArray(value) ? value : [value];
  const result: boolean[] = [];
  for (const candidate of input) {
    if (typeof candidate === "boolean" && !result.includes(candidate)) {
      result.push(candidate);
    }
  }
  return result;
}

function normalizeOperators(value: unknown): AgentInventoryFilterOperators {
  const input = record(value);
  const result = defaultAgentInventoryFilterOperators();
  for (const key of FILTER_KEYS) {
    if (input[key] === "is-not") result[key] = "is-not";
  }
  return result;
}

export function normalizeAgentInventoryFilters(
  value: unknown,
): AgentInventoryFilters {
  const input = record(value);
  return {
    query: shortString(input.query),
    owner: stringList(input.owner, OWNERS),
    starred: booleanList(input.starred),
    status: stringList(input.status, STATUSES),
    promotionOnly: input.promotionOnly === true,
    label: stringList(input.label),
    model: stringList(input.model),
    mcp: stringList(input.mcp),
    agentType: stringList(input.agentType, TYPES),
    orchestrator: stringList(input.orchestrator),
    operators: normalizeOperators(input.operators),
    sort: SORTS.includes(input.sort as AgentInventorySort)
      ? (input.sort as AgentInventorySort)
      : "last-run",
  };
}

export function matchesAgentInventoryValues<T>(
  actual: readonly T[],
  selected: readonly T[],
  operator: AgentInventoryFilterOperator,
): boolean {
  if (selected.length === 0) return true;
  const matches = actual.some((value) => selected.includes(value));
  return operator === "is-not" ? !matches : matches;
}

export function matchesAgentOwnershipFilters(
  agent: { kind: string; isMine?: boolean; isStarred?: boolean },
  owners: readonly AgentInventoryOwner[],
  starred: readonly boolean[],
  operators: Pick<AgentInventoryFilterOperators, "owner" | "starred">,
): boolean {
  if (owners.length === 0 && starred.length === 0) return true;
  if (agent.kind !== "live") return false;
  return (
    matchesAgentInventoryValues(
      [agent.isMine ? "me" : "others"],
      owners,
      operators.owner,
    ) &&
    matchesAgentInventoryValues(
      [Boolean(agent.isStarred)],
      starred,
      operators.starred,
    )
  );
}

export function matchesAgentRelationshipFilters(
  agent: {
    kind: string;
    subAgentNames?: string[];
    orchestratorNames?: string[];
  },
  agentTypes: readonly AgentInventoryType[],
  orchestrators: readonly string[],
  operators: Pick<AgentInventoryFilterOperators, "agentType" | "orchestrator">,
): boolean {
  if (agentTypes.length === 0 && orchestrators.length === 0) return true;
  if (agent.kind !== "live") return false;

  const children = agent.subAgentNames ?? [];
  const parents = agent.orchestratorNames ?? [];
  const actualTypes: AgentInventoryType[] = [];
  if (children.length > 0) actualTypes.push("orchestrator");
  if (parents.length > 0) actualTypes.push("sub-agent");

  return (
    matchesAgentInventoryValues(actualTypes, agentTypes, operators.agentType) &&
    matchesAgentInventoryValues(parents, orchestrators, operators.orchestrator)
  );
}
