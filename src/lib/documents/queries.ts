import { and, count, desc, eq, lt, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { DOCUMENT_STATUSES, documents, extractions, type DocumentStatus } from "@/lib/db/schema";
import { decodeCursor, encodeCursor } from "./cursor";
import { toDocumentDetail, toDocumentSummary, type DocumentDetail, type DocumentSummary } from "./serialize";

/**
 * One data-access layer for both the API routes and the server components.
 *
 * Server components call these directly rather than fetching our own HTTP API:
 * an internal round trip through the network stack to reach the same database
 * is pure latency, and on a cold Neon instance it is latency that shows.
 * Client-side polling and mutations still go through the routes, which call
 * these same functions — so the two can never disagree.
 */

export type StatusCounts = Record<DocumentStatus | "all", number>;

export interface DocumentListPage {
  items: DocumentSummary[];
  counts: StatusCounts;
  nextCursor: string | null;
}

export async function listDocuments(params: {
  userId: string;
  status?: DocumentStatus | undefined;
  limit?: number;
  cursor?: string | undefined;
}): Promise<DocumentListPage> {
  const limit = params.limit ?? 25;
  const cursor = params.cursor ? decodeCursor(params.cursor) : null;

  const filters = [eq(documents.userId, params.userId)];
  if (params.status) filters.push(eq(documents.status, params.status));
  if (cursor) {
    filters.push(
      or(
        lt(documents.createdAt, cursor.createdAt),
        and(eq(documents.createdAt, cursor.createdAt), lt(documents.id, cursor.id)),
      )!,
    );
  }

  // One extra row tells us whether there is a next page without a COUNT.
  const rows = await db
    .select({ document: documents, extraction: extractions })
    .from(documents)
    .leftJoin(
      extractions,
      and(eq(extractions.documentId, documents.id), eq(extractions.isCurrent, true)),
    )
    .where(and(...filters))
    .orderBy(desc(documents.createdAt), desc(documents.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map((r) => toDocumentSummary(r.document, r.extraction)),
    counts: await countByStatus(params.userId),
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.document.createdAt, id: last.document.id })
        : null,
  };
}

/** Backs the filter chips. Shipped on every list response so the client that
 *  polls every 2s doesn't need a second round trip for its counts. */
export async function countByStatus(userId: string): Promise<StatusCounts> {
  const rows = await db
    .select({ status: documents.status, total: count() })
    .from(documents)
    .where(eq(documents.userId, userId))
    .groupBy(documents.status);

  const counts = Object.fromEntries(DOCUMENT_STATUSES.map((s) => [s, 0])) as StatusCounts;
  counts.all = 0;
  for (const row of rows) {
    counts[row.status] = row.total;
    counts.all += row.total;
  }
  return counts;
}

/** Ownership is in the WHERE clause, not a check afterwards. */
export async function getDocument(
  userId: string,
  documentId: string,
): Promise<DocumentDetail | null> {
  const [row] = await db
    .select({ document: documents, extraction: extractions })
    .from(documents)
    .leftJoin(
      extractions,
      and(eq(extractions.documentId, documents.id), eq(extractions.isCurrent, true)),
    )
    .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
    .limit(1);

  return row ? toDocumentDetail(row.document, row.extraction) : null;
}
