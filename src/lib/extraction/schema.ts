import { z } from "zod";

/**
 * The single source of truth for extraction.
 *
 * One definition produces three things:
 *   1. the JSON Schema sent to Claude as `output_config.format`
 *   2. runtime validation of whatever comes back
 *   3. the TypeScript type written to `extractions.data`
 *
 * Field semantics live in `.describe()` so they travel to the model with the
 * schema. The prompt covers judgment calls a schema cannot express; it does not
 * restate field meanings, so there is exactly one place to edit them.
 *
 * ⚠️ Structured outputs reject `minimum`/`maximum`/`minLength`/`maxLength` and
 * recursive schemas. Keep constraints out of this schema and enforce ranges in
 * validate.ts instead.
 */

export const lineItemSchema = z.object({
  line_number: z
    .number()
    .int()
    .describe("1-based position of this row as printed on the document."),
  description: z.string().describe("Item description exactly as printed."),
  quantity: z
    .number()
    .describe("Quantity. Use 1 when the document shows no explicit quantity."),
  unit_price: z
    .number()
    .nullable()
    .describe("Price per unit before tax. Null if the document shows only a line total."),
  line_total: z
    .number()
    .describe("Total for this row exactly as printed. Do not compute it."),
});

export const uncertainFieldSchema = z.object({
  field: z
    .string()
    .describe(
      "Field path this uncertainty refers to, e.g. 'vendor_tax_id' or 'line_items.2.quantity'.",
    ),
  confidence: z
    .number()
    .describe("How confident you are in the value you gave, from 0.0 to 1.0."),
  reason: z
    .string()
    .describe(
      "One short sentence a human reviewer can act on, e.g. 'The tax line was cut off at the page edge'.",
    ),
});

export const extractionSchema = z.object({
  document_type: z.enum(["invoice", "receipt"]),
  vendor_name: z.string().nullable().describe("Trading name of the party issuing the document."),
  vendor_address: z.string().nullable().describe("Vendor postal address, single line."),
  vendor_tax_id: z
    .string()
    .nullable()
    .describe("Vendor VAT / GST / EIN / tax registration number. Not the customer's."),
  invoice_number: z.string().nullable().describe("Vendor's own reference for this document."),
  issue_date: z
    .string()
    .nullable()
    .describe("Date issued, normalised to YYYY-MM-DD. Null if absent or ambiguous."),
  due_date: z
    .string()
    .nullable()
    .describe("Payment due date, normalised to YYYY-MM-DD. Null if absent."),
  currency: z
    .string()
    .nullable()
    .describe("ISO 4217 code inferred from symbols or text, e.g. GBP, USD, LKR."),
  subtotal: z
    .number()
    .nullable()
    .describe("Pre-tax total exactly as printed. Do not compute it from line items."),
  tax_amount: z.number().nullable().describe("Total tax as printed."),
  tax_rate: z.number().nullable().describe("Tax rate as a percentage, e.g. 20 for 20%."),
  shipping_amount: z.number().nullable().describe("Shipping or freight charge as printed."),
  service_charge: z
    .number()
    .nullable()
    .describe(
      "Service charge, gratuity, or tip as printed. Distinct from tax — a restaurant service charge is not VAT/GST, and a receipt can carry one with no tax at all.",
    ),
  discount_amount: z
    .number()
    .nullable()
    .describe("Discount as a positive number, however the document signs it."),
  total_amount: z.number().nullable().describe("Final amount payable exactly as printed."),
  payment_method: z
    .string()
    .nullable()
    .describe("How it was paid, if stated, e.g. 'Visa ending 4412'."),
  line_items: z.array(lineItemSchema).describe("One entry per row in the document's item table."),
  uncertain_fields: z
    .array(uncertainFieldSchema)
    .describe(
      "Only fields you are genuinely unsure about. Leave empty when the document is clear.",
    ),
});

export type ExtractionResult = z.infer<typeof extractionSchema>;
export type UncertainField = z.infer<typeof uncertainFieldSchema>;

/** Field paths the UI knows how to highlight. Anything else is discarded. */
export const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "document_type",
  "vendor_name",
  "vendor_address",
  "vendor_tax_id",
  "invoice_number",
  "issue_date",
  "due_date",
  "currency",
  "subtotal",
  "tax_amount",
  "tax_rate",
  "shipping_amount",
  "service_charge",
  "discount_amount",
  "total_amount",
  "payment_method",
]);

export function isKnownFieldPath(path: string): boolean {
  if (KNOWN_FIELDS.has(path)) return true;
  return /^line_items\.\d+\.(description|quantity|unit_price|line_total|line_number)$/.test(path);
}

/**
 * Keywords structured outputs rejects. Zod emits several of these without
 * being asked — `z.number().int()` alone produces `minimum`/`maximum` at the
 * safe-integer bounds, which is enough for the API to reject the whole schema.
 *
 * Stripping post-hoc rather than avoiding the Zod modifiers keeps `.int()` and
 * friends available for runtime validation (where they do real work) and means
 * a future Zod release emitting a new keyword degrades to "ignored" instead of
 * "every extraction 400s".
 */
const UNSUPPORTED_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "$schema",
]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node === null || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    out[key] = stripUnsupported(value);
  }
  return out;
}

/**
 * JSON Schema handed to Claude. Generated from the Zod definition so the
 * contract cannot drift from what we validate against.
 */
export function buildOutputSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(extractionSchema, {
    target: "draft-2020-12",
    io: "output",
  });
  return stripUnsupported(generated) as Record<string, unknown>;
}
