"use client";

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

const ALL_VIEW_ID = "built-in:all";
const MINE_VIEW_ID = "built-in:mine";

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
  const builtInViews = [
    { id: ALL_VIEW_ID, name: "All", filters: defaultFilters },
    {
      id: MINE_VIEW_ID,
      name: "Mine",
      filters: {
        ...defaultFilters,
        owner: ["me" as const],
        operators: { ...defaultFilters.operators, owner: "is" as const },
      },
    },
  ];
  const initialViewId =
    builtInViews.find(
      (view) => filterKey(view.filters) === filterKey(filters),
    )?.id ??
    views.find((view) => filterKey(view.filters) === filterKey(filters))?.id ??
    ALL_VIEW_ID;
  const [activeViewId, setActiveViewId] = useState(initialViewId);
  const [availableViews, setAvailableViews] = useState(views);
  const [creating, setCreating] = useState(false);
  const [editingViewId, setEditingViewId] = useState("");
  const [editorStartViewId, setEditorStartViewId] = useState("");
  const [editorStartFilters, setEditorStartFilters] = useState(filters);
  const [name, setName] = useState("");
  const [visibility, setVisibility] =
    useState<AgentInventoryViewVisibility>("personal");
  const [saveError, setSaveError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [saving, startSave] = useTransition();
  const [deleting, startDelete] = useTransition();
  const editorOpen = creating || Boolean(editingViewId);
  const selected = availableViews.find((view) => view.id === activeViewId);
  const selectedBuiltIn = builtInViews.find(
    (view) => view.id === activeViewId,
  );
  const selectedFilters = selected?.filters ?? selectedBuiltIn?.filters;
  const editingView = availableViews.find(
    (view) => view.id === editingViewId,
  );
  const canManageSelected =
    selected &&
    (selected.createdBy === currentUserId ||
      (selected.visibility === "shared" && canManageSharedViews));
  const selectedIsDirty =
    selectedFilters && filterKey(selectedFilters) !== filterKey(filters);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveError("");
    startSave(async () => {
      const result = await saveAgentInventoryViewAction({
        workspaceSlug,
        viewId: editingViewId || undefined,
        name,
        visibility,
        filters,
      });
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      onApply(result.view.filters);
      setAvailableViews((current) => upsertView(current, result.view));
      setActiveViewId(result.view.id);
      setName("");
      setCreating(false);
      setEditingViewId("");
    });
  }

  function saveCurrentFilters() {
    if (!selected || !canManageSelected) return;
    setSaveError("");
    startSave(async () => {
      const result = await saveAgentInventoryViewAction({
        workspaceSlug,
        viewId: selected.id,
        name: selected.name,
        visibility: selected.visibility,
        filters,
      });
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      onApply(result.view.filters);
      setAvailableViews((current) => upsertView(current, result.view));
    });
  }

  function createFromCurrentFilters() {
    setEditorStartViewId(activeViewId);
    setEditorStartFilters(filters);
    setName("");
    setVisibility("personal");
    setSaveError("");
    setEditingViewId("");
    setCreating(true);
  }

  function cancelEditor() {
    onApply(editorStartFilters);
    setActiveViewId(editorStartViewId);
    setCreating(false);
    setEditingViewId("");
    setSaveError("");
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={selected?.id ?? selectedBuiltIn?.id ?? ""}
          onValueChange={(id) => {
            setCreating(false);
            setEditingViewId("");
            setSaveError("");
            setActiveViewId(id);
            const next =
              builtInViews.find((view) => view.id === id) ??
              availableViews.find((view) => view.id === id);
            if (next) onApply(next.filters);
          }}
          options={[
            ...builtInViews.map((view) => ({
              value: view.id,
              label: `${view.name}${view.id === selectedBuiltIn?.id && selectedIsDirty ? " · Unsaved" : ""}`,
            })),
            ...availableViews.map((view) => ({
              value: view.id,
              label: `${view.name} · ${view.visibility === "personal" ? "Personal" : "Shared"}${view.id === selected?.id && selectedIsDirty ? " · Unsaved" : ""}`,
            })),
          ]}
          ariaLabel="Saved agent view"
          className="min-w-[220px]"
        />
        <Button
          variant="secondary"
          onClick={() => {
            setEditorStartViewId(activeViewId);
            setEditorStartFilters(filters);
            setName("");
            setVisibility("personal");
            setSaveError("");
            setEditingViewId("");
            setActiveViewId("");
            onApply(defaultFilters);
            setCreating(true);
          }}
        >
          New view
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setActiveViewId(ALL_VIEW_ID);
            setCreating(false);
            setEditingViewId("");
            onApply(defaultFilters);
          }}
        >
          Reset
        </Button>
        {selectedIsDirty && !editorOpen && (
          <Button
            variant="primary"
            disabled={saving}
            onClick={
              selected && canManageSelected
                ? saveCurrentFilters
                : createFromCurrentFilters
            }
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
        {canManageSelected && !editorOpen && (
          <Button
            variant="ghost"
            onClick={() => {
              setEditorStartViewId(activeViewId);
              setEditorStartFilters(filters);
              setName(selected.name);
              setVisibility(selected.visibility);
              setSaveError("");
              setCreating(false);
              setEditingViewId(selected.id);
            }}
          >
            Edit view
          </Button>
        )}
        {canManageSelected && !editorOpen && (
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
                setAvailableViews((current) =>
                  current.filter((view) => view.id !== selected.id),
                );
                setActiveViewId(ALL_VIEW_ID);
                onApply(defaultFilters);
              });
            }}
          >
            {deleting ? "Deleting…" : "Delete view"}
          </Button>
        )}
        {(deleteError || (!editorOpen && saveError)) && (
          <span className="text-sentiment-negative text-sm" role="alert">
            {deleteError || saveError}
          </span>
        )}
      </div>

      {editorOpen && (
        <form
          onSubmit={save}
          className="border-border bg-surface-raised overflow-visible rounded-lg border"
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
                  options={
                    editingView && editingView.createdBy !== currentUserId
                      ? [{ value: "shared", label: "Shared · whole workspace" }]
                      : [
                          { value: "personal", label: "Personal · only me" },
                          { value: "shared", label: "Shared · whole workspace" },
                        ]
                  }
                  ariaLabel="View visibility"
                  className="min-w-[190px]"
                />
                <Button
                  variant="ghost"
                  disabled={saving}
                  onClick={cancelEditor}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={saving}>
                  {saving ? "Saving…" : editingViewId ? "Save changes" : "Save"}
                </Button>
              </div>
            </div>
            {saveError && (
              <p className="text-sentiment-negative text-sm" role="alert">
                {saveError}
              </p>
            )}
          </div>
          <div className="border-border border-t [&>div]:rounded-b-lg [&>div]:rounded-t-none [&>div]:border-0">
            {children}
          </div>
        </form>
      )}

      {!editorOpen && children}
    </div>
  );
}

function filterKey(filters: AgentInventoryFilters): string {
  return JSON.stringify(filters);
}

function upsertView(
  views: AgentInventoryView[],
  next: AgentInventoryView,
): AgentInventoryView[] {
  const existing = views.findIndex((view) => view.id === next.id);
  if (existing === -1) return [...views, next];
  return views.map((view) => (view.id === next.id ? next : view));
}
