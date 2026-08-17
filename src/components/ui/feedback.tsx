import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The three shared states from ui-plan.md, defined once so every screen behaves
 * identically. Inconsistent empty states are the clearest tell that a UI was
 * assembled screen by screen.
 */

export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-panel)] border border-border bg-surface",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Headline + one sentence + one primary action. Never a bare "No data". */
export function EmptyState({
  icon,
  title,
  description,
  actions,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius-panel)] border border-dashed border-border-strong bg-surface px-6 py-16 text-center">
      {icon && <div className="mb-4 text-subtle">{icon}</div>}
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <p className="mt-2 max-w-md text-sm text-muted">{description}</p>
      {actions && <div className="mt-6 flex flex-wrap items-center justify-center gap-3">{actions}</div>}
    </div>
  );
}

/**
 * Inline, never a full-page replacement — the chrome stays so the user keeps
 * their bearings. Says what failed, and offers the way out.
 */
export function ErrorPanel({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-conflict-border/30 bg-conflict-bg px-4 py-4">
      <div className="flex items-start gap-3">
        <svg className="mt-0.5 size-4 shrink-0 text-conflict-border" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 5.5v3.5M8 11.5h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M6.8 2.3 1.5 12a1.4 1.4 0 0 0 1.2 2.1h10.6a1.4 1.4 0 0 0 1.2-2.1L9.2 2.3a1.4 1.4 0 0 0-2.4 0Z" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-conflict-text">{title}</p>
          {description && <p className="mt-1 text-xs text-conflict-text/85">{description}</p>}
          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * Skeletons over spinners: they preserve layout and read as faster. They also
 * do real work here — architecture.md flags a Neon cold start of up to ~1s on
 * the first query after idle, which is exactly the click a client makes from a
 * portfolio link. A spinner makes that feel broken.
 */
export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return <div className={cn("skeleton rounded", className)} style={style} aria-hidden="true" />;
}
