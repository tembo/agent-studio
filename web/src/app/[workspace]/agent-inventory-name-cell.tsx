"use client";

import Link from "next/link";

import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
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
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={agent.detailHref}
          className="text-foreground font-medium hover:underline"
        >
          {agent.displayName}
        </Link>
        {agent.pendingPromotion && (
          <Link
            href={agent.pendingPromotion.href}
            onClick={(event) => event.stopPropagation()}
            title="Review draft changes and promotion"
          >
            <Badge variant="yellow" size="small">
              Draft +{agent.pendingPromotion.addedLines} −
              {agent.pendingPromotion.removedLines}
            </Badge>
          </Link>
        )}
      </div>
      {agent.displayName !== agent.name && (
        <div className="text-foreground-muted font-mono text-xs">
          {agent.filename}
        </div>
      )}
      {agent.pendingPromotion && (
        <div className="text-foreground-muted mt-1 text-xs">
          Draft changed{" "}
          {agent.pendingPromotion.draftChangedAtIso ? (
            <LocalTime
              iso={agent.pendingPromotion.draftChangedAtIso}
              style="relative"
            />
          ) : (
            "recently"
          )}
          {agent.pendingPromotion.stableVersionNumber !== null &&
            agent.pendingPromotion.stableChangedAtIso && (
              <>
                {" "}
                · Stable v{agent.pendingPromotion.stableVersionNumber} promoted{" "}
                <LocalTime
                  iso={agent.pendingPromotion.stableChangedAtIso}
                  style="relative"
                />
              </>
            )}
          {agent.pendingPromotion.stableVersionNumber === null && (
            <> · No stable version yet</>
          )}
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
    agent.model,
    ...agent.labels,
    ...agent.mcps.flatMap((mcp) => [mcp.slug, mcp.label]),
    ...agent.subMcps.flatMap((mcp) => [mcp.slug, mcp.label]),
    agent.pendingPromotion ? "unpromoted draft needs promotion" : null,
  ]
    .filter(Boolean)
    .join(" ");
}
