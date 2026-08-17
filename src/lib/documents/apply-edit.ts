import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  documents,
  extractions,
  type EditRecord,
  type ExtractionData,
  type LineItem,
} from "@/lib/db/schema";
import { validateExtraction } from "@/lib/extraction/validate";
import type { ExtractionResult } from "@/lib/extraction/schema";
import { notFound } from "@/lib/http/errors";

/**
 * Applies a human edit to the current extraction and re-validates.
 *
 * Re-validating on every edit is the point: the reconciliation strip has to
 * update live as someone corrects a figure, otherwise it is a static badge
 * rather than a check. It also means fixing the subtotal makes the conflict
 * disappear, which is the moment the whole design earns itself.
 */

export interface EditPatch {
  fields?: Partial<ExtractionData>;
  lineItems?: LineItem[];
}

export async function applyEdit(
  userId: string,
  documentId: string,
  patch: EditPatch,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ extraction: extractions, ownerId: documents.userId })
      .from(extractions)
      .innerJoin(documents, eq(documents.id, extractions.documentId))
      .where(
        and(
          eq(extractions.documentId, documentId),
          eq(extractions.isCurrent, true),
          eq(documents.userId, userId),
        ),
      )
      .limit(1);

    if (!row) throw notFound("No extraction to edit.");

    const current = row.extraction;
    const previous = current.data;
    const next: ExtractionData = {
      ...previous,
      ...patch.fields,
      ...(patch.lineItems ? { line_items: patch.lineItems } : {}),
    };

    // Record only fields that actually changed, so a focus-blur with no typing
    // does not mark a field as reviewed.
    const now = new Date().toISOString();
    const newEdits: EditRecord[] = [];
    const touched = new Set(current.reviewedFields);

    for (const [key, value] of Object.entries(patch.fields ?? {})) {
      const before = previous[key as keyof ExtractionData];
      if (JSON.stringify(before) === JSON.stringify(value)) continue;
      newEdits.push({ field: key, from: before ?? null, to: value ?? null, at: now });
      touched.add(key);
    }
    if (patch.lineItems && JSON.stringify(previous.line_items) !== JSON.stringify(patch.lineItems)) {
      newEdits.push({ field: "line_items", from: previous.line_items, to: patch.lineItems, at: now });
      touched.add("line_items");
    }

    // A human edit clears the model's opinion about that field. Continuing to
    // show amber after someone has corrected a value implies the app does not
    // trust them.
    const confidence = Object.fromEntries(
      Object.entries(current.confidence).filter(([field]) => !touched.has(field)),
    );

    const asResult: ExtractionResult = {
      ...next,
      uncertain_fields: Object.entries(confidence).map(([field, value]) => ({
        field,
        confidence: value,
        // Reason text is regenerated from the stored issue below; this only
        // needs to carry the score through the validator.
        reason:
          current.validationIssues.find((i) => i.field === field)?.message ??
          "The model was unsure about this value.",
      })),
    };

    const { issues, confidence: recomputed } = validateExtraction(asResult);

    await tx
      .update(extractions)
      .set({
        data: next,
        confidence: recomputed,
        validationIssues: issues,
        reviewedFields: [...touched],
        edits: [...current.edits, ...newEdits].slice(-200),
      })
      .where(eq(extractions.id, current.id));

    // Editing an approved document returns it to review: the approval applied
    // to the values as they were.
    await tx
      .update(documents)
      .set({ status: "needs_review" })
      .where(and(eq(documents.id, documentId), eq(documents.status, "approved")));
  });
}
