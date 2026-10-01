"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Left rail for the Settings shell, sorted by how often an operator
// opens them (provider/integration keys lead, danger-zone-ish "deleted
// agents" trails). Active item highlights on prefix-match so a nested
// sub-route in the future doesn't need a separate special case.

type Item = { slug: string; label: string };

const ITEMS: Item[] = [
  { slug: "general", label: "General" },
  { slug: "members", label: "Members" },
  { slug: "repository", label: "Repository" },
  { slug: "providers", label: "LLM Providers" },
  { slug: "composio", label: "Composio" },
  { slug: "tembo", label: "Tembo Coding Agent" },
  { slug: "api-keys", label: "API keys" },
  { slug: "appearance", label: "Appearance" },
  { slug: "deleted-agents", label: "Deleted agents" },
  { slug: "version", label: "Version" },
  { slug: "danger", label: "Danger" },
];

export function SettingsNav({
  workspaceSlug,
  showAccount = false,
}: {
  workspaceSlug: string;
  /** Email/password instances get an "Account" (change password) page. */
  showAccount?: boolean;
}) {
  const pathname = usePathname();
  const base = `/${workspaceSlug}/settings`;
  const items = showAccount
    ? [
        ...ITEMS.slice(0, ITEMS.length - 3),
        { slug: "account", label: "Account" },
        ...ITEMS.slice(ITEMS.length - 3),
      ]
    : ITEMS;

  return (
    <nav
      aria-label="Settings sections"
      className="flex w-full shrink-0 flex-row gap-1 overflow-x-auto sm:w-52 sm:flex-col"
    >
      {items.map((item) => {
        const href = `${base}/${item.slug}`;
        // active when current path starts with this href, OR (for
        // the API-keys default) when the user is on bare /settings
        const isActive =
          pathname === href ||
          pathname.startsWith(`${href}/`) ||
          (pathname === base && item.slug === "general");
        return (
          <Link
            key={item.slug}
            href={href}
            className={
              isActive
                ? "bg-surface-secondary text-foreground rounded-md px-3 py-2 text-base font-medium"
                : "text-foreground-weak hover:bg-surface hover:text-foreground rounded-md px-3 py-2 text-base"
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
