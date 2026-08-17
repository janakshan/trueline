"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Document preview.
 *
 * Native <embed> for PDFs and <img> for images. The browser already ships a
 * PDF renderer; pulling in pdf.js (~1 MB) to duplicate it is not worth it.
 * The trade-off is no bounding-box highlighting linking a field to its place
 * on the page — genuinely nice, and out of scope for v1.
 */
export function PreviewPane({
  documentId,
  mimeType,
  filename,
}: {
  documentId: string;
  mimeType: string;
  filename: string;
}) {
  const [failed, setFailed] = useState(false);
  const source = `/api/documents/${documentId}/file`;

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-[var(--radius-panel)] border border-border bg-surface p-8 text-center">
        <svg className="size-7 text-subtle" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M14 3v4a1 1 0 0 0 1 1h4M5 3h9l6 6v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
        <div>
          <p className="text-sm font-medium">Preview unavailable</p>
          <p className="mt-1 text-xs text-muted">
            The original file could not be displayed. The extracted fields are still editable.
          </p>
        </div>
        <a href={source} target="_blank" rel="noreferrer">
          <Button size="sm">Open original</Button>
        </a>
      </div>
    );
  }

  if (mimeType === "application/pdf") {
    return (
      <object
        data={source}
        type="application/pdf"
        title={filename}
        className="h-full w-full rounded-[var(--radius-panel)] border border-border bg-surface"
        onError={() => setFailed(true)}
      >
        {/* Rendered when the browser has no PDF plugin. */}
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-sm">This browser cannot display PDFs inline.</p>
          <a href={source} target="_blank" rel="noreferrer">
            <Button size="sm">Open original</Button>
          </a>
        </div>
      </object>
    );
  }

  return (
    <div className="h-full overflow-auto rounded-[var(--radius-panel)] border border-border bg-surface p-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={source}
        alt={`Preview of ${filename}`}
        className="mx-auto max-w-full"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
