"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MemberChoice } from "@/lib/member-choice";
import { searchMembersAction, type MemberSearchResult } from "./member-search-actions";

export function MemberPicker({ workspaceSlug, name, value, onChange, disabled = false }: {
  workspaceSlug: string;
  name: string;
  value: MemberChoice;
  onChange: (member: MemberChoice) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<MemberSearchResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function findMembers() {
    if (loading || disabled) return;
    setLoading(true);
    try {
      setResult(await searchMembersAction(workspaceSlug, search));
    } catch {
      setResult({ members: [], hasMore: false, error: "Could not load members. Try again." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-foreground-weak text-sm">Run as</label>
      <select
        id={id}
        name={name}
        value={value.id}
        disabled={disabled}
        onChange={(event) => {
          const member = result?.members.find((m) => m.id === event.target.value);
          if (member) onChange(member);
        }}
        className="bg-surface border-border text-foreground rounded-md border px-3 py-2 text-sm"
      >
        <option value={value.id}>{value.label}</option>
        {result?.members.filter((m) => m.id !== value.id).map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>
      <div className="flex gap-2">
        <Input
          aria-label="Search members by name or email"
          placeholder="Name or email"
          value={search}
          maxLength={200}
          disabled={disabled || loading}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void findMembers();
            }
          }}
        />
        <Button type="button" variant="secondary" disabled={disabled || loading} onClick={() => void findMembers()}>
          {loading ? "Searching…" : "Search"}
        </Button>
      </div>
      {result?.error ? <p role="alert" className="text-sentiment-negative text-sm">{result.error}</p> : result && (
        <p role="status" className="text-foreground-muted text-sm">
          {result.hasMore ? "More than 25 members match. Narrow your search by name or email." : `${result.members.length} members found.`}
        </p>
      )}
    </div>
  );
}
