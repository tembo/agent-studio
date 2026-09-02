"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_CONCURRENT_RUNS_CAP } from "@/lib/run-queue";

import { updateRunQueueAction, type InstanceSettingsState } from "./actions";

export function RunQueueForm({
  initialMaxConcurrentRuns,
  initialMaxSubAgentsPerOrchestrator,
}: {
  initialMaxConcurrentRuns: number;
  initialMaxSubAgentsPerOrchestrator: number;
}) {
  const [state, action, pending] = useActionState<
    InstanceSettingsState,
    FormData
  >(updateRunQueueAction, { ok: false });
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(
    String(initialMaxConcurrentRuns),
  );
  const [maxSubAgents, setMaxSubAgents] = useState(
    String(initialMaxSubAgentsPerOrchestrator),
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="maxConcurrentRuns"
          className="text-foreground text-sm font-medium"
        >
          Concurrent agent runs
        </label>
        <Input
          id="maxConcurrentRuns"
          name="maxConcurrentRuns"
          type="number"
          min={1}
          max={MAX_CONCURRENT_RUNS_CAP}
          step={1}
          value={maxConcurrentRuns}
          onChange={(e) => setMaxConcurrentRuns(e.target.value)}
          disabled={pending}
        />
        <p className="text-foreground-weak text-sm">
          How many agents may execute at once. Extra runs stay queued. Each run
          owns a process, so keep this within the API service&apos;s memory.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="maxSubAgentsPerOrchestrator"
          className="text-foreground text-sm font-medium"
        >
          Concurrent sub-agents per orchestrator
        </label>
        <Input
          id="maxSubAgentsPerOrchestrator"
          name="maxSubAgentsPerOrchestrator"
          type="number"
          min={1}
          max={MAX_CONCURRENT_RUNS_CAP}
          step={1}
          value={maxSubAgents}
          onChange={(e) => setMaxSubAgents(e.target.value)}
          disabled={pending}
        />
        <p className="text-foreground-weak text-sm">
          How many children one orchestrator may run at the same time. Further
          sub-agents wait until one of that parent&apos;s slots frees. Queued
          sub-agents start before new orchestrator runs.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" size="medium" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {state.saved && !pending && (
          <span className="text-sentiment-positive text-sm">Saved.</span>
        )}
        {state.error && !pending && (
          <span className="text-sentiment-negative text-sm">{state.error}</span>
        )}
      </div>
    </form>
  );
}
