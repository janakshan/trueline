import { ZodError } from "zod";
import { ExtractionError } from "./errors";
import { extractionSchema, type ExtractionResult } from "./schema";

/**
 * Turns raw model text into a validated ExtractionResult, or throws
 * SCHEMA_INVALID carrying a repair hint precise enough for one retry to fix.
 *
 * Structured outputs should make most of this unnecessary. It exists anyway:
 * "should" is not a guarantee, and the cost of being wrong is a corrupt row.
 */

const NUMERIC_FIELDS = [
  "subtotal",
  "tax_amount",
  "tax_rate",
  "shipping_amount",
  "service_charge",
  "discount_amount",
  "total_amount",
] as const;

const LINE_ITEM_NUMERIC_FIELDS = ["quantity", "unit_price", "line_total", "line_number"] as const;

const NULLISH_TOKENS = new Set(["", "-", "—", "n/a", "na", "none", "null", "unknown"]);

/**
 * Accepts what a model plausibly emits for a number and rejects the rest.
 * Returns `undefined` when the value is not coercible, so the caller can leave
 * it in place and let Zod produce a precise error rather than silently nulling
 * a value we failed to understand.
 */
export function coerceNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  if (NULLISH_TOKENS.has(trimmed.toLowerCase())) return null;

  // Accounting negatives: (180.00) means -180.00
  const parenthesised = /^\((.*)\)$/.exec(trimmed);
  const body = parenthesised?.[1] ?? trimmed;

  // Strip currency symbols, thousands separators, percent signs, whitespace.
  const stripped = body
    .replace(/[\p{Sc}]/gu, "")
    .replace(/[,\s\u00a0']/g, "")
    .replace(/%/g, "")
    .trim();

  // Currency *codes* are removed only at the boundaries ("USD1240", "1240GBP").
  //
  // This previously stripped every [A-Za-z] anywhere, which silently corrupted
  // exponent notation: "1.5e3" became "1.53" — a 1000x error that looks like an
  // ordinary number, so nothing downstream could catch it. Rejecting an odd
  // value is recoverable; accepting a wrong one is not.
  const cleaned = stripped.replace(/^[A-Za-z]+/, "").replace(/[A-Za-z]+$/, "");

  // Allows an optional exponent; a letter anywhere else fails the match.
  if (cleaned === "" || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(cleaned)) {
    return undefined;
  }

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return undefined;
  return parenthesised ? -parsed : parsed;
}

function normaliseNumericField(target: Record<string, unknown>, key: string): void {
  if (!(key in target)) return;
  const coerced = coerceNumber(target[key]);
  if (coerced !== undefined) target[key] = coerced;
}

/** Pre-Zod normalisation. Mutates a copy, never the input. */
export function normaliseRawExtraction(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;

  const root = { ...(input as Record<string, unknown>) };

  for (const field of NUMERIC_FIELDS) normaliseNumericField(root, field);

  // Discount is stored positive whichever way the document signs it.
  if (typeof root.discount_amount === "number" && root.discount_amount < 0) {
    root.discount_amount = Math.abs(root.discount_amount);
  }

  if (Array.isArray(root.line_items)) {
    root.line_items = root.line_items.map((item, index) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
      const row = { ...(item as Record<string, unknown>) };
      for (const field of LINE_ITEM_NUMERIC_FIELDS) normaliseNumericField(row, field);
      // A missing quantity means 1 per the prompt; a missing line_number is
      // positional. Both are safe to fill because neither invents a value.
      if (row.quantity === null || row.quantity === undefined) row.quantity = 1;
      if (row.line_number === null || row.line_number === undefined) row.line_number = index + 1;
      return row;
    });
  }

  // A model that omits the array entirely means "no uncertainties", which is
  // different from an invalid response.
  root.uncertain_fields ??= [];
  root.line_items ??= [];

  return root;
}

/** Pulls a JSON object out of model text that may be fenced or padded. */
export function extractJsonText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;

  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) return trimmed.slice(first, last + 1);

  return trimmed;
}

export interface ParseFailure {
  hint: string;
}

/**
 * Throws ExtractionError("SCHEMA_INVALID") with `detail` set to a repair hint.
 * The hint names the offending paths so the retry is corrective rather than a
 * blind re-roll of the same request.
 */
export function parseExtraction(rawText: string): ExtractionResult {
  const jsonText = extractJsonText(rawText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unparseable";
    throw new ExtractionError(
      "SCHEMA_INVALID",
      `Response was not valid JSON (${reason}). Return a single JSON object and nothing else.`,
    );
  }

  const normalised = normaliseRawExtraction(parsed);

  try {
    return extractionSchema.parse(normalised);
  } catch (err) {
    if (err instanceof ZodError) {
      const problems = err.issues
        .slice(0, 8)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new ExtractionError(
        "SCHEMA_INVALID",
        `Response did not match the schema — ${problems}. Fix these fields and return the whole object again.`,
      );
    }
    throw err;
  }
}
