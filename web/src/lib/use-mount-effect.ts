"use client";

import { type EffectCallback, useEffect } from "react";

/** Run an external-system subscription for this component's mount lifetime. */
export function useMountEffect(effect: EffectCallback): void {
  // The empty dependency list is the contract of this hook.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(effect, []);
}
