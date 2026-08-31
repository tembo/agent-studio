"use client";

import { useState } from "react";

import { Select, type SelectOption } from "@/components/ui/select";
import type {
  AgentInventoryFilters,
  AgentInventoryStatus,
  AgentInventoryType,
} from "@/lib/agent-inventory-view-types";

type FilterKey =
  | "membership"
  | "status"
  | "promotionOnly"
  | "label"
  | "model"
  | "mcp"
  | "agentType"
  | "orchestrator";

type Props = {
  filters: AgentInventoryFilters;
  onChange: (filters: AgentInventoryFilters) => void;
  statusCounts: Record<AgentInventoryStatus | "all", number>;
  pendingPromotionCount: number;
  labelOptions: SelectOption[];
  modelOptions: SelectOption[];
  mcpOptions: SelectOption[];
  orchestratorOptions: SelectOption[];
};

export function AgentInventoryFilterBar({
  filters,
  onChange,
  statusCounts,
  pendingPromotionCount,
  labelOptions,
  modelOptions,
  mcpOptions,
  orchestratorOptions,
}: Props) {
  const [adding, setAdding] = useState(false);
  const available = filterChoices({
    filters,
    pendingPromotionCount,
    labelOptions,
    modelOptions,
    mcpOptions,
    orchestratorOptions,
  });

  function update<K extends keyof AgentInventoryFilters>(
    key: K,
    value: AgentInventoryFilters[K],
  ) {
    onChange({ ...filters, [key]: value });
  }

  return (
    <div className="border-border bg-surface-raised flex min-h-11 flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
      {filters.membership === "mine" && (
        <FilterPill
          label="List"
          value={filters.membership}
          options={[
            { value: "mine", label: "Mine + Starred" },
            { value: "all", label: "All agents" },
          ]}
          ariaLabel="Filter agent ownership"
          onChange={(value) => update("membership", value as "mine" | "all")}
          onRemove={() => update("membership", "all")}
        />
      )}
      {filters.status && (
        <FilterPill
          label="Status"
          value={filters.status}
          options={STATUS_OPTIONS.map((option) => ({
            ...option,
            label: `${option.label} · ${statusCounts[option.value]}`,
          }))}
          ariaLabel="Filter agent status"
          onChange={(value) => update("status", value as AgentInventoryStatus)}
          onRemove={() => update("status", null)}
        />
      )}
      {filters.promotionOnly && (
        <FilterPill
          label="Draft"
          value="pending"
          options={[{ value: "pending", label: "Needs promotion" }]}
          ariaLabel="Filter pending promotions"
          onChange={() => undefined}
          onRemove={() => update("promotionOnly", false)}
        />
      )}
      {filters.label && (
        <FilterPill
          label="Label"
          value={filters.label}
          options={withoutEmpty(labelOptions, filters.label)}
          ariaLabel="Filter by label"
          onChange={(value) => update("label", value)}
          onRemove={() => update("label", "")}
        />
      )}
      {filters.model && (
        <FilterPill
          label="Model"
          value={filters.model}
          options={withoutEmpty(modelOptions, filters.model)}
          ariaLabel="Filter by model"
          onChange={(value) => update("model", value)}
          onRemove={() => update("model", "")}
        />
      )}
      {filters.mcp && (
        <FilterPill
          label="MCP"
          value={filters.mcp}
          options={withoutEmpty(mcpOptions, filters.mcp)}
          ariaLabel="Filter by MCP"
          onChange={(value) => update("mcp", value)}
          onRemove={() => update("mcp", "")}
        />
      )}
      {filters.agentType && (
        <FilterPill
          label="Type"
          value={filters.agentType}
          options={[
            { value: "orchestrator", label: "Orchestrator" },
            { value: "sub-agent", label: "Sub-agent" },
          ]}
          ariaLabel="Filter by agent type"
          onChange={(value) => update("agentType", value as AgentInventoryType)}
          onRemove={() => update("agentType", "")}
        />
      )}
      {filters.orchestrator && (
        <FilterPill
          label="Sub-agent of"
          value={filters.orchestrator}
          options={withoutEmpty(orchestratorOptions, filters.orchestrator).map(
            (option) => ({
              ...option,
              label: option.label.replace(/^Sub-agents of /, ""),
            }),
          )}
          ariaLabel="Filter by orchestrator"
          onChange={(value) => update("orchestrator", value)}
          onRemove={() => update("orchestrator", "")}
        />
      )}

      <div className="relative">
        <button
          type="button"
          aria-expanded={adding}
          onClick={() => setAdding((open) => !open)}
          className="text-foreground-weak hover:bg-interactive-state-hover hover:text-foreground rounded-md px-2 py-1 text-sm"
        >
          + Add filter
        </button>
        {adding && (
          <div className="border-border bg-surface-raised absolute left-0 top-full z-30 mt-1 w-56 rounded-lg border p-1 shadow-lg">
            <p className="text-foreground-muted px-2 py-1 text-xs font-medium uppercase tracking-wide">
              Filter agents by
            </p>
            {available.length > 0 ? (
              available.map((choice) => (
                <button
                  key={choice.key}
                  type="button"
                  onClick={() => {
                    addFilter(choice.key, filters, onChange, {
                      labelOptions,
                      modelOptions,
                      mcpOptions,
                      orchestratorOptions,
                    });
                    setAdding(false);
                  }}
                  className="text-foreground hover:bg-interactive-state-hover flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm"
                >
                  {choice.label}
                </button>
              ))
            ) : (
              <p className="text-foreground-muted px-2 py-2 text-sm">
                All available filters are added.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterPill({
  label,
  value,
  options,
  ariaLabel,
  onChange,
  onRemove,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  ariaLabel: string;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="border-border bg-surface inline-flex h-7 items-center overflow-hidden rounded-md border text-sm">
      <span className="text-foreground-weak border-border-weak border-r px-2">
        {label}
      </span>
      <span className="text-foreground-muted border-border-weak border-r px-1.5">
        is
      </span>
      <Select
        value={value}
        onValueChange={onChange}
        options={options}
        ariaLabel={ariaLabel}
        className="h-7 min-w-0 rounded-none bg-transparent px-2 shadow-none"
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
        className="text-foreground-muted hover:bg-interactive-state-hover hover:text-foreground h-full border-l border-border-weak px-2"
      >
        ×
      </button>
    </div>
  );
}

const STATUS_OPTIONS: Array<{ value: AgentInventoryStatus; label: string }> = [
  { value: "active", label: "Active" },
  { value: "idle", label: "Idle" },
  { value: "error", label: "Error" },
  { value: "pending", label: "Pending" },
  { value: "invalid", label: "Invalid" },
];

function filterChoices(args: {
  filters: AgentInventoryFilters;
  pendingPromotionCount: number;
  labelOptions: SelectOption[];
  modelOptions: SelectOption[];
  mcpOptions: SelectOption[];
  orchestratorOptions: SelectOption[];
}): Array<{ key: FilterKey; label: string }> {
  const result: Array<{ key: FilterKey; label: string }> = [];
  if (args.filters.membership === "all") {
    result.push({ key: "membership", label: "Mine + Starred" });
  }
  if (!args.filters.status) result.push({ key: "status", label: "Status" });
  if (!args.filters.promotionOnly && args.pendingPromotionCount > 0) {
    result.push({ key: "promotionOnly", label: "Draft needs promotion" });
  }
  if (!args.filters.label && args.labelOptions.length > 1) {
    result.push({ key: "label", label: "Label" });
  }
  if (!args.filters.model && args.modelOptions.length > 1) {
    result.push({ key: "model", label: "Model" });
  }
  if (!args.filters.mcp && args.mcpOptions.length > 1) {
    result.push({ key: "mcp", label: "MCP connection" });
  }
  if (!args.filters.agentType) {
    result.push({ key: "agentType", label: "Agent type" });
  }
  if (!args.filters.orchestrator && args.orchestratorOptions.length > 1) {
    result.push({ key: "orchestrator", label: "Sub-agent of orchestrator" });
  }
  return result;
}

function addFilter(
  key: FilterKey,
  filters: AgentInventoryFilters,
  onChange: (filters: AgentInventoryFilters) => void,
  options: {
    labelOptions: SelectOption[];
    modelOptions: SelectOption[];
    mcpOptions: SelectOption[];
    orchestratorOptions: SelectOption[];
  },
) {
  const defaults: Record<FilterKey, AgentInventoryFilters[FilterKey]> = {
    membership: "mine",
    status: "active",
    promotionOnly: true,
    label: options.labelOptions[1]?.value ?? "",
    model: options.modelOptions[1]?.value ?? "",
    mcp: options.mcpOptions[1]?.value ?? "",
    agentType: "orchestrator",
    orchestrator: options.orchestratorOptions[1]?.value ?? "",
  };
  onChange({ ...filters, [key]: defaults[key] });
}

function withoutEmpty(options: SelectOption[], current: string): SelectOption[] {
  const values = options.filter((option) => option.value);
  return values.some((option) => option.value === current)
    ? values
    : [{ value: current, label: current }, ...values];
}
