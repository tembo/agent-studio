"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { chatSubmitAction } from "../chat/actions";

export function InlineFileEditor({
  workspaceSlug, agentName, kind, source, originalContent, children,
}: {
  workspaceSlug: string;
  agentName: string;
  kind: "spec" | "eval";
  source: string;
  originalContent: string;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(source);
  const [error, setError] = useState<string | null>(null);
  const [taskUrl, setTaskUrl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await chatSubmitAction({
          workspaceSlug,
          agentName,
          message: `Inline ${kind} file edit from Versions`,
          fileEdit: { kind, content, originalContent },
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setTaskUrl(result.htmlUrl);
        setEditing(false);
      } catch {
        setError("Couldn't submit the edit. Your changes are still here; try again.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {taskUrl ? (
        <p role="status" className="text-foreground-weak text-sm">
          Draft update submitted. <a className="underline" href={taskUrl} target="_blank" rel="noreferrer noopener">View progress</a>.
          {" "}Reload after the change lands to see the updated draft. Stable promotion is separate.
        </p>
      ) : editing ? (
        <>
          <label className="flex flex-col gap-2 text-sm">
            <span>{kind === "spec" ? "Agent spec" : "Eval file"}</span>
            <textarea
              className="border-border bg-background text-foreground min-h-96 w-full rounded-md border p-3 font-mono text-sm"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
              disabled={pending}
              autoFocus
            />
          </label>
          <p className="text-foreground-weak text-sm">
            Saving submits a draft update through the same process as chat edits,
            using your workspace’s PR or direct-commit setting. It does not promote the agent.
          </p>
          <div className="flex gap-2">
            <Button onClick={save} disabled={pending || content === originalContent}>
              {pending ? "Submitting…" : "Save draft"}
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => {
              setContent(source);
              setError(null);
              setEditing(false);
            }}>Cancel</Button>
          </div>
        </>
      ) : (
        <Button className="self-start" variant="secondary" onClick={() => setEditing(true)}>
          Edit as draft
        </Button>
      )}
      {error && <p role="alert" className="text-sentiment-negative text-sm">{error}</p>}
      {!editing && children}
    </div>
  );
}
