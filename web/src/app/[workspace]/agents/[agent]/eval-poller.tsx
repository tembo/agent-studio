"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_START = 2000;
const POLL_MAX = 15000;
const POLL_GROWTH = 1.5;

export function EvalPoller({
  status,
}: {
  status: "queued" | "running" | "passed" | "failed" | "error";
}) {
  const router = useRouter();

  useEffect(() => {
    if (status !== "queued" && status !== "running") return;
    let delay = POLL_START;
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
