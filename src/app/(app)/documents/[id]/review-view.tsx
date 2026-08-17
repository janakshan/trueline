"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Field, type FieldState } from "@/components/review/field";
import { PreviewPane } from "@/components/review/preview-pane";
import { ReconciliationStrip } from "@/components/review/reconciliation-strip";
import { StatusChip } from "@/components/documents/status-chip";
import { Button, Spinner } from "@/components/ui/button";
import { ErrorPanel, Panel } from "@/components/ui/feedback";
import { cn } from "@/lib/cn";
import type { LineItem } from "@/lib/db/schema";
import type { DocumentDetail } from "@/lib/documents/serialize";
import { formatAmount } from "@/lib/format";

/** Values live as strings so a half-typed "12." doesn't snap back to 12. */
type FormValues = Record<string, string>;

const TEXT_FIELDS = [
  ["vendor_name", "Vendor"],
  ["vendor_address", "Address"],
  ["vendor_tax_id", "Tax ID"],
  ["invoice_number", "Document number"],
] as const;

const AMOUNT_FIELDS = [
  ["subtotal", "Subtotal"],
  ["tax_amount", "Tax"],
  ["tax_rate", "Tax rate %"],
  ["shipping_amount", "Shipping"],
  ["service_charge", "Service"],
  ["discount_amount", "Discount"],
  ["total_amount", "Total"],
] as const;

const toText = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);

