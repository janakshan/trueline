import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { clientKey, enforceRateLimit } from "@/lib/auth/rate-limit";
import { requireUserId } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { documents, extractions } from "@/lib/db/schema";
import { toDocumentDetail } from "@/lib/documents/serialize";
import { MAX_ATTEMPTS, runExtraction } from "@/lib/extraction/run";
import {
  assertExtractionBudget,
  recordExtractionUsage,
} from "@/lib/extraction/spend-guard";
import { AppError, badRequest, notFound } from "@/lib/http/errors";
import { ok, route } from "@/lib/http/respond";

export const runtime = "nodejs";
/**
 * Must exceed RUN_BUDGET_MS (50s) so the run's own deadline fires first and
 * writes a clean TIMEOUT row, rather than the platform killing the function
 * mid-write and leaving the document stuck in `processing`.
 */
export const maxDuration = 60;

const paramsSchema = z.object({ id: z.string().uuid() });

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/documents/:id/extract — claim the document and extract it.
 *
 * Also serves retry: the atomic claim already accepts `failed` rows, so a
 * separate /retry endpoint would be the same code behind a second name.
 *
 * 409 when the claim fails, which means one of two things — another invocation
 * owns the document, or it has exhausted its attempts. Both are "not yours to
 * run right now", and the body says which.
 */
export const POST = route<Context>(async (request, context) => {
  const userId = await requireUserId();

  // The only endpoint that spends money. The per-document attempt cap (3) does
  // not bound total spend, because a caller can upload unlimited documents and
  // extract each of them — so the limit has to be per client, not per document.
  //
  // Cheap in-memory check first: it rejects a flood without touching the
  // database. It cannot bound spend on its own (instances do not share the Map,
  // cold starts reset it), so the durable guard below is what actually holds.
  const key = clientKey(request, "extract");
  enforceRateLimit(key, { limit: 20, windowMs: 60 * 60 * 1000 });

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) throw badRequest("Document id must be a UUID.");
  const documentId = parsed.data.id;

  // Postgres-backed, so it survives cold starts and holds across instances:
  // per-client hourly, and a monthly ceiling for the whole deployment. A
  // read-only check — budget is only spent once a call actually happens.
  await assertExtractionBudget(key);

  const outcome = await runExtraction(documentId, userId);

  if (outcome === null) {
    // Distinguish "no such document" from "could not claim" so the client can
    // tell a 404 from a transient conflict.
    const [existing] = await db
      .select({ status: documents.status, attempts: documents.attempts })
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
      .limit(1);

    if (!existing) throw notFound("Document not found.");

    if (existing.attempts >= MAX_ATTEMPTS) {
      throw new AppError(
        "CONFLICT",
        `This document has failed ${existing.attempts} times and will not be retried automatically.`,
        { status: existing.status, attempts: existing.attempts },
      );
    }

    throw new AppError("CONFLICT", "This document is already being extracted.", {
      status: existing.status,
    });
  }

  // Past the null branch the document was claimed, which means the API call
  // happened — so it cost money and consumes budget, success or failure. A
  // document that could not be claimed never reaches here, or hammering one
  // dead document would drain the month's cap without spending a cent.
  await recordExtractionUsage({ clientKey: key, userId, documentId });

  const [row] = await db
    .select({ document: documents, extraction: extractions })
    .from(documents)
    .leftJoin(
      extractions,
      and(eq(extractions.documentId, documents.id), eq(extractions.isCurrent, true)),
    )
    .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
    .limit(1);

  if (!row) throw notFound("Document not found.");

  // A failed extraction is a successful request that reports a failure: the
  // document row is the resource, and it now carries the error. Returning 5xx
  // here would tell the client our API broke, which it did not.
  return ok(toDocumentDetail(row.document, row.extraction));
});
