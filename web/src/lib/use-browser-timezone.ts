"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const getSnapshot = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const getServerSnapshot = () => null;

// Wait for hydration: the server's timezone is not the creator's timezone.
export function useBrowserTimezone(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
