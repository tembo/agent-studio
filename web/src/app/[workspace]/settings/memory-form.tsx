"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { MemorySettings } from "@/lib/memory";
import { saveMemoryAction } from "./memory-actions";

export function MemoryForm({ slug, settings, editable }: { slug: string; settings: MemorySettings; editable: boolean }) {
  const [state, action, pending] = useActionState(saveMemoryAction, {});
  const options = new Map(settings.workspaces.map((workspace) => [workspace.id, workspace.name]));
  options.set(settings.default_workspace_id, "Dedicated Memory workspace (default)");
  if (!options.has(settings.memory_workspace_id)) options.set(settings.memory_workspace_id, settings.memory_workspace_id);
  return (
    <form action={action} className="flex max-w-xl flex-col gap-3">
      <input type="hidden" name="workspace" value={slug} />
      <p className="text-sm text-foreground-weak">
        {settings.configured ? "Memory server connected. Pydantic agents receive memory tools automatically." : "Set TAS_MEMORY_URL and TAS_MEMORY_ADMIN_TOKEN on the API service to enable Memory."}
      </p>
      {settings.warning && <p role="status" className="text-sm text-sentiment-negative">Memory needs attention: {settings.warning}</p>}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="enabled" defaultChecked={settings.enabled} disabled={!editable || pending || !settings.configured} />
        Enable Memory for this workspace
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Memory workspace
        <select name="memory_workspace_id" defaultValue={settings.memory_workspace_id} disabled={!editable || pending || !settings.configured} className="rounded border border-[var(--color-border-weak)] bg-background p-2">
          {[...options].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <p className="text-sm text-foreground-muted">Selecting an existing Memory workspace intentionally shares its internal knowledge with agents here. Only instance admins can change this setting.</p>
      <p className="text-sm">Reports: {settings.counts.pending ?? 0} queued · {settings.counts.delivered ?? 0} delivered · {settings.counts.blocked ?? 0} blocked</p>
      {editable && settings.blocked.map((report) => <p key={report.id} className="break-words text-xs text-foreground-muted">{report.id} → {report.memory_workspace_id}: {report.error}</p>)}
      {state.error && <p role="alert" className="text-sm text-sentiment-negative">{state.error}</p>}
      {state.message && <p role="status" className="text-sm text-sentiment-positive">{state.message}</p>}
      {editable && <div className="flex gap-2">
        <Button type="submit" name="operation" value="save" disabled={pending || !settings.configured}>Save Memory settings</Button>
        <Button type="submit" name="operation" value="retry" disabled={pending || !settings.configured || !settings.counts.blocked}>Retry blocked reports</Button>
      </div>}
    </form>
  );
}
