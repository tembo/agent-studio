"use client";

// Shown when the live draft differs from the current stable version. On
// demand (button) it fetches an LLM summary + a line diff of stable -> draft
// so the owner can see what a promotion would release.

import Link from "next/link";
import { useState, useTransition } from "react";

import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";

import { summarizeDraftAction, type DraftChangesResult } from "./actions";

type Props = {
  workspaceSlug: string;
  agentName: string;
  reviewHref: string;
  canPromote: boolean;
  stableVersionNumber: number | null;
  stableChangedAtIso: string | null;
  draftChangedAtIso: string | null;
  addedLines: number;
  removedLines: number;
};

export function DraftChangesBanner({
  workspaceSlug,
  agentName,
  reviewHref,
  canPromote,
  stableVersionNumber,
  stableChangedAtIso,
  draftChangedAtIso,
  addedLines,
  removedLines,
}: Props) {
  const [result, setResult] = useState<DraftChangesResult | null>(null);
  const [pending, startTransition] = useTransition();

  const load = () => {
    startTransition(async () => {
      setResult(await summarizeDraftAction({ workspaceSlug, agentName }));
    });
  };

  return (
    <div className="rounded-lg border border-[var(--color-sentiment-caution)] bg-[var(--color-sentiment-caution-subtle)] px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-foreground font-medium">
            {stableVersionNumber === null
              ? "This draft has not been promoted yet."
              : "The draft has changes not yet released to Stable."}
          </span>
          <span className="text-foreground-weak text-xs">
            +{addedLines} −{removedLines}
            {draftChangedAtIso && (
              <>
                {" "}
                · Draft changed{" "}
                <LocalTime iso={draftChangedAtIso} style="relative" />
              </>
            )}
            {stableVersionNumber !== null && stableChangedAtIso && (
              <>
                {" "}
                · Stable v{stableVersionNumber} promoted{" "}
                <LocalTime iso={stableChangedAtIso} style="relative" />
              </>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {result === null && (
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={pending}
              onClick={load}
            >
              {pending ? "Summarizing…" : "View diff"}
            </Button>
          )}
          <Button asChild variant="orange" size="small">
            <Link href={reviewHref}>
              {canPromote ? "Review & promote" : "Review draft"}
            </Link>
          </Button>
        </div>
      </div>

      {result && !result.ok && (
        <p className="text-sentiment-negative mt-2">{result.error}</p>
      )}

      {result && result.ok && (
        <div className="mt-3 flex flex-col gap-3">
          {result.invalid && (
            <p className="text-sentiment-negative">
              The draft file is currently invalid — fix it before promoting.
            </p>
          )}
          <div className="text-foreground whitespace-pre-wrap">
            {result.summary}
          </div>
          <details className="group">
            <summary className="text-foreground-weak hover:text-foreground cursor-pointer select-none underline underline-offset-2">
              Show diff (+{result.diff.stats.added} −{result.diff.stats.removed})
            </summary>
            <pre className="bg-surface border-border mt-2 overflow-x-auto rounded-lg border p-3 font-mono text-xs leading-5">
              {result.diff.lines.map((l, i) => (
                <div
                  key={i}
                  className={
                    l.type === "add"
                      ? "text-sentiment-positive"
                      : l.type === "remove"
                        ? "text-sentiment-negative"
                        : "text-foreground-muted"
                  }
                >
                  {l.type === "add" ? "+ " : l.type === "remove" ? "- " : "  "}
                  {l.text}
                </div>
              ))}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
