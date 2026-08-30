"use client";

// Copy-to-clipboard control in the top-right of the run output, so the
// user can lift the agent's reply into Slack / email / a doc without a
// select-all dance. Thin wrapper over the shared CopyButton.

import { CopyButton } from "@/components/copy-button";

export function CopyOutputButton({
  text,
  ariaLabel = "Copy output to clipboard",
}: {
  text: string;
  ariaLabel?: string;
}) {
  return <CopyButton text={text} ariaLabel={ariaLabel} />;
}
