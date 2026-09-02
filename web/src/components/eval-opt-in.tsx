"use client";

export function EvalOptIn({
  checked,
  onCheckedChange,
  disabled,
  name = "include_evals",
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  name?: string;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="hidden" name={name} value={checked ? "on" : "off"} />
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheckedChange(e.target.checked)}
        disabled={disabled}
        className="mt-0.5 h-4 w-4"
      />
      <span>
        <span className="text-foreground font-medium">Add regression evals</span>
        <span className="text-foreground-weak mt-0.5 block">
          Writes a colocated <code className="text-foreground-muted">.eval.yaml</code>{" "}
          with assertion cases for the agent&apos;s main job. TAS runs them on
          authoring PRs and blocks Promote until assertions pass. Agents
          without an eval file (including existing ones) stay ungated.
          Recommended.
        </span>
      </span>
    </label>
  );
}