const toNumberOrNull = (value: string): number | null => {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

export function ReviewView({ initial }: { initial: DocumentDetail }) {
  const router = useRouter();
  const extraction = initial.extraction;

  const [values, setValues] = useState<FormValues>(() => {
    const data = extraction?.data;
    if (!data) return {};
    return Object.fromEntries(
      Object.entries(data)
        .filter(([key]) => key !== "line_items")
        .map(([key, value]) => [key, toText(value)]),
    );
  });
  const [lineItems, setLineItems] = useState<LineItem[]>(extraction?.data.line_items ?? []);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [tab, setTab] = useState<"document" | "fields">("fields");
  const [approving, setApproving] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lineItemsRef = useRef<HTMLDivElement>(null);

  const issues = extraction?.validationIssues ?? [];
  const reviewed = useMemo(
    () => new Set(extraction?.reviewedFields ?? []),
    [extraction?.reviewedFields],
  );

  const fieldState = useCallback(
    (field: string): { state: FieldState; reason?: string; edited: boolean } => {
      const edited = reviewed.has(field);
      // An edited field is the reviewer's now — the model's opinion about it is
      // no longer relevant, so no flag regardless of what it used to say.
      if (edited) return { state: "verified", edited: true };
      const issue = issues.find((i) => i.field === field);
      if (!issue) return { state: "verified", edited: false };
      // The reconciliation strip sits directly below the Amounts grid and
      // states these two in full. Repeating the same sentence on the field is
      // noise inside one viewport, so the field keeps only its red edge and
      // dot to mark which value is implicated.
      const coveredByStrip = field === "subtotal" || field === "total_amount";
      return {
        state: issue.severity,
        ...(coveredByStrip ? {} : { reason: issue.message }),
        edited: false,
      };
    },
    [issues, reviewed],
  );

  const save = useCallback(
    async (patch: { fields?: Record<string, unknown>; lineItems?: LineItem[] }) => {
      setSaveState("saving");
      try {
        const response = await fetch(`/api/documents/${initial.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) {
          setSaveState("error");
          return;
        }
        setSaveState("saved");
        // Pulls back the re-validated issues so the flags reflect the new values.
        router.refresh();
      } catch {
        setSaveState("error");
      }
    },
    [initial.id, router],
  );

  /** Builds the full field payload from current form values. */
  const buildFields = useCallback((next: FormValues) => {
    const payload: Record<string, unknown> = {};
    for (const [key] of TEXT_FIELDS) payload[key] = next[key]?.trim() || null;
    for (const [key] of AMOUNT_FIELDS) payload[key] = toNumberOrNull(next[key] ?? "");
    payload.issue_date = next.issue_date?.trim() || null;
    payload.due_date = next.due_date?.trim() || null;
    payload.currency = next.currency?.trim().toUpperCase() || null;
    payload.payment_method = next.payment_method?.trim() || null;
    return payload;
  }, []);

  // Debounced autosave while typing, plus an immediate commit on blur. A save
  // per keystroke would hammer a free-tier database; waiting only for blur
  // loses work if the tab closes mid-edit.
  const scheduleSave = useCallback(
    (next: FormValues) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save({ fields: buildFields(next) }), 800);
    },
    [buildFields, save],
  );

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const setField = (key: string, value: string) => {
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      scheduleSave(next);
      return next;
    });
  };

  const commit = () => {
    if (timer.current) clearTimeout(timer.current);
    void save({ fields: buildFields(values) });
  };

  const commitLineItems = (next: LineItem[]) => {
    setLineItems(next);
    void save({ lineItems: next });
  };

  const lineTotalSum = lineItems.reduce((sum, item) => sum + (item.line_total || 0), 0);
  const flagCount = issues.filter((i) => !reviewed.has(i.field)).length;

  async function approve() {
    setApproving(true);
    if (timer.current) clearTimeout(timer.current);
    await fetch(`/api/documents/${initial.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: buildFields(values),
        status: initial.status === "approved" ? "needs_review" : "approved",
      }),
    });
    setApproving(false);
    router.refresh();
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* ---------------- header ---------------- */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6">
        <Link href="/documents" className="text-muted hover:text-ink" aria-label="Back to documents">
          <svg className="size-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{initial.filename}</span>
        <StatusChip status={initial.status} />
        {flagCount > 0 && (
          <span className="hidden text-xs text-review-text sm:inline">
            {flagCount} to check
          </span>
        )}
        <SaveIndicator state={saveState} onRetry={commit} />
        <div className="hidden items-center gap-2 sm:flex">
          <Button
            variant="primary"
            size="sm"
            loading={approving}
            onClick={() => void approve()}
          >
            {initial.status === "approved" ? "Reopen" : "Approve"}
          </Button>
        </div>
      </div>

      {/* ------------- mobile pane switch -------------
          A 375px split pane is unusable, so below lg the two panes become one
          with a segmented control rather than being squeezed side by side. */}
      <div className="flex shrink-0 gap-1 border-b border-border bg-surface px-4 py-2 lg:hidden">
        {(["document", "fields"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn(
              "flex-1 rounded-[var(--radius-control)] px-3 py-2 text-xs font-medium capitalize transition-colors",
              tab === value ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface-hover",
            )}
          >
            {value}
            {value === "fields" && flagCount > 0 && (
              <span className="ml-1.5 rounded-full bg-review-border px-1.5 py-0.5 text-2xs text-white">
                {flagCount}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ---------------- preview ---------------- */}
        <div
          className={cn(
            "min-h-0 shrink-0 basis-full p-4 lg:basis-[44%]",
            tab === "document" ? "block" : "hidden lg:block",
          )}
        >
          <PreviewPane
            documentId={initial.id}
            mimeType={initial.mimeType}
            filename={initial.filename}
          />
        </div>

        {/* ---------------- fields ---------------- */}
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto p-4 pb-24 lg:pb-4",
            tab === "fields" ? "block" : "hidden lg:block",
          )}
        >
          {initial.status === "failed" ? (
            <ErrorPanel
              title="Extraction failed"
              description={initial.error?.message ?? "This document could not be processed."}
              action={<RetryButton documentId={initial.id} />}
            />
          ) : !extraction ? (
            <Panel className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <Spinner className="size-5 text-muted" />
              <div>
                <p className="text-sm font-medium">Extracting…</p>
                <p className="mt-1 text-xs text-muted">
                  Claude is reading this document. The fields will appear here when it finishes.
                </p>
              </div>
            </Panel>
          ) : (
            <div className="space-y-6">
              <section className="space-y-3">
                <h2 className="text-2xs font-semibold uppercase tracking-wider text-subtle">
                  Document
                </h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {TEXT_FIELDS.map(([key, label]) => {
                    const meta = fieldState(key);
                    return (
                      <Field
                        key={key}
                        label={label}
                        value={values[key] ?? ""}
                        onChange={(v) => setField(key, v)}
                        onCommit={commit}
                        state={meta.state}
                        reason={meta.reason}
                        edited={meta.edited}
                      />
                    );
                  })}
                  {(["issue_date", "due_date"] as const).map((key) => {
                    const meta = fieldState(key);
                    return (
                      <Field
                        key={key}
                        label={key === "issue_date" ? "Issue date" : "Due date"}
                        value={values[key] ?? ""}
                        onChange={(v) => setField(key, v)}
                        onCommit={commit}
                        state={meta.state}
                        reason={meta.reason}
                        edited={meta.edited}
                        placeholder="YYYY-MM-DD"
                      />
                    );
                  })}
                  <Field
                    label="Currency"
                    value={values.currency ?? ""}
                    onChange={(v) => setField("currency", v)}
                    onCommit={commit}
                    {...fieldState("currency")}
                    placeholder="GBP"
                  />
                  <Field
                    label="Payment method"
                    value={values.payment_method ?? ""}
                    onChange={(v) => setField("payment_method", v)}
                    onCommit={commit}
                    {...fieldState("payment_method")}
                  />
                </div>
              </section>

              <section className="space-y-3">
                <h2 className="text-2xs font-semibold uppercase tracking-wider text-subtle">
                  Amounts
                </h2>
                <div className="grid gap-3 sm:grid-cols-3">
                  {AMOUNT_FIELDS.map(([key, label]) => {
                    const meta = fieldState(key);
                    return (
                      <Field
                        key={key}
                        label={label}
                        value={values[key] ?? ""}
                        onChange={(v) => setField(key, v)}
                        onCommit={commit}
                        state={meta.state}
                        reason={meta.reason}
                        edited={meta.edited}
                        type="number"
                        align="right"
                      />
                    );
                  })}
                </div>
              </section>

              <ReconciliationStrip
                lineTotalSum={lineTotalSum}
                subtotal={toNumberOrNull(values.subtotal ?? "")}
                onJumpToLineItems={() =>
                  lineItemsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              />

              <section ref={lineItemsRef} className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-2xs font-semibold uppercase tracking-wider text-subtle">
                    Line items
                  </h2>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      commitLineItems([
                        ...lineItems,
                        {
                          line_number: lineItems.length + 1,
                          description: "",
                          quantity: 1,
                          unit_price: null,
                          line_total: 0,
                        },
                      ])
                    }
                  >
                    Add row
                  </Button>
                </div>
                <LineItemsEditor items={lineItems} onChange={commitLineItems} />
              </section>
            </div>
          )}
        </div>
      </div>

      {/* Sticky action bar on mobile — thumb reach. */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 border-t border-border bg-surface px-4 py-3 sm:hidden">
        <span className="text-xs text-muted">
          {flagCount > 0 ? `${flagCount} to check` : "Nothing flagged"}
        </span>
        <Button variant="primary" size="sm" loading={approving} onClick={() => void approve()}>
          {initial.status === "approved" ? "Reopen" : "Approve"}
        </Button>
      </div>
    </div>
  );
}

function SaveIndicator({
  state,
  onRetry,
}: {
  state: "idle" | "saving" | "saved" | "error";
  onRetry: () => void;
}) {
  if (state === "idle") return null;
  if (state === "saving") {
    return (
      <span className="flex items-center gap-1.5 text-2xs text-subtle">
        <Spinner /> Saving…
      </span>
    );
  }
  if (state === "saved") return <span className="text-2xs text-subtle">Saved</span>;
  return (
    <button
      type="button"
      onClick={onRetry}
      className="text-2xs font-medium text-conflict-text underline underline-offset-2"
    >
      Couldn&apos;t save — retry
    </button>
  );
}

function RetryButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="sm"
      loading={pending}
      onClick={async () => {
        setPending(true);
        await fetch(`/api/documents/${documentId}/extract`, { method: "POST" });
        setPending(false);
        router.refresh();
      }}
    >
      Retry extraction
    </Button>
  );
}

function LineItemsEditor({
  items,
  onChange,
}: {
  items: LineItem[];
  onChange: (next: LineItem[]) => void;
}) {
  const update = (index: number, patch: Partial<LineItem>) => {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  if (items.length === 0) {
    return (
      <p className="rounded-[var(--radius-control)] border border-dashed border-border-strong px-3 py-6 text-center text-xs text-subtle">
        No line items were found on this document.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div
          key={index}
          className="grid grid-cols-2 gap-2 rounded-[var(--radius-control)] border border-border bg-surface p-2 sm:grid-cols-[1fr_5rem_7rem_7rem_2rem] sm:items-center"
        >
          <input
            value={item.description}
            onChange={(e) => update(index, { description: e.target.value })}
            placeholder="Description"
            className="col-span-2 h-10 rounded-[var(--radius-control)] border border-border px-2 text-base sm:col-span-1 sm:h-8 sm:text-sm"
          />
          <input
            value={String(item.quantity)}
            onChange={(e) => update(index, { quantity: Number(e.target.value) || 0 })}
            inputMode="decimal"
            className="h-10 rounded-[var(--radius-control)] border border-border px-2 text-right text-base tabular-mono sm:h-8 sm:text-sm"
          />
          <input
            value={item.unit_price === null ? "" : String(item.unit_price)}
            onChange={(e) =>
              update(index, {
                unit_price: e.target.value.trim() === "" ? null : Number(e.target.value) || 0,
              })
            }
            inputMode="decimal"
            placeholder="Unit"
            className="h-10 rounded-[var(--radius-control)] border border-border px-2 text-right text-base tabular-mono sm:h-8 sm:text-sm"
          />
          <input
            value={String(item.line_total)}
            onChange={(e) => update(index, { line_total: Number(e.target.value) || 0 })}
            inputMode="decimal"
            className="h-10 rounded-[var(--radius-control)] border border-border px-2 text-right text-base font-medium tabular-mono sm:h-8 sm:text-sm"
          />
          <button
            type="button"
            onClick={() => onChange(items.filter((_, i) => i !== index))}
            aria-label={`Delete line ${index + 1}`}
            className="col-span-2 h-10 rounded-[var(--radius-control)] text-xs text-muted hover:bg-conflict-bg hover:text-conflict-text sm:col-span-1 sm:h-8"
          >
            ✕
          </button>
        </div>
      ))}
      <p className="pr-2 text-right text-xs text-muted">
        Sum <span className="font-medium tabular-mono">{formatAmount(items.reduce((s, i) => s + (i.line_total || 0), 0))}</span>
      </p>
    </div>
  );
}
