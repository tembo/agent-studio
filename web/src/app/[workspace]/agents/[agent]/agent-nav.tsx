"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Left rail for the agent view — mirrors settings-nav / connections-nav. One
// real route per tab. Drill-down pages (a run, a version) live under their
// tab's path, so the tab stays highlighted while you're inside them.

type Item = { slug: string; label: string };

const ITEMS: Item[] = [
  { slug: "", label: "Overview" },
  { slug: "runs", label: "Runs" },
  { slug: "outputs", label: "Outputs" },
  { slug: "automation", label: "Automation" },
  { slug: "versions", label: "Versions" },
  { slug: "activity", label: "Activity" },
  { slug: "learning", label: "Learning" },
  { slug: "settings", label: "Settings" },
];

// Tabs hidden when the agent is Locked — its change/learning history (#12).
const LOCKED_HIDDEN = new Set(["versions", "activity", "learning"]);

export function AgentNav({
  workspaceSlug,
  agentName,
  locked,
  pendingPromotion,
}: {
  workspaceSlug: string;
  agentName: string;
  locked: boolean;
  pendingPromotion: boolean;
}) {
  const pathname = usePathname();
  const base = `/${workspaceSlug}/agents/${encodeURIComponent(agentName)}`;
  const items = locked
    ? ITEMS.filter((i) => !LOCKED_HIDDEN.has(i.slug))
    : ITEMS;

  return (
    <nav
      aria-label="Agent sections"
      className="flex w-full shrink-0 flex-row gap-1 overflow-x-auto sm:w-36 sm:flex-col"
    >
      {items.map((item) => {
        const href = item.slug ? `${base}/${item.slug}` : base;
        const isActive = item.slug
          ? pathname === href || pathname.startsWith(`${href}/`)
          : pathname === base;
        return (
          <Link
            key={item.slug || "overview"}
            href={href}
            className={
              isActive
                ? "bg-surface-secondary text-foreground rounded-md px-3 py-2 text-base font-medium"
                : "text-foreground-weak hover:bg-surface hover:text-foreground rounded-md px-3 py-2 text-base"
            }
          >
            <span className="flex items-center justify-between gap-2">
              {item.label}
              {item.slug === "versions" && pendingPromotion && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-sentiment-caution)]"
                  title="Draft changes need promotion"
                  aria-label="Draft changes need promotion"
                />
              )}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
