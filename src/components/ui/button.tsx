import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

/**
 * Primary is ink (near-black), not blue — ui-plan.md reserves blue for focus
 * and links so the semantic palette stays free for data states. It also reads
 * considerably less like a tutorial than `bg-blue-500`.
 */
const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-primary text-primary-fg hover:bg-primary-hover border border-transparent",
  secondary:
    "bg-surface text-ink border border-border-strong hover:bg-surface-hover",
  ghost: "bg-transparent text-muted border border-transparent hover:bg-surface-hover hover:text-ink",
  danger:
    "bg-surface text-conflict-text border border-conflict-border/40 hover:bg-conflict-bg",
};

// 44px on mobile for touch, 36px from `sm` up where a pointer is likely.
const SIZES: Record<Size, string> = {
  sm: "h-9 px-3 text-xs",
  md: "h-11 sm:h-9 px-4 text-sm",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] font-medium",
        "transition-colors duration-150",
        "disabled:opacity-50 disabled:pointer-events-none",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("size-3.5 animate-spin", className)}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path
        d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
