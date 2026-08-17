import type { ExtractionData, ValidationIssue } from "@/lib/db/schema";
import { isKnownFieldPath, type ExtractionResult } from "./schema";

/**
 * Deterministic checks over the extracted data.
 *
 * architecture.md's position: this is the signal we trust. Model-reported
 * confidence is a weakly-calibrated hint that colours a field; arithmetic is
 * reproducible, explainable, and catches the failure that actually matters —
 * a plausible number in the wrong place.
 *
 * Every issue carries a message a reviewer can act on. A flag without a legible
 * reason is just a yellow box.
 */

/** Half a cent, to absorb rounding without hiding real discrepancies. */
const TOLERANCE = 0.005;
/** Below this, the model's own uncertainty is worth a reviewer's attention. */
const CONFIDENCE_THRESHOLD = 0.85;

const money = (n: number): string =>
  n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

export interface ValidationOutcome {
  issues: ValidationIssue[];
  confidence: Record<string, number>;
}

export function validateExtraction(result: ExtractionResult): ValidationOutcome {
  const issues: ValidationIssue[] = [];
  const confidence: Record<string, number> = {};

  // ---- reconciliation: the load-bearing check ----------------------------
  const lineSum = result.line_items.reduce((sum, item) => sum + item.line_total, 0);

  if (result.line_items.length > 0 && result.subtotal !== null) {
    const difference = Math.abs(lineSum - result.subtotal);
    if (difference > TOLERANCE) {
      issues.push({
        field: "subtotal",
        severity: "conflict",
        message: `Line items total ${money(lineSum)} but subtotal reads ${money(result.subtotal)} — ${money(difference)} difference`,
      });
    }
  }

  if (result.subtotal !== null && result.total_amount !== null) {
    // service_charge exists because omitting it produced a false red conflict
    // on a receipt that was internally consistent: the model correctly refused
    // to call an 8.5% service charge "tax", and the formula had nowhere to put
    // it. A false conflict on clean data teaches reviewers to ignore red.
    const expected =
      result.subtotal +
      (result.tax_amount ?? 0) +
      (result.shipping_amount ?? 0) +
      (result.service_charge ?? 0) -
      (result.discount_amount ?? 0);
    const difference = Math.abs(expected - result.total_amount);
    if (difference > TOLERANCE) {
      issues.push({
        field: "total_amount",
        severity: "conflict",
        message: `Subtotal, tax, shipping, service and discount come to ${money(expected)} but the total reads ${money(result.total_amount)} — ${money(difference)} difference`,
      });
    }
  }

  // ---- required fields ---------------------------------------------------
  if (result.vendor_name === null || result.vendor_name.trim() === "") {
    issues.push({
      field: "vendor_name",
      severity: "conflict",
      message: "No vendor name was found — required for every document",
    });
  }

  if (result.total_amount === null) {
    issues.push({
      field: "total_amount",
      severity: "conflict",
      message: "No total amount was found — required for every document",
    });
  }

  if (result.document_type === "invoice" && result.due_date === null) {
    issues.push({
      field: "due_date",
      severity: "conflict",
      message: "No due date found — required for invoices",
    });
  }

  // ---- structural sanity -------------------------------------------------
  for (const [field, value] of [
    ["issue_date", result.issue_date],
    ["due_date", result.due_date],
  ] as const) {
    if (value !== null && !isRealDate(value)) {
      issues.push({
        field,
        severity: "conflict",
        // Dates are flagged, never coerced: 03/04/2026 is genuinely ambiguous
        // and a confident wrong guess is worse than an obvious blank.
        message: `Date "${value}" is not a valid YYYY-MM-DD date — check the original`,
      });
    }
  }

  if (
    result.issue_date !== null &&
    result.due_date !== null &&
    isRealDate(result.issue_date) &&
    isRealDate(result.due_date) &&
    result.due_date < result.issue_date
  ) {
    issues.push({
      field: "due_date",
      severity: "check",
      message: `Due date ${result.due_date} falls before the issue date ${result.issue_date}`,
    });
  }

  if (result.currency !== null && !ISO_CURRENCY.test(result.currency)) {
    issues.push({
      field: "currency",
      severity: "check",
      message: `"${result.currency}" is not a 3-letter ISO 4217 currency code`,
    });
  }

  result.line_items.forEach((item, index) => {
    if (item.quantity < 0) {
      issues.push({
        field: `line_items.${index}.quantity`,
        severity: "check",
        message: `Negative quantity (${item.quantity}) on "${item.description}"`,
      });
    }
    if (item.unit_price !== null) {
      const expected = item.unit_price * item.quantity;
      if (Math.abs(expected - item.line_total) > TOLERANCE) {
        issues.push({
          field: `line_items.${index}.line_total`,
          severity: "check",
          message: `${item.quantity} × ${money(item.unit_price)} is ${money(expected)}, but the row total reads ${money(item.line_total)}`,
        });
      }
    }
  });

  // ---- model-reported uncertainty ---------------------------------------
  for (const entry of result.uncertain_fields) {
    // Silently drop paths the UI cannot highlight rather than rendering a flag
    // that points nowhere.
    if (!isKnownFieldPath(entry.field)) continue;

    const clamped = Math.min(1, Math.max(0, entry.confidence));
    confidence[entry.field] = clamped;

    if (clamped < CONFIDENCE_THRESHOLD) {
      issues.push({ field: entry.field, severity: "check", message: entry.reason });
    }
  }

  return { issues, confidence };
}

/** Strips the transport-only `uncertain_fields` before persisting. */
export function toStoredData(result: ExtractionResult): ExtractionData {
  const { uncertain_fields: _uncertain, ...data } = result;
  return data satisfies ExtractionData;
}
