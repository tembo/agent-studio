"use client";

// "Improve the Agent" form on the run detail page. The user
// describes what should change in the agent; on submit we ask the
// Tembo Coding Agent Platform to open a session that produces a PR —
// or, in YOLO mode, commits straight to the default branch.
//
// Mode is a workspace-level setting (Settings → Tembo Coding Agent →
// Improvements delivery); we surface it in the copy + button label.

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { EvalOptIn } from "@/components/eval-opt-in";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import type { CommitMode } from "@/lib/commit-mode-constants";
import { type Improvement } from "@/lib/improvements-api";

import { improveAgentAction, type ImproveResult } from "./actions";
import { ImprovementHistory } from "./improvement-history";

// Delay before the Improve section fades in once the run has
// settled. Gives the user a beat to read the output before the
// improvement affordance grabs attention.
const REVEAL_DELAY_MS = 2000;

export function ImproveForm({
  workspaceSlug,
  runId,
  improvements,
  commitMode,
}: {
  workspaceSlug: string;
  runId: string;
  improvements: Improvement[];
  commitMode: CommitMode;
}) {
  const direct = commitMode === "direct";
  const router = useRouter();
  const [improvement, setImprovement] = useState("");
  const [result, setResult] = useState<ImproveResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [revealed, setRevealed] = useState(false);
  const [includeEvals, setIncludeEvals] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setRevealed(true), REVEAL_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setResult(null);
    startTransition(async () => {
      let r: ImproveResult;
      try {
        r = await improveAgentAction({
          workspaceSlug,
          runId,
          improvement,
          includeEvals,
        });
      } catch {
        // A thrown server action — most commonly "Failed to find Server
        // Action" when this page was loaded from an older deployment.
        // Surface it instead of failing silently so the user knows to
        // refresh rather than thinking the button is broken.
        setResult({
          ok: false,
          error:
            "Couldn't submit — this page may be out of date (a new version shipped). Refresh the page and try again.",
        });
        return;
      }
      setResult(r);
      if (r.ok) {
        setImprovement("");
        // Re-run the server component so the new improvement row
        // shows up in the inline history without a hard reload.
        router.refresh();
      }
    });
  };

  return (
    <div
      className={`transition-opacity duration-700 ease-out ${revealed ? "opacity-100" : "opacity-0"}`}
    >
    <Section title="Improve the Agent">
      <ImprovementHistory improvements={improvements} />
      <form
        onSubmit={handleSubmit}
        className={`flex flex-col gap-3 ${improvements.length > 0 ? "mt-4" : ""}`}
      >
        <p className="text-foreground-weak text-base">
          Describe what should change about this agent.{" "}
          {direct
            ? "It will be committed directly to your default branch (YOLO mode)."
            : "It will be submitted as a pull request for approval."}
        </p>

        <textarea
          value={improvement}
          onChange={(e) => setImprovement(e.target.value)}
          placeholder="The response was too long. Tighten the system prompt so answers stay under 3 sentences."
          rows={5}
          disabled={pending}
          className="bg-surface border-border text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-color,#009eff)] rounded-md border px-3 py-2 text-sm leading-6 resize-y"
        />

        <EvalOptIn
          checked={includeEvals}
          onCheckedChange={setIncludeEvals}
          disabled={pending}
        />

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending || !improvement.trim()}>
            {pending ? "Asking Tembo…" : direct ? "Commit directly" : "Open a PR"}
          </Button>
          {pending && (
            <span className="text-foreground-weak text-sm">
              Creating a Tembo session — this may take a moment.
            </span>
          )}
        </div>

        {result && <ResultBanner result={result} />}
      </form>
    </Section>
    </div>
  );
}

function ResultBanner({ result }: { result: ImproveResult }) {
  if (result.ok) {
    return (
      <div className="border-sentiment-positive bg-[var(--color-sentiment-positive-subtle)] flex flex-col gap-1 rounded-lg border p-3 text-sm">
        <span className="text-foreground font-medium">
          Tembo Session created
        </span>
        <span className="text-foreground-weak text-sm">
          Status: {result.status}
        </span>
        <a
          href={result.htmlUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-foreground text-sm font-medium hover:underline"
        >
          View Session →
        </a>
      </div>
    );
  }

  return (
    <div className="border-sentiment-negative bg-[var(--color-input-error)] flex flex-col gap-1 rounded-lg border p-3 text-sm">
      <span className="text-sentiment-negative font-medium">
        Couldn&apos;t create the task
      </span>
      <span className="text-foreground whitespace-pre-wrap text-sm leading-5">
        {result.error}
      </span>
    </div>
  );
}
