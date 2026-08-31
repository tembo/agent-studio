"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { IconExclamationTriangle } from "central-icons";

import { Button } from "@/components/ui/button";

// The sidebar "Action needed" section. Owns its own visibility: the header only
// renders when there's ACTUALLY-visible content. That has to be client-side,
// because the missing-connection cards can be dismissed per-user (localStorage),
// and a server-side gate on the raw count would leave a lonely "Action needed"
// header over an empty section once the only items left are all dismissed.
//
// `staticContent` (the LLM-key / failing-agent cards) is server-rendered and
// passed in; `hasStaticContent` says whether it's non-empty.

export type MissingConnectionItem = {
  /** Stable identity = `${source}:${toolkit}:${name}` — also the dismiss key. */
  key: string;
  label: string;
  agentLabel: string;
  href: string;
  action: string;
};

const STORAGE_KEY = "tas-dismissed-connections";

function loadDismissed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function ActionNeeded({
  hasStaticContent,
  staticContent,
  missingItems,
}: {
  hasStaticContent: boolean;
  staticContent: ReactNode;
  missingItems: MissingConnectionItem[];
}) {
  // Hydrate dismissals after mount (localStorage is client-only). Until then we
  // withhold the dismissable cards so a dismissed one never flashes — they
  // appear on the next tick.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(loadDismissed());
    setReady(true);
  }, []);

  function dismiss(key: string) {
    setDismissed((prev) => {
      const next = new Set(prev).add(key);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // ignore (private mode / storage disabled)
      }
      return next;
    });
  }

  const visibleMissing = ready
    ? missingItems.filter((it) => !dismissed.has(it.key))
    : [];
  // The whole point: no visible content → no header.
  if (!hasStaticContent && visibleMissing.length === 0) return null;

  return (
    <div className="mt-6 flex flex-col gap-1.5">
      <span className="text-foreground-muted px-2 text-sm font-medium uppercase tracking-widest">
        Action needed
      </span>
      {staticContent}
      {visibleMissing.map((it) => (
        <div
          key={it.key}
          className="flex items-start gap-2 rounded-md bg-[var(--color-sentiment-caution-subtle)] px-2 py-2"
        >
          <IconExclamationTriangle
            size={14}
            className="mt-0.5 shrink-0 text-[var(--color-icon-sentiment-caution)]"
          />
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
            <span className="text-sm leading-tight text-[var(--color-foreground-sentiment-caution)]">
              <span className="font-semibold">{it.label}</span> for{" "}
              <span className="font-semibold">{it.agentLabel}</span>
            </span>
            <div className="flex items-center gap-3">
              <Button asChild variant="inverted" size="small">
                <Link href={it.href}>{it.action}</Link>
              </Button>
              <button
                type="button"
                onClick={() => dismiss(it.key)}
                className="text-foreground-muted hover:text-foreground-weak text-xs underline underline-offset-2"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
