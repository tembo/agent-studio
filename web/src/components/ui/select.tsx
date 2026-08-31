"use client";

// Tembo-style select dropdown built on Base UI's primitives. Native
// <select> elements look like browser defaults and clash with our
// other inputs; this wrapper gives a flat, lightly-shadowed trigger
// + animated popup that matches the rest of the input system.
//
// API mirrors a controlled component:
//
//   <Select value={value} onValueChange={setValue} options={...} />
//
// Options are { value, label }[]. Pass `placeholder` for the empty
// state. The first item is `value: ""` by convention when the
// caller wants a "no filter" sentinel.

import { Select as BaseSelect } from "@base-ui/react/select";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type SelectOption = {
  value: string;
  label: string;
};

type Props = {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  // Width of the trigger button. Defaults to fluid; pass an explicit
  // class to fix a minimum width on a filter row.
  className?: string;
  // Optional label rendered for screen readers via the SelectLabel
  // part. Visible labels stay outside.
  ariaLabel?: string;
  hideIcon?: boolean;
  hideIndicator?: boolean;
  popupClassName?: string;
  alignItemWithTrigger?: boolean;
};

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  ariaLabel,
  hideIcon = false,
  hideIndicator = false,
  popupClassName,
  alignItemWithTrigger = true,
}: Props) {
  const selected = options.find((o) => o.value === value);
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(next) => onValueChange(next ?? "")}
    >
      {ariaLabel ? <BaseSelect.Label className="sr-only">{ariaLabel}</BaseSelect.Label> : null}
      <BaseSelect.Trigger
        className={cn(
          "bg-input text-foreground-strong hover:bg-input-hover focus:bg-input-active focus-visible:shadow-focus-ring inline-flex h-8 items-center justify-between gap-2 rounded-lg px-3 text-sm font-medium shadow-[0_0_0_1px_var(--color-border)] transition-[background-color,box-shadow,color] duration-150",
          "data-[popup-open]:bg-input-active",
          className,
        )}
      >
        <BaseSelect.Value className="truncate">
          {selected ? selected.label : (placeholder ?? "Select…")}
        </BaseSelect.Value>
        {!hideIcon && (
          <BaseSelect.Icon className="text-foreground-weak">
            <Chevron />
          </BaseSelect.Icon>
        )}
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          side="bottom"
          sideOffset={4}
          align="start"
          alignItemWithTrigger={alignItemWithTrigger}
          className="z-50 outline-none"
        >
          <BaseSelect.Popup
            className={cn(
              "bg-surface-raised border-border min-w-[var(--anchor-width)] overflow-hidden rounded-lg border py-1 shadow-lg",
              "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
              "transition-opacity duration-100 ease-out",
              popupClassName,
            )}
          >
            {options.map((opt) => (
              <BaseSelect.Item
                key={opt.value}
                value={opt.value}
                className={cn(
                  "flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-sm outline-none",
                  "text-foreground hover:bg-interactive-state-hover",
                  "data-[highlighted]:bg-interactive-state-hover",
                  "data-[selected]:font-medium",
                )}
              >
                {!hideIndicator && (
                  <BaseSelect.ItemIndicator>
                    <Checkmark />
                  </BaseSelect.ItemIndicator>
                )}
                <BaseSelect.ItemText>{opt.label}</BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

export function MultiSelect({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  ariaLabel,
}: {
  value: string[];
  onValueChange: (value: string[]) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const selected = options.filter((option) => value.includes(option.value));
  const selectedLabel = selected.map((option) => option.label).join(", ");

  return (
    <BaseSelect.Root multiple value={value} onValueChange={onValueChange}>
      {ariaLabel ? (
        <BaseSelect.Label className="sr-only">{ariaLabel}</BaseSelect.Label>
      ) : null}
      <BaseSelect.Trigger
        className={cn(
          "bg-input text-foreground-strong hover:bg-input-hover focus:bg-input-active focus-visible:shadow-focus-ring inline-flex h-8 items-center justify-between gap-2 rounded-lg px-3 text-sm font-medium shadow-[0_0_0_1px_var(--color-border)] transition-[background-color,box-shadow,color] duration-150",
          "data-[popup-open]:bg-input-active",
          className,
        )}
      >
        <span className="truncate">{selectedLabel || placeholder || "Select…"}</span>
        <BaseSelect.Icon className="text-foreground-weak">
          <Chevron />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          side="bottom"
          sideOffset={4}
          align="start"
          alignItemWithTrigger={false}
          className="z-50 outline-none"
        >
          <BaseSelect.Popup
            className={cn(
              "bg-surface-raised border-border min-w-[max(var(--anchor-width),12rem)] overflow-hidden rounded-lg border py-1 shadow-lg",
              "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
              "transition-opacity duration-100 ease-out",
            )}
          >
            {options.map((option) => (
              <BaseSelect.Item
                key={option.value}
                value={option.value}
                className={cn(
                  "group text-foreground hover:bg-interactive-state-hover data-[highlighted]:bg-interactive-state-hover flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-sm outline-none",
                  "data-[selected]:bg-interactive-state-hover data-[selected]:font-medium",
                )}
              >
                <span className="border-border bg-surface group-data-[selected]:bg-interactive-accent group-data-[selected]:border-transparent flex size-4 shrink-0 items-center justify-center rounded border">
                  <BaseSelect.ItemIndicator>
                    <span className="text-white">
                      <Checkmark />
                    </span>
                  </BaseSelect.ItemIndicator>
                </span>
                <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

function Chevron(): ReactNode {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
    >
      <path
        d="M3 4.5L6 7.5L9 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Checkmark(): ReactNode {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
    >
      <path
        d="M2.5 6.5L4.75 8.75L9.5 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
