import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireUserId } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { documents, extractions } from "@/lib/db/schema";
import { applyEdit } from "@/lib/documents/apply-edit";
import { getDocument } from "@/lib/documents/queries";
import { toDocumentDetail } from "@/lib/documents/serialize";
import { AppError, badRequest, notFound } from "@/lib/http/errors";
import { ok, route } from "@/lib/http/respond";
import { storage } from "@/lib/storage";

export const runtime = "nodejs";

const paramsSchema = z.object({ id: z.string().uuid() });

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/documents/:id — one document plus its current extraction.
 *
 * Ownership is part of the WHERE clause, not a check after the fetch. A
 * document belonging to another user returns 404 rather than 403: 403 confirms
 * the id exists, which is an existence oracle over a UUID space.
 */
export const GET = route<Context>(async (_request, context) => {
  const userId = await requireUserId();

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) {
    // A non-UUID path segment is a client error, not a 500 from the driver
    // failing to cast it.
    throw badRequest("Document id must be a UUID.");
  }

  const [row] = await db
    .select({ document: documents, extraction: extractions })
    .from(documents)
    .leftJoin(
      extractions,
      and(eq(extractions.documentId, documents.id), eq(extractions.isCurrent, true)),
    )
    .where(and(eq(documents.id, parsed.data.id), eq(documents.userId, userId)))
    .limit(1);

  if (!row) throw notFound("Document not found.");

  return ok(toDocumentDetail(row.document, row.extraction));
});


/** Header fields a reviewer may edit. Mirrors the extraction schema, minus
 *  line_items (which has its own endpoint) and the transport-only fields. */
const editableFields = z
  .object({
    document_type: z.enum(["invoice", "receipt"]),
    vendor_name: z.string().nullable(),
    vendor_address: z.string().nullable(),
    vendor_tax_id: z.string().nullable(),
    invoice_number: z.string().nullable(),
    issue_date: z.string().nullable(),
    due_date: z.string().nullable(),
    currency: z.string().nullable(),
    subtotal: z.number().nullable(),
    tax_amount: z.number().nullable(),
    tax_rate: z.number().nullable(),
    shipping_amount: z.number().nullable(),
    service_charge: z.number().nullable(),
    discount_amount: z.number().nullable(),
    total_amount: z.number().nullable(),
    payment_method: z.string().nullable(),
  })
  .partial();

const lineItemSchema = z.object({
  line_number: z.number().int(),
  description: z.string(),
  quantity: z.number(),
  unit_price: z.number().nullable(),
  line_total: z.number(),
});

const patchSchema = z
  .object({
    fields: editableFields.optional(),
    lineItems: z.array(lineItemSchema).max(200).optional(),
    status: z.enum(["approved", "needs_review"]).optional(),
  })
  .refine(
    (body) => body.fields !== undefined || body.lineItems !== undefined || body.status !== undefined,
    { message: "Provide at least one of fields, lineItems, or status." },
  );

/**
 * PATCH /api/documents/:id — apply reviewer edits and/or change approval.
 *
 * Edits and approval share one endpoint because they share one invariant:
 * approving a document has to reflect the values as they are right now, and
 * splitting them across two requests opens a window where it might not.
 */
export const PATCH = route<Context>(async (request, context) => {
  const userId = await requireUserId();

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) throw badRequest("Document id must be a UUID.");
  const documentId = parsed.data.id;

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Expected Content-Type: application/json.");
  }

  const body = patchSchema.parse(await request.json());

  if (body.fields || body.lineItems) {
    await applyEdit(userId, documentId, {
      ...(body.fields ? { fields: body.fields } : {}),
      ...(body.lineItems ? { lineItems: body.lineItems } : {}),
    });
  }

  // Applied after the edit so approval always reflects the values just saved.
  if (body.status) {
    const updated = await db
      .update(documents)
      .set({ status: body.status })
      .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
      .returning({ id: documents.id });
    if (updated.length === 0) throw notFound("Document not found.");
  }

  const detail = await getDocument(userId, documentId);
  if (!detail) throw notFound("Document not found.");
  return ok(detail);
});

/**
 * DELETE /api/documents/:id — remove the row and its stored bytes.
 *
 * The row goes first: an orphaned file is a wasted megabyte, an orphaned row
 * is a broken preview the user can see.
 */
export const DELETE = route<Context>(async (_request, context) => {
  const userId = await requireUserId();

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) throw badRequest("Document id must be a UUID.");

  const [deleted] = await db
    .delete(documents)
    .where(and(eq(documents.id, parsed.data.id), eq(documents.userId, userId)))
    .returning({ storagePath: documents.storagePath });

  if (!deleted) throw notFound("Document not found.");

  await storage.delete(deleted.storagePath).catch((err: unknown) => {
    console.error("Failed to delete stored file", deleted.storagePath, err);
  });

  return ok({ deleted: true });
});
