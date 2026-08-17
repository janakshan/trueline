"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { Button, Spinner } from "@/components/ui/button";
import { Panel } from "@/components/ui/feedback";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { resizeImageIfNeeded } from "./resize-image";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 20;
const ACCEPTED = ["application/pdf", "image/png", "image/jpeg"];
/** Two at a time: enough to feel parallel, gentle on a free-tier database. */
const CONCURRENCY = 2;

type ItemStatus = "pending" | "uploading" | "extracting" | "done" | "error";

interface QueueItem {
  key: string;
  file: File;
  status: ItemStatus;
  progress: number;
  documentId?: string;
  error?: string;
  /** Permanent failures get no retry button — a button that always fails is
   *  worse than no button. */
  retryable?: boolean;
}

/** Rejects locally so the user hears about it instantly, and per file — one
 *  oversized file must never fail the other nineteen. */
function rejectReason(file: File): string | null {
  if (file.size === 0) return "File is empty";
  if (file.size > MAX_BYTES) {
    return `Too large — ${formatBytes(file.size)}, limit is 10 MB`;
  }
  if (!ACCEPTED.includes(file.type) && !/\.(pdf|png|jpe?g)$/i.test(file.name)) {
    return "Unsupported type — PDF, PNG, or JPEG only";
  }
  return null;
}

function uploadWithProgress(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<{ ok: true; id: string } | { ok: false; message: string; retryable: boolean }> {
  // XHR rather than fetch: fetch gives no upload-progress events, and a
  // progress bar that jumps 0→100 is worse than none.
  return new Promise((resolve) => {
    const body = new FormData();
    body.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/documents");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener("load", () => {
      try {
        const body = JSON.parse(xhr.responseText) as {
          data?: { id: string };
          error?: { message: string };
        };
        if (xhr.status === 201 && body.data) {
          resolve({ ok: true, id: body.data.id });
        } else {
          resolve({
            ok: false,
            message: body.error?.message ?? `Upload failed (${xhr.status})`,
            // 4xx is the file's fault and will fail again; 5xx may not.
            retryable: xhr.status >= 500 || xhr.status === 0,
          });
        }
      } catch {
        resolve({ ok: false, message: "Unexpected response from the server", retryable: true });
      }
    });
    xhr.addEventListener("error", () =>
      resolve({ ok: false, message: "Network error during upload", retryable: true }),
    );
    xhr.send(body);
  });
}

