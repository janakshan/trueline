import type {
  DocumentRow,
  DocumentStatus,
  ExtractionData,
  ExtractionRow,
  ValidationIssue,
} from "@/lib/db/schema";

/**
 * Explicit serialisers rather than returning rows directly. `storage_path`,
 * `raw_response`, and `user_id` are internal and must never reach a client;
 * returning `...row` would leak each new internal column automatically the day
 * someone adds one.
 */

export interface DocumentSummary {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  pageCount: number | null;
  status: DocumentStatus;
  attempts: number;
  error: { code: string; message: string | null } | null;
  vendorName: string | null;
  issueDate: string | null;
  currency: string | null;
  totalAmount: number | null;
  lineItemCount: number | null;
  flagCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentDetail extends DocumentSummary {
  extraction: {
    id: string;
    data: ExtractionData;
    confidence: Record<string, number>;
    validationIssues: ValidationIssue[];
    reviewedFields: string[];
    model: string | null;
    createdAt: string;
  } | null;
}

/** Postgres `numeric` arrives as a string; the API returns a JSON number. */
function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toDocumentSummary(
  document: DocumentRow,
  extraction: Pick<
    ExtractionRow,
    "vendorName" | "issueDate" | "currency" | "totalAmount" | "lineItemCount" | "validationIssues"
  > | null,
): DocumentSummary {
  return {
    id: document.id,
    filename: document.filename,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    pageCount: document.pageCount,
    status: document.status,
    attempts: document.attempts,
    error: document.errorCode
      ? { code: document.errorCode, message: document.errorMessage }
      : null,
    vendorName: extraction?.vendorName ?? null,
    issueDate: extraction?.issueDate ?? null,
    currency: extraction?.currency ?? null,
    totalAmount: toNumber(extraction?.totalAmount ?? null),
    lineItemCount: extraction?.lineItemCount ?? null,
    flagCount: extraction?.validationIssues?.length ?? 0,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

export function toDocumentDetail(
  document: DocumentRow,
  extraction: ExtractionRow | null,
): DocumentDetail {
  return {
    ...toDocumentSummary(document, extraction),
    extraction: extraction
      ? {
          id: extraction.id,
          data: extraction.data,
          confidence: extraction.confidence,
          validationIssues: extraction.validationIssues,
          reviewedFields: extraction.reviewedFields,
          model: extraction.model,
          createdAt: extraction.createdAt.toISOString(),
        }
      : null,
  };
}
