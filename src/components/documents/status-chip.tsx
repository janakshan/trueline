import type { DocumentStatus } from "@/lib/db/schema";
import { cn } from "@/lib/cn";

/**
 * One status→style mapping, used everywhere. ui-plan.md: colour means
 * something, so a chip's colour is never chosen per-screen.
 */
const STYLES: Record<DocumentStatus, { label: string; className: string; dot?: boolean }> = {
  queued: { label: "Queued", className: "bg-surface-hover text-muted" },
  processing: { label: "Extracting", className: "bg-surface-hover text-muted", dot: true },
  needs_review: { label: "Needs review", className: "bg-review-bg text-review-text" },
  approved: { label: "Approved", className: "bg-approved-bg text-approved-text" },
  failed: { label: "Failed", className: "bg-conflict-bg text-conflict-text" },
};

export function StatusChip({
  status,
  className,
}: {
  status: DocumentStatus;
  className?: string;
}) {
  const style = STYLES[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-medium whitespace-nowrap",
        style.className,
        className,
      )}
    >
      {style.dot && <span className="pulse-dot size-1.5 rounded-full bg-current" aria-hidden="true" />}
      {style.label}
    </span>
  );
}

/** Amber dot + count. Renders nothing at zero — silence is the signal. */
export function FlagCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-2xs font-medium text-review-text">
      <span className="size-1.5 rounded-full bg-review-border" aria-hidden="true" />
      {count}
    </span>
  );
}
