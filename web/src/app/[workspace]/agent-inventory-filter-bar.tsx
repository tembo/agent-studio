"use client";

import { useState } from "react";

import {
  MultiSelect,
  Select,
  type SelectOption,
} from "@/components/ui/select";
import type {
  AgentInventoryFilterKey,
  AgentInventoryFilterOperator,
  AgentInventoryFilters,
  AgentInventoryOwner,
  AgentInventoryStatus,
  AgentInventoryType,
} from "@/lib/agent-inventory-view-types";

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

  function updateOperator(
    key: AgentInventoryFilterKey,
    operator: AgentInventoryFilterOperator,
  ) {
    onChange({
      ...filters,
      operators: { ...filters.operators, [key]: operator },
    });
  }

  function removeFilter<K extends AgentInventoryFilterKey>(
    key: K,
    emptyValue: AgentInventoryFilters[K],
  ) {
    onChange({
      ...filters,
      [key]: emptyValue,
      operators: { ...filters.operators, [key]: "is" },
    });
  }

  return (
    <div className="border-border bg-surface-raised flex min-h-11 flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
      {filters.owner.length > 0 && (
        <FilterPill
          label="Owner"
          values={filters.owner}
          options={[
            { value: "me", label: "Me" },
            { value: "others", label: "Others" },
          ]}
          operator={filters.operators.owner}
          ariaLabel="Filter agent ownership"
          onValuesChange={(values) =>
            update("owner", values as AgentInventoryOwner[])
          }
          onOperatorChange={(operator) => updateOperator("owner", operator)}
          onRemove={() => removeFilter("owner", [])}
        />
      )}
      {filters.starred.length > 0 && (
        <FilterPill
          label="Starred"
          values={filters.starred.map(String)}
          options={[
            { value: "true", label: "True" },
            { value: "false", label: "False" },
          ]}
          operator={filters.operators.starred}
          ariaLabel="Filter starred agents"
          onValuesChange={(values) =>
            update(
              "starred",
              values.map((value) => value === "true"),
            )
          }
          onOperatorChange={(operator) => updateOperator("starred", operator)}
          onRemove={() => removeFilter("starred", [])}
        />
      )}
      {filters.status.length > 0 && (
        <FilterPill
          label="Status"
          values={filters.status}
          options={STATUS_OPTIONS.map((option) => ({
            ...option,
            label: `${option.label} · ${statusCounts[option.value]}`,
          }))}
          operator={filters.operators.status}
          ariaLabel="Filter agent status"
          onValuesChange={(values) =>
            update("status", values as AgentInventoryStatus[])
          }
          onOperatorChange={(operator) => updateOperator("status", operator)}
          onRemove={() => removeFilter("status", [])}
        />
      )}
      {filters.promotionOnly && (
        <FilterPill
          label="Draft"
          values={["pending"]}
          options={[{ value: "pending", label: "Needs promotion" }]}
          operator={filters.operators.promotionOnly}
          ariaLabel="Filter pending promotions"
          onValuesChange={() => undefined}
          onOperatorChange={(operator) =>
            updateOperator("promotionOnly", operator)
          }
          onRemove={() => removeFilter("promotionOnly", false)}
          fixedValue
        />
      )}
      {filters.label.length > 0 && (
        <FilterPill
          label="Label"
          values={filters.label}
          options={withCurrentOptions(labelOptions, filters.label)}
          operator={filters.operators.label}
          ariaLabel="Filter by label"
          onValuesChange={(values) => update("label", values)}
          onOperatorChange={(operator) => updateOperator("label", operator)}
          onRemove={() => removeFilter("label", [])}
        />
      )}
      {filters.model.length > 0 && (
        <FilterPill
          label="Model"
          values={filters.model}
          options={withCurrentOptions(modelOptions, filters.model)}
          operator={filters.operators.model}
          ariaLabel="Filter by model"
          onValuesChange={(values) => update("model", values)}
          onOperatorChange={(operator) => updateOperator("model", operator)}
          onRemove={() => removeFilter("model", [])}
        />
      )}
      {filters.mcp.length > 0 && (
        <FilterPill
          label="MCP"
          values={filters.mcp}
          options={withCurrentOptions(mcpOptions, filters.mcp)}
          operator={filters.operators.mcp}
          ariaLabel="Filter by MCP"
          onValuesChange={(values) => update("mcp", values)}
          onOperatorChange={(operator) => updateOperator("mcp", operator)}
          onRemove={() => removeFilter("mcp", [])}
        />
      )}
      {filters.agentType.length > 0 && (
        <FilterPill
          label="Type"
          values={filters.agentType}
          options={[
            { value: "orchestrator", label: "Orchestrator" },
            { value: "sub-agent", label: "Sub-agent" },
          ]}
          operator={filters.operators.agentType}
          ariaLabel="Filter by agent type"
          onValuesChange={(values) =>
            update("agentType", values as AgentInventoryType[])
          }
          onOperatorChange={(operator) => updateOperator("agentType", operator)}
          onRemove={() => removeFilter("agentType", [])}
        />
      )}
      {filters.orchestrator.length > 0 && (
        <FilterPill
          label="Sub-agent of"
          values={filters.orchestrator}
          options={withCurrentOptions(
            orchestratorOptions,
            filters.orchestrator,
          ).map((option) => ({
            ...option,
            label: option.label.replace(/^Sub-agents of /, ""),
          }))}
          operator={filters.operators.orchestrator}
          ariaLabel="Filter by orchestrator"
          onValuesChange={(values) => update("orchestrator", values)}
          onOperatorChange={(operator) =>
            updateOperator("orchestrator", operator)
          }
          onRemove={() => removeFilter("orchestrator", [])}
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
  values,
  options,
  operator,
  ariaLabel,
  onValuesChange,
  onOperatorChange,
  onRemove,
  fixedValue = false,
}: {
  label: string;
  values: string[];
  options: SelectOption[];
  operator: AgentInventoryFilterOperator;
  ariaLabel: string;
  onValuesChange: (values: string[]) => void;
  onOperatorChange: (operator: AgentInventoryFilterOperator) => void;
  onRemove: () => void;
  fixedValue?: boolean;
}) {
  const valueLabel = options
    .filter((option) => values.includes(option.value))
    .map((option) => option.label)
    .join(", ");

  return (
    <div className="border-border bg-surface inline-flex h-7 items-center rounded-md border text-sm">
      <span className="text-foreground-weak border-border-weak flex h-full items-center border-r px-2">
        {label}
      </span>
      <Select
        value={operator}
        onValueChange={(value) =>
          onOperatorChange(value as AgentInventoryFilterOperator)
        }
        options={[
          { value: "is", label: "is" },
          { value: "is-not", label: "is not" },
        ]}
        ariaLabel={`${label} filter operator`}
        hideIcon
        hideIndicator
        alignItemWithTrigger={false}
        popupClassName="min-w-40 py-1"
        className="text-foreground-muted h-full rounded-none border-0 bg-transparent px-2 font-normal shadow-none"
      />
      {fixedValue ? (
        <span className="text-foreground-strong flex h-full max-w-64 items-center border-l border-border-weak px-2 font-medium">
          {valueLabel}
        </span>
      ) : (
        <MultiSelect
          value={values}
          onValueChange={onValuesChange}
          options={options}
          ariaLabel={ariaLabel}
          className="h-full max-w-64 min-w-0 rounded-none border-0 border-l border-border-weak bg-transparent px-2 font-medium shadow-none"
        />
      )}
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
}): Array<{ key: AgentInventoryFilterKey; label: string }> {
  const result: Array<{ key: AgentInventoryFilterKey; label: string }> = [];
  if (args.filters.owner.length === 0) {
    result.push({ key: "owner", label: "Owner" });
  }
  if (args.filters.starred.length === 0) {
    result.push({ key: "starred", label: "Starred" });
  }
  if (args.filters.status.length === 0) {
    result.push({ key: "status", label: "Status" });
  }
  if (!args.filters.promotionOnly && args.pendingPromotionCount > 0) {
    result.push({ key: "promotionOnly", label: "Draft needs promotion" });
  }
  if (args.filters.label.length === 0 && args.labelOptions.length > 1) {
    result.push({ key: "label", label: "Label" });
  }
  if (args.filters.model.length === 0 && args.modelOptions.length > 1) {
    result.push({ key: "model", label: "Model" });
  }
  if (args.filters.mcp.length === 0 && args.mcpOptions.length > 1) {
    result.push({ key: "mcp", label: "MCP connection" });
  }
  if (args.filters.agentType.length === 0) {
    result.push({ key: "agentType", label: "Agent type" });
  }
  if (
    args.filters.orchestrator.length === 0 &&
    args.orchestratorOptions.length > 1
  ) {
    result.push({ key: "orchestrator", label: "Sub-agent of orchestrator" });
  }
  return result;
}

function addFilter(
  key: AgentInventoryFilterKey,
  filters: AgentInventoryFilters,
  onChange: (filters: AgentInventoryFilters) => void,
  options: {
    labelOptions: SelectOption[];
    modelOptions: SelectOption[];
    mcpOptions: SelectOption[];
    orchestratorOptions: SelectOption[];
  },
) {
  const defaults: Record<
    AgentInventoryFilterKey,
    AgentInventoryFilters[AgentInventoryFilterKey]
  > = {
    owner: ["me"],
    starred: [true],
    status: ["active"],
    promotionOnly: true,
    label: firstOption(options.labelOptions),
    model: firstOption(options.modelOptions),
    mcp: firstOption(options.mcpOptions),
    agentType: ["orchestrator"],
    orchestrator: firstOption(options.orchestratorOptions),
  };
  onChange({
    ...filters,
    [key]: defaults[key],
    operators: { ...filters.operators, [key]: "is" },
  });
}

function firstOption(options: SelectOption[]): string[] {
  const value = options.find((option) => option.value)?.value;
  return value ? [value] : [];
}

function withCurrentOptions(
  options: SelectOption[],
  current: string[],
): SelectOption[] {
  const values = options.filter((option) => option.value);
  const known = new Set(values.map((option) => option.value));
  return [
    ...current
      .filter((value) => !known.has(value))
      .map((value) => ({ value, label: value })),
    ...values,
  ];
}
