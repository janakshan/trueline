"use client";

import { cn } from "@/lib/cn";
import { formatAmount } from "@/lib/format";

/**
 * The hero element of the product.
 *
 * It is the concrete answer to the only question every client asks — "how do I
 * know the AI got it right?" — and because it recomputes as the reviewer types,
 * the answer is demonstrated rather than claimed. Fixing the subtotal makes the
 * amber band turn green in front of them.
 *
 * Deliberately computed on the client from the values currently in the form,
 * not read from the server's stored issues: a strip that only updates after a
 * round trip is a badge, not a check.
 */

const TOLERANCE = 0.005;

export function ReconciliationStrip({
  lineTotalSum,
  subtotal,
  onJumpToLineItems,
}: {
  lineTotalSum: number;
  subtotal: number | null;
  onJumpToLineItems: () => void;
}) {
  const comparable = subtotal !== null;
  const difference = comparable ? Math.abs(lineTotalSum - subtotal) : 0;
  const balanced = comparable && difference <= TOLERANCE;

  if (!comparable) {
    return (
      <div className="rounded-[var(--radius-control)] border-l-2 border-l-border-strong bg-surface-sunken px-3 py-2 text-xs text-muted">
        No subtotal to reconcile against yet.
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-[var(--radius-control)] border-l-2 px-3 py-2",
        balanced
          ? "border-l-approved-border bg-approved-bg/50"
          : "border-l-review-border bg-review-bg",
      )}
      role="status"
      aria-live="polite"
    >
      {balanced ? (
        <p className="text-xs text-approved-text">Line items and totals reconcile.</p>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p className="text-sm text-review-text">
            Line items total{" "}
            <span className="font-medium tabular-mono">{formatAmount(lineTotalSum)}</span> but
            subtotal reads{" "}
            <span className="font-medium tabular-mono">{formatAmount(subtotal)}</span> —{" "}
            <span className="font-medium tabular-mono">{formatAmount(difference)}</span> difference
          </p>
          <button
            type="button"
            onClick={onJumpToLineItems}
            className="text-xs font-medium text-link underline underline-offset-2"
          >
            Jump to line items
          </button>
        </div>
      )}
    </div>
  );
}
