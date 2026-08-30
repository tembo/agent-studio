"use client";

import Link from "next/link";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import type { InventoryAgent } from "./agents-inventory";

type LiveInventoryAgent = Extract<InventoryAgent, { kind: "live" }>;

export function AgentInventoryNameCell({
  agent,
}: {
  agent: LiveInventoryAgent;
}) {
  const identity = (
    <>
      <Link
        href={agent.detailHref}
        className="text-foreground font-medium hover:underline"
      >
        {agent.displayName}
      </Link>
      {agent.displayName !== agent.name && (
        <div className="text-foreground-muted font-mono text-xs">
          {agent.filename}
        </div>
      )}
    </>
  );

  if (!agent.description) return identity;

  return (
    <div className="max-w-sm min-w-0">
      {identity}
      <TooltipProvider delayDuration={120} skipDelayDuration={400}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-foreground-weak mt-1 line-clamp-2 cursor-help text-left text-sm leading-5"
            >
              {agent.description}
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="start"
            className="max-h-64 max-w-md overflow-y-auto whitespace-pre-wrap break-words"
          >
            {agent.description}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export function inventoryAgentSearchText(agent: InventoryAgent): string {
  if (agent.kind === "invalid") return agent.filename;
  if (agent.kind === "pending-create") return agent.name;
  return [
    agent.displayName,
    agent.name,
    agent.filename,
    agent.description,
  ]
    .filter(Boolean)
    .join(" ");
}
