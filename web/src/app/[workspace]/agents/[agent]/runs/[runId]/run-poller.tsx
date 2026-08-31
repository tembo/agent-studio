"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// The page is a server component that reads the latest run row on every
// render. This client component just triggers router.refresh() while the
// run is still in flight — small, scoped, and avoids a separate polling
// endpoint.
//
// Each refresh re-runs the WHOLE server page (run row + steps + sub-agent runs +
// the improvement-PR scan + GitHub fetches), so a fixed 1s tick is wasteful on
// long runs. Instead we back off: snappy at the start, then progressively
// slower up to a cap — a run that's been going for minutes doesn't need
// second-by-second refreshes. Resets when the status changes (e.g. queued →
// running re-runs the effect).
const POLL_START_RUNNING = 2000;
const POLL_START_QUEUED = 3000;
const POLL_MAX = 15000;
const POLL_GROWTH = 1.5;

export function RunPoller({ status }: { status: "queued" | "running" | "succeeded" | "failed" | "cancelled" }) {
  const router = useRouter();

  useEffect(() => {
    if (status !== "queued" && status !== "running") return;
    let delay = status === "running" ? POLL_START_RUNNING : POLL_START_QUEUED;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      router.refresh();
      delay = Math.min(Math.round(delay * POLL_GROWTH), POLL_MAX);
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    return () => clearTimeout(timer);
  }, [status, router]);

  return null;
}
