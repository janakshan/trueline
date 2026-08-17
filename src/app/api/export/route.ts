import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireUserId } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { documents, extractions } from "@/lib/db/schema";
import { toCsv } from "@/lib/export/csv";
import { badRequest } from "@/lib/http/errors";
import { route } from "@/lib/http/respond";

export const runtime = "nodejs";

const querySchema = z.object({
  scope: z.enum(["all", "selected"]).default("all"),
  ids: z.string().optional(),
  granularity: z.enum(["document", "line_item"]).default("document"),
});

const DOCUMENT_HEADERS = [
  "document_id", "filename", "status", "document_type", "vendor_name", "vendor_address",
  "vendor_tax_id", "invoice_number", "issue_date", "due_date", "currency", "subtotal",
  "tax_amount", "tax_rate", "shipping_amount", "service_charge", "discount_amount", "total_amount",
  "payment_method", "line_item_count", "flag_count",
];

const LINE_ITEM_HEADERS = [
  "document_id", "filename", "status", "vendor_name", "invoice_number", "issue_date",
  "currency", "line_number", "description", "quantity", "unit_price", "line_total",
  "document_total",
];

/**
 * GET /api/export — CSV download.
 *
 * Two row shapes. `document` collapses line items to a count; `line_item`
 * emits one row per item with the header fields repeated — the shape
 * bookkeepers actually want, and the reason the JSONB storage decision in
 * db/README.md had to be checked against a real export query.
 */
export const GET = route(async (request: Request) => {
  const userId = await requireUserId();
  const url = new URL(request.url);

  const query = querySchema.parse({
    scope: url.searchParams.get("scope") ?? undefined,
    ids: url.searchParams.get("ids") ?? undefined,
    granularity: url.searchParams.get("granularity") ?? undefined,
  });

  const filters = [eq(documents.userId, userId)];
  if (query.scope === "selected") {
    const ids = (query.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) throw badRequest("Select at least one document to export.");
    if (ids.length > 500) throw badRequest("Export at most 500 documents at a time.");
    if (!ids.every((id) => /^[0-9a-f-]{36}$/i.test(id))) {
      throw badRequest("One or more document ids are malformed.");
    }
    filters.push(inArray(documents.id, ids));
  }

  const rows = await db
    .select({ document: documents, extraction: extractions })
    .from(documents)
    .innerJoin(
      extractions,
      and(eq(extractions.documentId, documents.id), eq(extractions.isCurrent, true)),
    )
    .where(and(...filters))
    .orderBy(documents.createdAt);

  const body =
    query.granularity === "document"
      ? toCsv(
          DOCUMENT_HEADERS,
          rows.map(({ document, extraction }) => {
            const d = extraction.data;
            return [
              document.id, document.filename, document.status, d.document_type, d.vendor_name,
              d.vendor_address, d.vendor_tax_id, d.invoice_number, d.issue_date, d.due_date,
              d.currency, d.subtotal, d.tax_amount, d.tax_rate, d.shipping_amount,
              d.service_charge, d.discount_amount, d.total_amount, d.payment_method,
              d.line_items.length, extraction.validationIssues.length,
            ];
          }),
        )
      : toCsv(
          LINE_ITEM_HEADERS,
          rows.flatMap(({ document, extraction }) => {
            const d = extraction.data;
            // A document with no line items still deserves a row, or it
            // silently vanishes from the export.
            if (d.line_items.length === 0) {
              return [[
                document.id, document.filename, document.status, d.vendor_name, d.invoice_number,
                d.issue_date, d.currency, null, null, null, null, null, d.total_amount,
              ]];
            }
            return d.line_items.map((item) => [
              document.id, document.filename, document.status, d.vendor_name, d.invoice_number,
              d.issue_date, d.currency, item.line_number, item.description, item.quantity,
              item.unit_price, item.line_total, d.total_amount,
            ]);
          }),
        );

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="trueline-${query.granularity}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
