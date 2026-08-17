"use client";

import { useId } from "react";
import { cn } from "@/lib/cn";

/**
 * A reviewable field.
 *
 * Three visual states, per ui-plan.md:
 *   verified  — no decoration at all. Silence is the signal.
 *   check     — amber left edge + dot + the reason, for low model confidence
 *               or a structural oddity.
 *   conflict  — red left edge + the reason, always visible, never a tooltip.
 *
 * No numeric confidence is ever rendered. Self-reported model confidence is
 * weakly calibrated, and showing "87%" implies a precision that does not exist
 * and invites over-trust.
 */

export type FieldState = "verified" | "check" | "conflict";

const EDGE: Record<FieldState, string> = {
  verified: "border-l-2 border-l-transparent",
  check: "border-l-2 border-l-review-border",
  conflict: "border-l-2 border-l-conflict-border",
};

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  state?: FieldState;
  reason?: string | undefined;
  edited?: boolean;
  type?: "text" | "number" | "date";
  placeholder?: string;
  align?: "left" | "right";
}

export function Field({
  label,
  value,
  onChange,
  onCommit,
  state = "verified",
  reason,
  edited = false,
  type = "text",
  placeholder,
  align = "left",
}: FieldProps) {
  const id = useId();

  return (
    <div className="min-w-0">
      <label
        htmlFor={id}
        className="mb-1 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-muted"
      >
        {label}
        {state === "check" && (
          <span className="size-1.5 rounded-full bg-review-border" aria-hidden="true" />
        )}
        {state === "conflict" && (
          <span className="size-1.5 rounded-full bg-conflict-border" aria-hidden="true" />
        )}
        {/* A human edit clears the model's flag and replaces it with this —
            continuing to show amber implies the app distrusts the reviewer. */}
        {edited && <span className="text-2xs font-normal normal-case text-subtle">· edited</span>}
      </label>

      <input
        id={id}
        type={type === "number" ? "text" : type}
        inputMode={type === "number" ? "decimal" : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        aria-invalid={state === "conflict" || undefined}
        aria-describedby={reason ? `${id}-reason` : undefined}
        className={cn(
          "h-11 w-full rounded-[var(--radius-control)] border border-border bg-surface px-2.5 text-base sm:h-9 sm:text-sm",
          "transition-colors placeholder:text-subtle",
          align === "right" && "text-right tabular-mono",
          EDGE[state],
          state === "check" && "bg-review-bg/40",
          state === "conflict" && "bg-conflict-bg/40",
        )}
      />

      {reason && (
        <p
          id={`${id}-reason`}
          className={cn(
            "mt-1 text-xs",
            state === "conflict" ? "text-conflict-text" : "text-review-text",
          )}
        >
          {reason}
        </p>
      )}
    </div>
  );
}
