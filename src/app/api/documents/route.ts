import { randomUUID } from "node:crypto";
import { and, count, desc, eq, lt, or } from "drizzle-orm";
import { z } from "zod";
import { clientKey, enforceRateLimit } from "@/lib/auth/rate-limit";
import { requireUserId } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { DOCUMENT_STATUSES, documents, extractions } from "@/lib/db/schema";
import { decodeCursor, encodeCursor } from "@/lib/documents/cursor";
import { validateUploadedFile } from "@/lib/documents/file-validation";
import { toDocumentSummary } from "@/lib/documents/serialize";
import { AppError } from "@/lib/http/errors";
import { ok, route } from "@/lib/http/respond";
import { buildStorageKey, storage } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * GET /api/documents — the list, and the endpoint the client polls while a
 * batch is extracting.
 *
 * Query: ?status=needs_review&limit=25&cursor=<opaque>
 *
 * Always returns `meta.counts` so the filter chips in ui-plan.md render without
 * a second round trip — the client polls this every 2s, and two queries per
 * poll is meaningfully cheaper than four.
 */
const listQuerySchema = z.object({
  status: z.enum(DOCUMENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(512).optional(),
});

export const GET = route(async (request: Request) => {
  const userId = await requireUserId();

  const url = new URL(request.url);
  const query = listQuerySchema.parse({
    status: url.searchParams.get("status") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
  });

  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  const filters = [eq(documents.userId, userId)];
  if (query.status) filters.push(eq(documents.status, query.status));
  if (cursor) {
    // (created_at, id) < (cursor.created_at, cursor.id) — the tuple comparison
    // that makes the keyset stable when timestamps collide.
    filters.push(
      or(
        lt(documents.createdAt, cursor.createdAt),
        and(eq(documents.createdAt, cursor.createdAt), lt(documents.id, cursor.id)),
      )!,
    );
  }

  // Fetch one extra row to determine hasMore without a second COUNT.
  const rows = await db
    .select({ document: documents, extraction: extractions })
    .from(documents)
    .leftJoin(
      extractions,
      and(eq(extractions.documentId, documents.id), eq(extractions.isCurrent, true)),
    )
    .where(and(...filters))
    .orderBy(desc(documents.createdAt), desc(documents.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  const statusRows = await db
    .select({ status: documents.status, total: count() })
    .from(documents)
    .where(eq(documents.userId, userId))
    .groupBy(documents.status);

  const counts = Object.fromEntries(
    DOCUMENT_STATUSES.map((s) => [s, 0]),
  ) as Record<(typeof DOCUMENT_STATUSES)[number], number>;
  let total = 0;
  for (const row of statusRows) {
    counts[row.status] = row.total;
    total += row.total;
  }

  const last = page.at(-1);

  return ok(
    page.map((r) => toDocumentSummary(r.document, r.extraction)),
    {
      meta: {
        counts: { all: total, ...counts },
        nextCursor:
          hasMore && last
            ? encodeCursor({ createdAt: last.document.createdAt, id: last.document.id })
            : null,
      },
    },
  );
});

/**
 * POST /api/documents — upload one file and queue it for extraction.
 *
 * Body: multipart/form-data with a single `file` part.
 *
 * Scope note: this accepts the file through the route handler, which Vercel
 * caps at ~4.5 MB even though our own limit is 10 MB. The client-direct-to-blob
 * path from architecture.md that lifts that cap is a later increment; it
 * replaces the storage seam and adds a token route without changing this
 * contract.
 */
export const POST = route(async (request: Request) => {
  const userId = await requireUserId();

  // Bounds storage, and transitively the number of documents that can be fed
  // to the extract endpoint. 20 files per batch is the documented UI limit.
  enforceRateLimit(clientKey(request, "upload"), { limit: 60, windowMs: 60 * 60 * 1000 });

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    throw new AppError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Expected Content-Type: multipart/form-data with a 'file' part.",
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // A truncated or malformed multipart body is a client error, not a crash.
    throw new AppError("VALIDATION_ERROR", "Could not parse the multipart body.");
  }

  const parts = form.getAll("file");
  if (parts.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Missing required 'file' part.");
  }
  if (parts.length > 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Send one file per request. Batch uploads issue one request per file so a single bad file cannot fail the batch.",
    );
  }

  const file = await validateUploadedFile(parts[0]);

  // The id is generated up front so the storage key can be derived from it,
  // which keeps one document's bytes in one prefix and makes deletion trivial.
  const documentId = randomUUID();
  const storagePath = buildStorageKey(documentId, file.filename);

  await storage.put(storagePath, file.bytes);

  try {
    const [row] = await db
      .insert(documents)
      .values({
        id: documentId,
        userId,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        storagePath,
        status: "queued",
      })
      .returning();

    if (!row) throw new Error("Insert returned no row");

    return ok(toDocumentSummary(row, null), { status: 201 });
  } catch (err) {
    // Roll back the stored bytes so a failed insert cannot orphan a file.
    // Best-effort: a failure here is logged, never surfaced over the original.
    await storage.delete(storagePath).catch((cleanupErr: unknown) => {
      console.error("Failed to clean up orphaned upload", storagePath, cleanupErr);
    });
    throw err;
  }
});
