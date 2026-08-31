// Vendored from tembo/monorepo packages/ui/src/components/badge.tsx
"use client";

import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import type { ComponentType, HTMLAttributes, ReactNode } from "react";
import { createElement } from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "flex w-fit items-center gap-0.5 rounded-md text-sm font-medium [&_svg]:pointer-events-none",
  {
    defaultVariants: { size: "default", variant: "gray" },
    variants: {
      size: {
        big: "h-7 px-3",
        default: "h-6 px-2.5",
        small: "h-5 px-2",
      },
      variant: {
        blue: "bg-category-blue text-foreground-category-blue [&_svg]:text-icon-category-blue",
        gray: "bg-category-neutral text-foreground-strong [&_svg]:text-icon-category-neutral",
        green:
          "bg-category-green text-foreground-category-green [&_svg]:text-icon-category-green",
        orange:
          "bg-category-orange text-foreground-category-orange [&_svg]:text-icon-category-orange",
        pink: "bg-category-pink text-foreground-category-pink [&_svg]:text-icon-category-pink",
        purple:
          "bg-category-purple text-foreground-category-purple [&_svg]:text-icon-category-purple",
        red: "bg-category-red text-foreground-sentiment-negative [&_svg]:text-icon-sentiment-negative",
        teal: "bg-category-teal text-foreground-category-teal [&_svg]:text-icon-category-teal",
        yellow:
          "bg-category-yellow text-foreground-category-yellow [&_svg]:text-icon-category-yellow",
      },
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  icon?: ReactNode | ComponentType;
  iconPosition?: "left" | "right";
}

function Badge({
  className,
  variant,
  size,
  icon,
  iconPosition = "left",
  children,
  ...props
}: BadgeProps) {
  const iconElement = typeof icon === "function" ? createElement(icon) : icon;

  return (
    <div
      className={cn(
        badgeVariants({ size, variant }),
        icon && iconPosition === "left" && "pl-0.5",
        icon && iconPosition === "right" && "pr-0.5",
        className,
      )}
      {...props}
    >
      {icon && iconPosition === "left" ? iconElement : null}
      {children}
      {icon && iconPosition === "right" ? iconElement : null}
    </div>
  );
}

export { Badge, badgeVariants };
