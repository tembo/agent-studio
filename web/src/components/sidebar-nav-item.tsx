"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type Props = {
  href: string;
  label: string;
  icon: ReactNode;
  /** When true, item is active for any sub-path of href (used for /{slug} home). */
  matchPrefix?: boolean;
  /** Optional count pill on the right (e.g. unresolved Inbox items). Hidden when 0/undefined. */
  count?: number;
};

export function SidebarNavItem({
  href,
  label,
  icon,
  matchPrefix,
  count,
}: Props) {
  const pathname = usePathname();
  const active = matchPrefix
    ? pathname === href || pathname.startsWith(`${href}/agents`)
    : pathname === href;

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-interactive-state-active text-foreground"
          : "text-foreground-weak hover:bg-interactive-state-hover hover:text-foreground",
      )}
    >
      <span className="flex h-4 w-4 items-center justify-center [&_svg]:h-4 [&_svg]:w-4">
        {icon}
      </span>
      <span>{label}</span>
      <span className="ml-auto flex items-center gap-1.5">
        {count !== undefined && count > 0 && (
          <span className="bg-category-neutral text-foreground-strong min-w-[1.25rem] rounded-full px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums">
            {count}
          </span>
        )}
        <PendingHint />
      </span>
    </Link>
  );
}

function PendingHint() {
  const { pending } = useLinkStatus();

  return (
    <span
      aria-hidden
      className={cn(
        "bg-foreground-muted size-1.5 shrink-0 rounded-full opacity-0",
        pending && "motion-safe:animate-pulse opacity-100",
      )}
    />
  );
}
