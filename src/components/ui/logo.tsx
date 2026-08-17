import { cn } from "@/lib/cn";

/**
 * The mark is a totals rule: three line items above one solid line — the
 * "true line" the product exists to check. Drawn inline rather than shipped as
 * an SVG file so it inherits `currentColor` and needs no extra request.
 *
 * Shared by the sign-in screen and the app header so the wordmark can never
 * drift between the two, which is the usual way a demo starts looking untended.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={cn("size-8 text-primary", className)}
      fill="none"
      aria-hidden="true"
    >
      <rect width="20" height="20" rx="5" fill="currentColor" />
      <g stroke="var(--color-primary-fg)" strokeLinecap="round">
        <path d="M5.5 6.5h9" strokeWidth="1.5" strokeOpacity="0.45" />
        <path d="M5.5 9.5h6.5" strokeWidth="1.5" strokeOpacity="0.45" />
        <path d="M5.5 12.5h4.5" strokeWidth="1.5" strokeOpacity="0.45" />
        <path d="M5.5 15.5h9" strokeWidth="2" />
      </g>
    </svg>
  );
}

/** Mark plus name. `sm` is the app header; the default is the sign-in screen. */
export function Wordmark({
  size = "md",
  className,
}: {
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark className={size === "sm" ? "size-5" : "size-8"} />
      <span
        className={cn(
          "font-semibold tracking-tight text-ink",
          size === "sm" ? "text-sm" : "text-lg",
        )}
      >
        Trueline
      </span>
    </span>
  );
}
