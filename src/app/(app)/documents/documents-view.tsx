"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DocumentList } from "@/components/documents/document-list";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorPanel, Panel } from "@/components/ui/feedback";
import { ExportDialog } from "@/components/export/export-dialog";
import { UploadPanel } from "@/components/upload/upload-panel";
import { cn } from "@/lib/cn";
import type { DocumentStatus } from "@/lib/db/schema";
import type { DocumentSummary } from "@/lib/documents/serialize";
import type { StatusCounts } from "@/lib/documents/queries";

/**
 * State strategy — and why there is no state library.
 *
 * Server components own the data. Filtering lives in the URL, so it is
 * server-rendered, shareable, and survives a reload for free. That leaves
 * exactly two pieces of genuinely client-side state: which rows are selected,
 * and whether the upload panel is open. Both are owned by this one component
 * and read by its own children.
 *
 * Redux/Zustand/Jotai solve cross-tree state sharing. There is no cross-tree
 * sharing here, so they would add a dependency, a provider, and a second place
 * to look for the truth, in exchange for nothing.
 */

const FILTERS: Array<{ label: string; value: DocumentStatus | "all" }> = [
  { label: "All", value: "all" },
  { label: "Needs review", value: "needs_review" },
  { label: "Approved", value: "approved" },
  { label: "Failed", value: "failed" },
];

interface Props {
  items: DocumentSummary[];
  counts: StatusCounts;
  activeFilter: DocumentStatus | "all";
  nextCursor: string | null;
}

export function DocumentsView({ items, counts, activeFilter }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [uploadOpen, setUploadOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [loadingSamples, setLoadingSamples] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);

  const inFlight = counts.queued + counts.processing;

  // Poll only while something is actually moving, and stop the moment it
  // isn't. A permanent 2s interval against a free-tier database is a cost with
  // no matching benefit once the queue drains.
  useEffect(() => {
    if (inFlight === 0) return;
    const timer = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(timer);
  }, [inFlight, router]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === items.length ? new Set() : new Set(items.map((i) => i.id)),
    );
  }, [items]);

  // Selections must not survive into a filtered view that no longer shows them,
  // or the export dialog silently includes rows the user cannot see.
  const visibleSelected = useMemo(
    () => items.filter((i) => selected.has(i.id)).map((i) => i.id),
    [items, selected],
  );

  async function loadSamples() {
    setLoadingSamples(true);
    setSampleError(null);
    const response = await fetch("/api/documents/samples", { method: "POST" });
    if (!response.ok) {
      setSampleError("Could not load the sample documents. Please try again.");
      setLoadingSamples(false);
      return;
    }
    router.refresh();
    setLoadingSamples(false);
  }

  const isEmpty = items.length === 0;
  const isFilteredEmpty = isEmpty && activeFilter !== "all";
  const isTrulyEmpty = isEmpty && activeFilter === "all" && counts.all === 0;

  return (
    <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Documents</h1>
          <span className="text-sm text-subtle tabular">{counts.all}</span>
          {inFlight > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <span className="pulse-dot size-1.5 rounded-full bg-review-border" />
              {inFlight} processing
            </span>
          )}
        </div>
        <Button variant="primary" onClick={() => setUploadOpen(true)}>
          Upload
        </Button>
      </div>

      {/* Filter lives in the URL: shareable, server-rendered, reload-safe. */}
      <nav className="mt-5 flex flex-wrap gap-2" aria-label="Filter documents">
        {FILTERS.map((filter) => {
          const active = filter.value === activeFilter;
          const count = counts[filter.value];
          return (
            <Link
              key={filter.value}
              href={filter.value === "all" ? "/documents" : `/documents?status=${filter.value}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "border-primary bg-primary text-primary-fg"
                  : "border-border bg-surface text-muted hover:bg-surface-hover hover:text-ink",
              )}
            >
              {filter.label}
              <span className={cn("tabular", active ? "opacity-70" : "text-subtle")}>{count}</span>
            </Link>
          );
        })}
      </nav>

      {uploadOpen && (
        <div className="mt-5">
          <UploadPanel
            onClose={() => setUploadOpen(false)}
            onChanged={() => router.refresh()}
          />
        </div>
      )}

      {sampleError && (
        <div className="mt-5">
          <ErrorPanel
            title={sampleError}
            action={
              <Button size="sm" onClick={() => void loadSamples()}>
                Retry
              </Button>
            }
          />
        </div>
      )}

      <div className="mt-5">
        {isTrulyEmpty ? (
          <EmptyState
            icon={
              <svg className="size-8" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M14 3v4a1 1 0 0 0 1 1h4M5 3h9l6 6v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            }
            title="No documents yet"
            description="Upload an invoice or receipt and Claude will extract the vendor, dates, totals, and line items for you to review."
            actions={
              <>
                <Button variant="primary" onClick={() => setUploadOpen(true)}>
                  Upload invoices
                </Button>
                {/* Most people evaluating this demo will not have an invoice PDF
                    to hand. Without this, they see an empty box and leave. */}
                <Button loading={loadingSamples} onClick={() => void loadSamples()}>
                  Load sample documents
                </Button>
              </>
            }
          />
        ) : isFilteredEmpty ? (
          <EmptyState
            title="No documents match this filter"
            description="Nothing here right now. Clear the filter to see everything."
            actions={
              <Link href="/documents">
                <Button>Clear filter</Button>
              </Link>
            }
          />
        ) : (
          <Panel className="overflow-hidden">
            <DocumentList
              items={items}
              selected={selected}
              onToggle={toggle}
              onToggleAll={toggleAll}
            />
          </Panel>
        )}
      </div>

      {/* Bottom-anchored on mobile for thumb reach; inline on desktop. */}
      {visibleSelected.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface px-4 py-3 shadow-lg sm:static sm:mt-4 sm:rounded-[var(--radius-panel)] sm:border sm:shadow-none">
          <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3">
            <span className="text-sm font-medium">
              {visibleSelected.length} selected
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
              <Button size="sm" variant="primary" onClick={() => setExportOpen(true)}>
                Export
              </Button>
            </div>
          </div>
        </div>
      )}
      {exportOpen && (
        <ExportDialog
          selectedIds={visibleSelected}
          totalCount={counts.all}
          onClose={() => setExportOpen(false)}
        />
      )}
    </main>
  );
}
