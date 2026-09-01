"use client";

import { useActionState, useState } from "react";
import { useActionToast } from "@/lib/use-action-toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  FRAMEWORKS,
  FRAMEWORK_LABELS,
  type Framework,
} from "@/lib/agent-framework";
import type { CommitMode } from "@/lib/commit-mode-constants";
import { suggestSlug } from "@/lib/slugify";

import {
  createFromChatAction,
  createSuggestedAutomationAction,
  type ChatCreateFormState,
  type SuggestedAutomationFormState,
} from "./actions";

const DEFAULT_FRAMEWORK: Framework = "pydantic-agentspec";
const CHAT_INITIAL: ChatCreateFormState = {};
const AUTOMATION_INITIAL: SuggestedAutomationFormState = {};

export function NewAgentForm({
  workspaceSlug,
  commitMode,
  defaults,
}: {
  workspaceSlug: string;
  commitMode: CommitMode;
  /** Prefill from an Agent Library starter (?starter=<id>). */
  defaults?: { name?: string; description?: string };
}) {
  const direct = commitMode === "direct";
  const [state, action, pending] = useActionState(
    createFromChatAction,
    CHAT_INITIAL,
  );
  useActionToast(state);
  // Cargo AI is an advanced option for porting existing assets; most
  // new agents go through Pydantic. Hide the framework picker behind
  // a small "Advanced" disclosure so the common case is name +
  // description and nothing else.
  const [advanced, setAdvanced] = useState(false);
  // Controlled inputs — React 19's useActionState resets uncontrolled
  // form fields after each submission completes, including the
  // returned-error path. Holding the values in state preserves the
  // user's input when the action returns an error and the form
  // re-renders.
  const [name, setName] = useState(defaults?.name ?? "");
  const [description, setDescription] = useState(defaults?.description ?? "");
  const [framework, setFramework] = useState<Framework>(DEFAULT_FRAMEWORK);
  // The name is free text; the filename + spec `name:` slug are derived from it.
  const nameSlug = suggestSlug(name.trim());

  if (state.success) {
    const s = state.success;
    return (
      <div className="border-sentiment-positive bg-[var(--color-sentiment-positive-subtle)] flex flex-col gap-2 rounded-lg border p-4 text-sm">
        <span className="text-foreground font-semibold">
          {direct ? "Building" : "PR requested for"} {s.agentName}
        </span>
        <p className="text-foreground-weak">
          {direct ? (
            <>
              Tembo is committing the new agent directly to your default branch
              at{" "}
              <code className="bg-surface rounded px-1 py-0.5">
                {s.agentPath}
              </code>
              . You can watch the Tembo session; it&apos;ll show on the
              Improvements page and appear in your agents once the commit lands.
            </>
          ) : (
            <>
              Tembo is opening a pull request at{" "}
              <code className="bg-surface rounded px-1 py-0.5">
                {s.agentPath}
              </code>
              . You can watch the Tembo session, and the PR status will appear
              on the Improvements page once it&apos;s open.
            </>
          )}
        </p>
        <p className="text-foreground-weak text-sm">Status: {s.status}</p>
        {s.suggestedSchedule && (
          <div className="text-foreground-weak flex flex-col gap-1 text-sm">
            <p>
              Suggested schedule:{" "}
              <span className="text-foreground font-medium">
                {s.suggestedSchedule.humanReadable.toLowerCase()}
              </span>{" "}
              (UTC).
            </p>
            <p>
              No automation was created automatically. After the agent appears,
              test and verify it. When you&apos;re ready, create and enable the
              suggested automation.
            </p>
            <SuggestedAutomationForm
              workspaceSlug={workspaceSlug}
              improvementId={s.improvementId}
            />
          </div>
        )}
        <div className="flex flex-wrap gap-3 pt-1">
          <a
            href={s.htmlUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-foreground text-sm font-medium hover:underline"
          >
            View Tembo session ↗
          </a>
          <a
            href={`/${workspaceSlug}/improvements`}
            className="text-foreground-weak hover:text-foreground text-sm"
          >
            Open Improvements →
          </a>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      {/* Hidden framework field carries the controlled framework state
          when the picker is collapsed. When the picker is open the
          <select> below owns the field. */}
      {!advanced && (
        <input type="hidden" name="framework" value={framework} />
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="chat-name" className="text-sm">
          Agent name
        </Label>
        <Input
          id="chat-name"
          name="name"
          type="text"
          autoComplete="off"
          required
          maxLength={120}
          disabled={pending}
          placeholder="Inbox Triage"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="text-foreground-muted text-sm">
          Use any name you like.{" "}
          {name.trim() && nameSlug ? (
            <>
              Saved as{" "}
              <code className="bg-surface rounded px-1 py-0.5">
                {nameSlug}.{name.trim() && framework === "cargo-ai" ? "json" : "yaml"}
              </code>
              .
            </>
          ) : name.trim() ? (
            <span className="text-sentiment-negative">
              Add some letters or numbers for the filename.
            </span>
          ) : (
            "It's slugified for the filename."
          )}
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="chat-description" className="text-sm">
          What should the agent do?
        </Label>
        <textarea
          id="chat-description"
          name="description"
          required
          rows={8}
          disabled={pending}
          placeholder="Read incoming customer emails. Classify each one as billing, technical, or sales. Reply to billing emails with a link to the help center. Forward technical issues to the support inbox."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="bg-input text-foreground-strong placeholder:text-foreground-weak hover:bg-input-hover focus:bg-input-active focus-visible:shadow-focus-ring disabled:bg-input-disabled disabled:text-foreground-muted flex w-full min-w-0 rounded-lg shadow-[0_0_0_1px_var(--color-border)] py-2 px-3 text-sm leading-6 focus:outline-none transition-[background-color,box-shadow,color] duration-150 disabled:cursor-not-allowed resize-y"
        />
        <p className="text-foreground-muted text-sm">
          Tembo will read this, write a new agent file in the canonical
          framework shape, and open a pull request for your team to review.
        </p>
      </div>

      {advanced ? (
        <div className="grid gap-1.5">
          <Label htmlFor="chat-framework" className="text-sm">
            Framework
          </Label>
          <select
            id="chat-framework"
            name="framework"
            value={framework}
            onChange={(e) => setFramework(e.target.value as Framework)}
            disabled={pending}
            className="bg-input text-foreground-strong hover:bg-input-hover focus:bg-input-active focus-visible:shadow-focus-ring disabled:bg-input-disabled flex h-7 w-full min-w-0 rounded-lg shadow-[0_0_0_1px_var(--color-border)] py-1 pr-1 pl-2 text-sm font-medium tracking-[-0.1px] focus:outline-none transition-[background-color,box-shadow,color] duration-150"
          >
            {FRAMEWORKS.map((f) => (
              <option key={f} value={f}>
                {FRAMEWORK_LABELS[f]}
              </option>
            ))}
          </select>
          <p className="text-foreground-muted text-sm">
            Default is Pydantic AgentSpec. Pick Cargo AI only when porting
            existing Cargo AI assets.
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdvanced(true)}
          className="text-foreground-weak hover:text-foreground w-fit text-sm underline-offset-2 hover:underline"
        >
          Advanced: change framework
        </button>
      )}

      {state.error && (
        <p className="text-sentiment-negative text-sm" role="alert">
          {state.error}
        </p>
      )}

      <Button
        type="submit"
        variant="primary"
        disabled={pending}
        className="mt-1 w-fit"
      >
        {pending ? "Asking Tembo…" : "Create"}
      </Button>
    </form>
  );
}

function SuggestedAutomationForm({
  workspaceSlug,
  improvementId,
}: {
  workspaceSlug: string;
  improvementId: string;
}) {
  const [state, action, pending] = useActionState(
    createSuggestedAutomationAction,
    AUTOMATION_INITIAL,
  );

  if (state.automation) {
    return (
      <p className="text-foreground pt-1" aria-live="polite">
        {state.automation.alreadyExisted
          ? "A matching automation already exists."
          : "Automation created and enabled."}{" "}
        <a
          href={`/${workspaceSlug}/automations/${encodeURIComponent(state.automation.id)}`}
          className="font-medium hover:underline"
        >
          Review automation →
        </a>
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col items-start gap-1.5 pt-1">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="improvement_id" value={improvementId} />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Creating automation…" : "Create suggested automation"}
      </Button>
      {state.error && (
        <p className="text-sentiment-negative text-sm" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
