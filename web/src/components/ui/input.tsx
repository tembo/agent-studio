// Vendored from tembo/monorepo packages/ui/src/components/input.tsx
// InputError + its IconCrossSmall dep are omitted; add back when we vendor icons.
"use client";

import type { ComponentProps } from "react";
import { forwardRef } from "react";

import { cn } from "@/lib/utils";

interface InputProps extends ComponentProps<"input"> {
  error?: boolean;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, error, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        "bg-input text-foreground-strong placeholder:text-foreground-weak hover:bg-input-hover hover:placeholder:text-foreground focus:bg-input-active focus:placeholder:text-foreground-weak focus-visible:shadow-focus-ring disabled:bg-input-disabled disabled:text-foreground-muted disabled:placeholder:text-foreground-muted flex h-8 w-full min-w-0 rounded-lg shadow-[0_0_0_1px_var(--color-border)] py-1 px-3 text-sm font-medium tracking-[-0.1px] file:border-0 file:bg-transparent file:text-sm file:font-medium focus:outline-none transition-[background-color,box-shadow,color] duration-150 disabled:cursor-not-allowed",
        error &&
          "border-sentiment-negative bg-input-error text-foreground-sentiment-negative",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);

Input.displayName = "Input";

export { Input };
export type { InputProps };
