/**
 * Live check against the real Claude API. Run this once ANTHROPIC_API_KEY is set.
 *
 *   npm run check:claude                       # sample 1 (clean invoice)
 *   npm run check:claude -- samples/sample-02-mismatch-invoice.pdf
 *
 * Verifies exactly the things the offline suite cannot, because they need a
 * network hop: that the API accepts our generated JSON Schema, that a real
 * response validates, that extraction fits the time budget, and what it costs.
 *
 * Touches no database and writes nothing. Safe to run repeatedly.
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { SupportedMimeType } from "../src/lib/db/schema";
import { env } from "../src/lib/env";
import { EXTRACTION_EFFORT, EXTRACTION_MODEL, completeWithClaude } from "../src/lib/extraction/client";
import { ExtractionError, classifyError } from "../src/lib/extraction/errors";
import { parseExtraction } from "../src/lib/extraction/parse";
import { buildOutputSchema } from "../src/lib/extraction/schema";
import { validateExtraction } from "../src/lib/extraction/validate";

/**
 * List pricing, USD per million tokens, keyed by model.
 *
 * Was a single hardcoded Opus rate, which silently mispriced every other model
 * — a comparison run reported Haiku as more expensive than Sonnet, the exact
 * inverse of the truth, because it applied Opus rates to Haiku's token counts.
 * A cost figure that is confidently wrong is worse than none.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  // Introductory rate through 2026-08-31; reverts to 3 / 15 after.
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

function priceFor(model: string): { input: number; output: number } | null {
  if (PRICING[model]) return PRICING[model];
  const match = Object.keys(PRICING).find((k) => model.startsWith(k));
  return match ? PRICING[match]! : null;
}

const MIME_BY_EXT: Record<string, SupportedMimeType> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function main(): Promise<void> {
  const path = process.argv[2] ?? "samples/sample-01-clean-invoice.pdf";
  const mimeType = MIME_BY_EXT[extname(path).toLowerCase()];

  if (!mimeType) {
    console.error(red(`Unsupported file type: ${path}`));
    console.error("Supported: .pdf, .png, .jpg");
    process.exit(1);
  }

  if (env.ANTHROPIC_API_KEY === undefined) {
    console.error(red("ANTHROPIC_API_KEY is not set."));
    console.error("Add it to .env.local (see .env.example), then run this again.");
    process.exit(1);
  }

  const bytes = await readFile(path);
  const schemaSize = JSON.stringify(buildOutputSchema()).length;

  console.log(bold("\nConfiguration"));
  console.log(`  model        ${EXTRACTION_MODEL}`);
  console.log(`  effort       ${EXTRACTION_EFFORT}`);
  console.log(`  max tokens   ${env.EXTRACTION_MAX_TOKENS.toLocaleString()}`);
  console.log(`  budget       ${(env.EXTRACTION_BUDGET_MS / 1000).toFixed(0)}s`);
  console.log(`  document     ${basename(path)} (${(bytes.length / 1024).toFixed(0)} KB, ${mimeType})`);
  console.log(`  schema       ${schemaSize.toLocaleString()} bytes`);

  console.log(bold("\nCalling Claude…"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.EXTRACTION_BUDGET_MS);
  const startedAt = Date.now();

  let completion;
  try {
    completion = await completeWithClaude({ bytes, mimeType }, controller.signal);
  } catch (err) {
    clearTimeout(timer);
    const error = err instanceof ExtractionError ? err : classifyError(err);
    console.log(`  ${red("FAILED")} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    console.log(`\n  code       ${error.code} (${error.retryable ? "retryable" : "permanent"})`);
    console.log(`  message    ${error.userMessage}`);
    if (error.detail) console.log(`  detail     ${error.detail.slice(0, 400)}`);
    if (error.code === "INVALID_REQUEST") {
      console.log(
        red("\n  A 400 here most likely means the API rejected the generated JSON Schema."),
      );
      console.log("  Check src/lib/extraction/schema.ts → UNSUPPORTED_KEYWORDS.");
    }
    process.exit(1);
  }
  clearTimeout(timer);

  const elapsed = (Date.now() - startedAt) / 1000;
  const rate = priceFor(completion.model) ?? priceFor(EXTRACTION_MODEL);
  const cost = rate
    ? (completion.inputTokens / 1_000_000) * rate.input +
      (completion.outputTokens / 1_000_000) * rate.output
    : null;

  console.log(`  ${green("OK")} in ${elapsed.toFixed(1)}s`);
  console.log(`\n  input      ${completion.inputTokens.toLocaleString()} tokens`);
  console.log(`  output     ${completion.outputTokens.toLocaleString()} tokens`);
  console.log(
    cost === null
      ? `  cost       ${dim(`unknown — no price on file for ${completion.model}`)}`
      : `  cost       ~$${cost.toFixed(4)} ${dim(`(${completion.model} list pricing, this document)`)}`,
  );
  if (elapsed > env.EXTRACTION_BUDGET_MS / 1000 / 2) {
    console.log(
      red(`  ⚠ used ${((elapsed * 1000) / env.EXTRACTION_BUDGET_MS * 100).toFixed(0)}% of the budget — a longer document may time out`),
    );
  }

  console.log(bold("\nValidating response"));
  let parsed;
  try {
    parsed = parseExtraction(completion.text);
    console.log(`  ${green("OK")} response matches the extraction schema`);
  } catch (err) {
    const error = err instanceof ExtractionError ? err : classifyError(err);
    console.log(`  ${red("FAILED")} ${error.detail ?? error.message}`);
    console.log(dim(`\n  raw response (first 600 chars):\n  ${completion.text.slice(0, 600)}`));
    process.exit(1);
  }

  const { issues, confidence } = validateExtraction(parsed);

  console.log(bold("\nExtracted"));
  console.log(`  vendor       ${parsed.vendor_name ?? dim("(null)")}`);
  console.log(`  document     ${parsed.document_type} ${parsed.invoice_number ?? ""}`);
  console.log(`  issued       ${parsed.issue_date ?? dim("(null)")}   due ${parsed.due_date ?? dim("(null)")}`);
  console.log(`  currency     ${parsed.currency ?? dim("(null)")}`);
  console.log(`  subtotal     ${parsed.subtotal ?? dim("(null)")}`);
  console.log(`  tax          ${parsed.tax_amount ?? dim("(null)")}`);
  console.log(`  total        ${parsed.total_amount ?? dim("(null)")}`);
  console.log(`  line items   ${parsed.line_items.length}`);
  for (const item of parsed.line_items) {
    console.log(
      dim(`    ${String(item.line_number).padStart(2)}. ${item.description.slice(0, 46).padEnd(48)} ${String(item.quantity).padStart(5)} × ${String(item.unit_price ?? "—").padStart(8)} = ${String(item.line_total).padStart(9)}`),
    );
  }

  const lineSum = parsed.line_items.reduce((s, i) => s + i.line_total, 0);
  console.log(bold("\nReconciliation"));
  console.log(`  line items sum to  ${lineSum.toFixed(2)}`);
  console.log(`  printed subtotal   ${parsed.subtotal?.toFixed(2) ?? "(null)"}`);

  console.log(bold("\nFlags"));
  if (issues.length === 0) {
    console.log(`  ${green("none")} — document is clean`);
  } else {
    for (const issue of issues) {
      const tag = issue.severity === "conflict" ? red("conflict") : "check   ";
      console.log(`  ${tag}  ${issue.field}: ${issue.message}`);
    }
  }

  console.log(bold("\nModel-reported uncertainty"));
  const entries = Object.entries(confidence);
  if (entries.length === 0) {
    console.log(`  none${dim("  (expected for a clean document)")}`);
  } else {
    for (const [field, value] of entries) console.log(`  ${field}: ${value.toFixed(2)}`);
  }

  console.log(green(bold("\n✓ Live extraction works end to end.\n")));
}

main().catch((err) => {
  console.error(red("\ncheck crashed:"), err);
  process.exit(1);
});
