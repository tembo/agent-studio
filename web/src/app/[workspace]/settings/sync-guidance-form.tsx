"use client";

import { useActionState, useState } from "react";

import { LocalTime } from "@/components/local-time";
import { useActionToast } from "@/lib/use-action-toast";

import { Button } from "@/components/ui/button";

import {
  setGuidanceRefreshCadenceAction,
  syncGuidanceAction,
  type GuidanceFormState,
} from "./guidance-actions";

const INITIAL: GuidanceFormState = {};

export function SyncGuidanceForm({
  workspaceSlug,
  cadence,
  refreshedAtIso,
}: {
  workspaceSlug: string;
  cadence: "off" | "daily" | "weekly";
  refreshedAtIso: string | null;
}) {
  const [selectedCadence, setSelectedCadence] = useState(cadence);
  const [syncState, syncAction, syncPending] = useActionState(
    syncGuidanceAction,
    INITIAL,
  );
  const [cadenceState, cadenceAction, cadencePending] = useActionState(
    setGuidanceRefreshCadenceAction,
    INITIAL,
  );
  useActionToast(syncState);
  useActionToast(cadenceState);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <form action={syncAction}>
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <Button type="submit" variant="secondary" disabled={syncPending}>
            {syncPending ? "Syncing…" : "Sync agent guidance"}
          </Button>
        </form>

        <form action={cadenceAction} className="flex items-end gap-2">
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <label className="text-foreground-weak flex flex-col gap-1 text-sm">
            <span>Automatic refresh</span>
            <select
              name="cadence"
              value={selectedCadence}
              onChange={(event) =>
                setSelectedCadence(
                  event.target.value as "off" | "daily" | "weekly",
                )
              }
              disabled={cadencePending}
              className="bg-input text-foreground h-8 min-w-28 rounded-lg px-3 text-sm font-medium shadow-[0_0_0_1px_var(--color-border)] focus:outline-none"
            >
              <option value="off">Off</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          <Button type="submit" disabled={cadencePending}>
            {cadencePending ? "Saving…" : "Save"}
          </Button>
        </form>
      </div>

      {refreshedAtIso && (
        <p className="text-foreground-muted text-xs">
          Last checked: <LocalTime iso={refreshedAtIso} style="relative" />
        </p>
      )}
      {syncState.message && (
        <p className="text-foreground-weak text-sm">{syncState.message}</p>
      )}
      {syncState.error && (
        <p className="text-sentiment-negative text-sm">{syncState.error}</p>
      )}
      {cadenceState.message && (
        <p className="text-foreground-weak text-sm">{cadenceState.message}</p>
      )}
      {cadenceState.error && (
        <p className="text-sentiment-negative text-sm">{cadenceState.error}</p>
      )}
    </div>
  );
}