export function UploadPanel({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const update = useCallback((key: string, patch: Partial<QueueItem>) => {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }, []);

  const processOne = useCallback(
    async (item: QueueItem) => {
      update(item.key, { status: "uploading", progress: 0, error: undefined });

      const prepared = await resizeImageIfNeeded(item.file);
      const result = await uploadWithProgress(prepared, (fraction) =>
        update(item.key, { progress: fraction }),
      );

      if (!result.ok) {
        update(item.key, { status: "error", error: result.message, retryable: result.retryable });
        return;
      }

      update(item.key, { status: "extracting", progress: 1, documentId: result.id });
      onChanged();

      // The browser drives the queue — architecture.md: there is no job runner
      // on the free tier, so the tab is the orchestrator and Postgres holds
      // the state.
      const response = await fetch(`/api/documents/${result.id}/extract`, { method: "POST" });
      if (!response.ok) {
        update(item.key, {
          status: "error",
          error: "Extraction could not be started",
          retryable: true,
        });
        onChanged();
        return;
      }

      const body = (await response.json()) as { data: { status: string; error?: { message: string } | null } };
      if (body.data.status === "failed") {
        update(item.key, {
          status: "error",
          error: body.data.error?.message ?? "Extraction failed",
          retryable: true,
        });
      } else {
        update(item.key, { status: "done" });
      }
      onChanged();
    },
    [onChanged, update],
  );

  const runQueue = useCallback(
    async (queue: QueueItem[]) => {
      setRunning(true);
      const pending = [...queue];
      const workers = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
        for (let next = pending.shift(); next; next = pending.shift()) {
          await processOne(next);
        }
      });
      await Promise.all(workers);
      setRunning(false);
      onChanged();
    },
    [onChanged, processOne],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const incoming = Array.from(files).slice(0, MAX_FILES);
      const accepted: QueueItem[] = [];
      const rejected: QueueItem[] = [];

      for (const file of incoming) {
        const reason = rejectReason(file);
        const base = { key: `${file.name}-${file.size}-${crypto.randomUUID()}`, file, progress: 0 };
        if (reason) rejected.push({ ...base, status: "error", error: reason, retryable: false });
        else accepted.push({ ...base, status: "pending" });
      }

      setItems((prev) => [...prev, ...accepted, ...rejected]);
      if (accepted.length > 0) void runQueue(accepted);
    },
    [runQueue],
  );

  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "error").length;
  const total = items.length;
  const finished = total > 0 && !running;
  const reviewable = items.filter((i) => i.status === "done").length;

  return (
    <Panel className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Upload documents</h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close upload panel">
          Close
        </Button>
      </div>

      {items.length === 0 ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            addFiles(e.dataTransfer.files);
          }}
          className={cn(
            "m-4 flex flex-col items-center justify-center rounded-[var(--radius-panel)] border-2 border-dashed px-6 py-12 text-center transition-colors",
            dragging
              ? "border-focus bg-surface-hover shadow-lg"
              : "border-border-strong bg-surface-sunken",
          )}
        >
          <svg className="size-7 text-subtle" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 16V4m0 0L8 8m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <p className="mt-3 text-sm">
            Drop invoices here or{" "}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="font-medium text-link underline underline-offset-2"
            >
              browse
            </button>
          </p>
          {/* Stating the limits up front prevents the most common failure. */}
          <p className="mt-1.5 text-xs text-subtle">
            PDF, JPG, PNG · up to 10 MB each · {MAX_FILES} files at a time
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-xs text-muted">
              {done} of {total} complete
              {failed > 0 && <span className="text-conflict-text"> · {failed} failed</span>}
            </span>
            <div className="ml-4 h-1 flex-1 overflow-hidden rounded-full bg-surface-hover">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${total === 0 ? 0 : ((done + failed) / total) * 100}%` }}
              />
            </div>
          </div>

          <ul className="divide-y divide-border">
            {items.map((item) => (
              <li key={item.key} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm">{item.file.name}</span>
                    <span className="shrink-0 text-2xs text-subtle tabular">
                      {formatBytes(item.file.size)}
                    </span>
                  </div>

                  {item.status === "uploading" && (
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-hover">
                      <div
                        className="h-full rounded-full bg-focus transition-all"
                        style={{ width: `${Math.round(item.progress * 100)}%` }}
                      />
                    </div>
                  )}

                  {item.error && (
                    <p className="mt-1 text-xs text-conflict-text">{item.error}</p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {item.status === "uploading" && (
                    <span className="text-2xs text-muted tabular">
                      {Math.round(item.progress * 100)}%
                    </span>
                  )}
                  {item.status === "extracting" && (
                    <span className="flex items-center gap-1.5 text-2xs text-muted">
                      <Spinner /> Extracting
                    </span>
                  )}
                  {item.status === "done" && (
                    <span className="text-2xs font-medium text-approved-text">Ready</span>
                  )}
                  {item.status === "pending" && (
                    <span className="text-2xs text-subtle">Queued</span>
                  )}
                  {item.status === "error" && item.retryable && (
                    <Button size="sm" variant="ghost" onClick={() => void processOne(item)}>
                      Retry
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={running}
            >
              Add more
            </Button>
            {/* No auto-navigate on completion: yanking someone into a screen
                they did not ask for is disorienting. */}
            {finished && reviewable > 0 && (
              <Link href="/documents">
                <Button variant="primary" size="sm" onClick={onClose}>
                  Review {reviewable} document{reviewable === 1 ? "" : "s"}
                </Button>
              </Link>
            )}
          </div>
        </>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
        className="sr-only"
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </Panel>
  );
}
