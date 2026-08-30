"use client";

type Props = {
  count: number;
  active: boolean;
  onChange: (active: boolean) => void;
};

/** Pending-promotion facet, kept separate from the broad inventory table. */
export function AgentInventoryPromotionFilter({
  count,
  active,
  onChange,
}: Props) {
  if (count === 0) return null;

  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onChange(!active)}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm transition-colors ${
        active
          ? "border-[var(--color-sentiment-caution)] bg-[var(--color-sentiment-caution-subtle)] text-[var(--color-foreground-sentiment-caution)]"
          : "border-border bg-surface text-foreground-weak hover:text-foreground"
      }`}
    >
      Needs promotion
      <span className="bg-surface-secondary rounded-full px-1.5 py-0.5 text-sm font-medium">
        {count}
      </span>
    </button>
  );
}
