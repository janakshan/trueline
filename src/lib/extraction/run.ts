import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { documents, extractions, type SupportedMimeType } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { storage } from "@/lib/storage";
import {
  completeWithClaude,
  retryMaxTokens,
  type CompletionFn,
  type CompletionResult,
} from "./client";
import { ExtractionError, classifyError } from "./errors";
import { parseExtraction } from "./parse";
import { PROMPT_VERSION } from "./prompt";
import { toStoredData, validateExtraction } from "./validate";

/** Auto-retries stop here; beyond this a human has to intervene. */
export const MAX_ATTEMPTS = 3;
/** Whole-run budget. Must stay under the route's maxDuration. */
export const RUN_BUDGET_MS = env.EXTRACTION_BUDGET_MS;
/** Don't start a second attempt that cannot finish. */
const MIN_RETRY_BUDGET_MS = 12_000;
/** Debug payloads are capped by a CHECK constraint at 8 KB. */
const RAW_RESPONSE_LIMIT = 8_000;

export interface ExtractionDeps {
  complete: CompletionFn;
  readFile: (key: string) => Promise<Buffer>;
}

const defaultDeps: ExtractionDeps = {
  complete: completeWithClaude,
  readFile: (key) => storage.get(key),
};

export type RunOutcome =
  | { status: "extracted"; documentId: string; issueCount: number; attempts: number }
  | { status: "failed"; documentId: string; code: string; message: string; attempts: number };

interface ClaimedDocument {
  id: string;
  filename: string;
  mimeType: SupportedMimeType;
  storagePath: string;
  attempts: number;
}

/**
 * Atomic claim from architecture.md. The conditional UPDATE is the lock: if it
 * returns no row, another invocation owns this document and we must not touch
 * it. Two browser tabs driving the queue would otherwise extract — and bill
 * for — the same document twice.
 *
 * The stale clause reclaims rows abandoned by a function that timed out
 * mid-extraction, which would otherwise sit in `processing` forever.
 */
export async function claimDocument(
  documentId: string,
  userId: string,
): Promise<ClaimedDocument | null> {
  const result = await db.execute<{
    id: string;
    filename: string;
    mime_type: SupportedMimeType;
    storage_path: string;
    attempts: number;
  }>(sql`
    UPDATE documents
       SET status = 'processing',
           attempts = attempts + 1,
           processing_started_at = now(),
           updated_at = now()
     WHERE id = ${documentId}
       AND user_id = ${userId}
       AND attempts < ${MAX_ATTEMPTS}
       AND (
             status IN ('queued', 'failed')
             OR (status = 'processing'
                 AND processing_started_at < now() - interval '90 seconds')
           )
 RETURNING id, filename, mime_type, storage_path, attempts
  `);

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    storagePath: row.storage_path,
    attempts: row.attempts,
  };
}

/**
 * Writes a successful extraction. One transaction, so a document can never be
 * left pointing at a half-written extraction or with two rows marked current.
 *
 * Called only after Zod validation has passed — nothing unvalidated reaches
 * this function.
 */
async function persistSuccess(
  document: ClaimedDocument,
  completion: CompletionResult,
  parsed: ReturnType<typeof parseExtraction>,
): Promise<number> {
  const { issues, confidence } = validateExtraction(parsed);
  const data = toStoredData(parsed);

  await db.transaction(async (tx) => {
    // Must precede the insert: a partial unique index permits exactly one
    // current extraction per document.
    await tx
      .update(extractions)
      .set({ isCurrent: false })
      .where(and(eq(extractions.documentId, document.id), eq(extractions.isCurrent, true)));

    await tx.insert(extractions).values({
      documentId: document.id,
      data,
      confidence,
      validationIssues: issues,
      isCurrent: true,
      model: completion.model,
      effort: completion.effort,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      rawResponse: completion.text.slice(0, RAW_RESPONSE_LIMIT),
    });

    // Always needs_review, never auto-approved: every document gets a human.
    await tx
      .update(documents)
      .set({
        status: "needs_review",
        errorCode: null,
        errorMessage: null,
        processingStartedAt: null,
      })
      .where(eq(documents.id, document.id));
  });

  return issues.length;
}

async function persistFailure(
  documentId: string,
  error: ExtractionError,
): Promise<void> {
  await db
    .update(documents)
    .set({
      status: "failed",
      errorCode: error.code,
      errorMessage: error.userMessage,
      processingStartedAt: null,
    })
    .where(eq(documents.id, documentId));
}

/**
 * Claim → fetch → extract → validate → persist.
 *
 * Retry policy: exactly one repair attempt, and only for failures a retry can
 * plausibly fix (malformed output, truncation). A refusal or a 400 fails
 * immediately — retrying a permanent failure just spends money to reach the
 * same place.
 */
export async function runExtraction(
  documentId: string,
  userId: string,
  overrides: Partial<ExtractionDeps> = {},
): Promise<RunOutcome | null> {
  const deps: ExtractionDeps = { ...defaultDeps, ...overrides };

  const document = await claimDocument(documentId, userId);
  if (!document) return null;

  const deadline = Date.now() + RUN_BUDGET_MS;

  try {
    let bytes: Buffer;
    try {
      bytes = await deps.readFile(document.storagePath);
    } catch (err) {
      throw new ExtractionError(
        "FILE_UNREADABLE",
        err instanceof Error ? err.message : "unreadable",
      );
    }

    let lastError: ExtractionError | null = null;
    let repairHint: string | undefined;
    let maxTokens: number | undefined;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw lastError ?? new ExtractionError("TIMEOUT", "Budget exhausted before the call.");
      }
      // Starting an attempt that cannot finish wastes the tokens it burns
      // before the abort fires.
      if (attempt === 2 && remaining < MIN_RETRY_BUDGET_MS) {
        throw lastError ?? new ExtractionError("TIMEOUT", "Not enough budget to retry.");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);

      try {
        const completion = await deps.complete(
          {
            bytes,
            mimeType: document.mimeType,
            ...(repairHint !== undefined ? { repairHint } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
          },
          controller.signal,
        );

        const parsed = parseExtraction(completion.text);
        const issueCount = await persistSuccess(document, completion, parsed);

        return {
          status: "extracted",
          documentId: document.id,
          issueCount,
          attempts: document.attempts,
        };
      } catch (err) {
        const error = classifyError(err);
        lastError = error;

        const worthRepairing =
          attempt === 1 &&
          (error.code === "SCHEMA_INVALID" || error.code === "OUTPUT_TRUNCATED");
        if (!worthRepairing) throw error;

        if (error.code === "SCHEMA_INVALID") {
          // The repair hint names the offending paths, so the second attempt
          // is corrective rather than a blind re-roll of the same request.
          repairHint = `Your previous response could not be used. ${error.detail ?? ""} Return the corrected JSON object only.`;
        } else {
          maxTokens = retryMaxTokens;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new ExtractionError("UNKNOWN", "Extraction produced no result.");
  } catch (err) {
    const error = classifyError(err);
    await persistFailure(document.id, error);
    return {
      status: "failed",
      documentId: document.id,
      code: error.code,
      message: error.userMessage,
      attempts: document.attempts,
    };
  }
}

export { PROMPT_VERSION };
