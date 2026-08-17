"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * Export dialog. Bottom sheet on mobile, centred modal from `sm` up.
 *
 * The row-shape choice shows a diagram of the resulting CSV rather than
 * describing it: "granularity" is jargon, and this is the setting users get
 * wrong. Three little rows are instantly legible.
 */

type Granularity = "document" | "line_item";

export function ExportDialog({
  selectedIds,
  totalCount,
  onClose,
}: {
  selectedIds: string[];
  totalCount: number;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"selected" | "all">(
    selectedIds.length > 0 ? "selected" : "all",
  );
  const [granularity, setGranularity] = useState<Granularity>("document");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const count = scope === "selected" ? selectedIds.length : totalCount;

  function download() {
    setPending(true);
    const params = new URLSearchParams({ scope, granularity });
    if (scope === "selected") params.set("ids", selectedIds.join(","));
    // A plain navigation: the browser handles the download and the
    // Content-Disposition header, so there is no blob to build or revoke.
    window.location.href = `/api/export?${params.toString()}`;
    setTimeout(() => {
      setPending(false);
      onClose();
    }, 800);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/25 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[480px] rounded-t-[var(--radius-modal)] bg-surface shadow-md sm:rounded-[var(--radius-modal)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 id="export-title" className="text-sm font-semibold">
            Export to CSV
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="space-y-5 px-5 py-4">
          <fieldset>
            <legend className="mb-2 text-2xs font-medium uppercase tracking-wider text-muted">
              Scope
            </legend>
            <div className="space-y-1.5">
              {(
                [
                  ["selected", `Selected (${selectedIds.length})`, selectedIds.length === 0],
                  ["all", `All documents (${totalCount})`, false],
                ] as const
              ).map(([value, label, disabled]) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] border px-3 py-2.5 text-sm",
                    scope === value ? "border-primary bg-surface-hover" : "border-border",
                    disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <input
                    type="radio"
                    name="scope"
                    checked={scope === value}
                    disabled={disabled}
                    onChange={() => setScope(value)}
                    className="accent-[var(--color-primary)]"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-2xs font-medium uppercase tracking-wider text-muted">
              Row shape
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["document", "One row per document", ["Acme  1,704.00  2 items", "Blue Ridge  13.24  2 items"]],
                  ["line_item", "One row per line item", ["Acme  Consulting  850.00", "Acme  Docs pack  390.00"]],
                ] as const
              ).map(([value, label, preview]) => (
                <label
                  key={value}
                  className={cn(
                    "cursor-pointer rounded-[var(--radius-control)] border p-3",
                    granularity === value ? "border-primary bg-surface-hover" : "border-border",
                  )}
                >
                  <div className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="granularity"
                      checked={granularity === value}
                      onChange={() => setGranularity(value)}
                      className="accent-[var(--color-primary)]"
                    />
                    {label}
                  </div>
                  <div className="mt-2 space-y-0.5" aria-hidden="true">
                    {preview.map((line) => (
                      <div
                        key={line}
                        className="truncate rounded bg-surface-sunken px-1.5 py-1 text-2xs text-subtle tabular-mono"
                      >
                        {line}
                      </div>
                    ))}
                  </div>
                </label>
              ))}
            </div>
          </fieldset>

          <p className="text-xs text-muted">
            Exporting <span className="font-medium text-ink tabular">{count}</span>{" "}
            document{count === 1 ? "" : "s"}
            {granularity === "line_item" && ", one row per line item"}.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={count === 0}
            onClick={download}
          >
            Download CSV
          </Button>
        </div>
      </div>
    </div>
  );
}
