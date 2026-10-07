"use client";

import { useState, useTransition } from "react";
import YAML from "yaml";
import { Button } from "@/components/ui/button";
import { EFFORT_LABELS, readModelEffort, effortLabel, setModelEffort } from "@/lib/model-effort";
import { chatSubmitAction } from "../chat/actions";

export function EffortPicker({
  source, format, workspaceSlug, agentName, canEdit,
}: {
  source: string;
  format: "yaml" | "json";
  workspaceSlug: string;
  agentName: string;
  canEdit: boolean;
}) {
  const spec = YAML.parse(source) as Record<string, unknown>;
  const current = readModelEffort(spec);
  const [effort, setEffort] = useState(current.effort);
  const [error, setError] = useState<string | null>(null);
  const [taskUrl, setTaskUrl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const editable = canEdit && current.support !== null && !current.custom;

  function save() {
    setError(null);
    startTransition(async () => {
      try {
        const content = setModelEffort(source, format, effort);
        const result = await chatSubmitAction({
          workspaceSlug, agentName,
          message: `Set agent effort to ${effort || "provider default"}`,
          fileEdit: { kind: "spec", content, originalContent: source },
          includeEvals: false,
        });
        if (!result.ok) setError(result.error);
        else setTaskUrl(result.htmlUrl);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't save the effort setting. Try again.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-foreground-weak text-sm">
        Current draft: <strong>{effortLabel(spec)}</strong>. Lower effort can reduce latency and token usage;
        higher effort can improve difficult tasks. Token prices stay the same.
      </p>
      {editable && !taskUrl && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>Effort level</span>
            <select
              className="border-border bg-background text-foreground rounded-md border px-3 py-2"
              value={effort}
              onChange={(event) => setEffort(event.target.value)}
              disabled={pending}
            >
              <option value="">Provider default ({EFFORT_LABELS[current.support!.default]})</option>
              {current.support!.levels.map((level) => (
                <option key={level} value={level}>{EFFORT_LABELS[level] ?? level}</option>
              ))}
            </select>
          </label>
          <Button onClick={save} disabled={pending || effort === current.effort}>
            {pending ? "Submitting…" : "Save effort as draft"}
          </Button>
        </div>
      )}
      {current.custom ? (
        <p className="text-foreground-weak text-sm">Custom thinking settings are configured. Use Edit as draft to update them.</p>
      ) : !current.support ? (
        <p className="text-foreground-weak text-sm">This model has no verified effort options.</p>
      ) : (
        <p className="text-foreground-weak text-sm">
          Saves through your workspace’s PR or direct-commit setting. Promote the updated draft separately
          to apply it to stable runs.
        </p>
      )}
      {taskUrl && (
        <p role="status" className="text-foreground-weak text-sm">
          Draft update submitted. <a href={taskUrl} target="_blank" rel="noreferrer" className="underline">View progress</a>.
          {" "}Reload after it lands to see the updated draft.
        </p>
      )}
      {error && <p role="alert" className="text-sentiment-negative text-sm">{error}</p>}
    </div>
  );
}
