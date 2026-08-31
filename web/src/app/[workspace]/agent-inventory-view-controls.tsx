"use client";

import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type ReactNode,
  useState,
  useTransition,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type {
  AgentInventoryFilters,
  AgentInventoryView,
  AgentInventoryViewVisibility,
} from "@/lib/agent-inventory-view-types";

import {
  deleteAgentInventoryViewAction,
  saveAgentInventoryViewAction,
} from "./agent-inventory-view-actions";

type Props = {
  workspaceSlug: string;
  currentUserId: string;
  canManageSharedViews: boolean;
  filters: AgentInventoryFilters;
  defaultFilters: AgentInventoryFilters;
  views: AgentInventoryView[];
  onApply: (filters: AgentInventoryFilters) => void;
  children: ReactNode;
};

export function AgentInventoryViewControls({
  workspaceSlug,
  currentUserId,
  canManageSharedViews,
  filters,
  defaultFilters,
  views,
  onApply,
  children,
}: Props) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] =
    useState<AgentInventoryViewVisibility>("personal");
  const [saveError, setSaveError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [saving, startSave] = useTransition();
  const [deleting, startDelete] = useTransition();
  const selected = creating
    ? undefined
    : views.find((view) => filterKey(view.filters) === filterKey(filters));
  const canDeleteSelected =
    selected &&
    (selected.createdBy === currentUserId ||
      (selected.visibility === "shared" && canManageSharedViews));

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveError("");
    startSave(async () => {
      const result = await saveAgentInventoryViewAction({
        workspaceSlug,
        name,
        visibility,
        filters,
      });
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      onApply(result.view.filters);
      setName("");
      setCreating(false);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={selected?.id ?? ""}
          onValueChange={(id) => {
            const next = views.find((view) => view.id === id);
            if (next) onApply(next.filters);
          }}
          options={[
            {
              value: "",
              label: views.length > 0 ? "Custom view" : "No saved views",
            },
            ...views.map((view) => ({
              value: view.id,
              label: `${view.name} · ${view.visibility === "personal" ? "Personal" : "Shared"}`,
            })),
          ]}
          ariaLabel="Saved agent view"
          className="min-w-[220px]"
        />
        <Button
          variant="secondary"
          onClick={() => {
            setName("");
            setVisibility("personal");
            setSaveError("");
            onApply({ ...defaultFilters, membership: "all" });
            setCreating(true);
          }}
        >
          New view
        </Button>
        <Button variant="ghost" onClick={() => onApply(defaultFilters)}>
          Reset
        </Button>
        {canDeleteSelected && (
          <Button
            variant="ghost"
            disabled={deleting}
            onClick={() => {
              setDeleteError("");
              startDelete(async () => {
                const result = await deleteAgentInventoryViewAction({
                  workspaceSlug,
                  viewId: selected.id,
                });
                if (!result.ok) {
                  setDeleteError(result.error);
                  return;
                }
                router.refresh();
              });
            }}
          >
            {deleting ? "Deleting…" : "Delete view"}
          </Button>
        )}
        {deleteError && (
          <span className="text-sentiment-negative text-sm" role="alert">
            {deleteError}
          </span>
        )}
      </div>

      {creating && (
        <form
          onSubmit={save}
          className="border-border bg-surface-raised overflow-hidden rounded-lg border"
        >
          <div className="flex flex-col gap-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-64 flex-1">
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  autoFocus
                  placeholder="Name this view…"
                  aria-label="View name"
                  className="text-base font-semibold"
                />
                <p className="text-foreground-muted mt-2 text-sm">
                  Add or edit filters below. The agent list updates as you make
                  changes.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={visibility}
                  onValueChange={(value) =>
                    setVisibility(value as AgentInventoryViewVisibility)
                  }
                  options={[
                    { value: "personal", label: "Personal · only me" },
                    { value: "shared", label: "Shared · whole workspace" },
                  ]}
                  ariaLabel="View visibility"
                  className="min-w-[190px]"
                />
                <Button
                  variant="ghost"
                  disabled={saving}
                  onClick={() => setCreating(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
            {saveError && (
              <p className="text-sentiment-negative text-sm" role="alert">
                {saveError}
              </p>
            )}
          </div>
          <div className="border-border border-t [&>div]:rounded-none [&>div]:border-0">
            {children}
          </div>
        </form>
      )}

      {!creating && children}
    </div>
  );
}

function filterKey(filters: AgentInventoryFilters): string {
  return JSON.stringify(filters);
}
