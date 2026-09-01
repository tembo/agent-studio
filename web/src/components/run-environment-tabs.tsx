import Link from "next/link";

import type { RunEnvironmentFilter } from "@/lib/run-environment";

const OPTIONS: { value: RunEnvironmentFilter; label: string }[] = [
  { value: "production", label: "Production" },
  { value: "development", label: "Development" },
  { value: "all", label: "All runs" },
];

export function RunEnvironmentTabs({
  active,
  baseHref,
}: {
  active: RunEnvironmentFilter;
  baseHref: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-foreground-weak text-sm font-medium uppercase tracking-widest">
        Analytics environment
      </span>
      <nav aria-label="Analytics environment" className="flex flex-wrap gap-2">
        {OPTIONS.map((option) => {
          const href =
            option.value === "production"
              ? baseHref
              : `${baseHref}?environment=${option.value}`;
          return (
            <Link
              key={option.value}
              href={href}
              aria-current={active === option.value ? "page" : undefined}
              className={
                active === option.value
                  ? "bg-interactive text-foreground-on-accent border-interactive rounded-md border px-3 py-1 text-sm font-medium"
                  : "text-foreground hover:bg-surface-raised border-border rounded-md border px-3 py-1 text-sm font-medium"
              }
            >
              {option.label}
            </Link>
          );
        })}
      </nav>
      <p className="text-foreground-muted text-sm">
        Draft runs are development. Promoted versions are production.
      </p>
    </div>
  );
}
