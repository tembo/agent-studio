"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

export type SourceTab = {
  id: string;
  label: string;
  content: ReactNode;
};

export function VersionsSourceTabs({ tabs }: { tabs: SourceTab[] }) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];

  return (
    <div className="flex flex-col gap-6">
      <div
        className="border-border bg-surface flex w-fit flex-wrap items-center gap-1 rounded-lg border p-1"
        role="tablist"
        aria-label="Version source"
      >
        {tabs.map((tab) => (
          <Button
            key={tab.id}
            type="button"
            size="medium"
            variant={tab.id === current?.id ? "secondary" : "ghost"}
            aria-selected={tab.id === current?.id}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </Button>
        ))}
      </div>
      {current?.content}
    </div>
  );
}
