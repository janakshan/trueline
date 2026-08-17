/**
 * Extraction pipeline tests.
 *
 *   export DATABASE_URL=... SESSION_SECRET=...
 *   npm run db:seed
 *   npx tsx scripts/test-extraction.ts
 *
 * The Claude call is injected, so everything except the network hop is
 * exercised: defensive parsing, the repair retry, the failure taxonomy, the
 * arithmetic checks, and the transactional writes. The fakes return what a
 * model plausibly returns for the three sample PDFs, including the ways it
 * plausibly goes wrong.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { documents, extractions } from "../src/lib/db/schema";
import type { CompletionFn, CompletionResult } from "../src/lib/extraction/client";
import { parseExtraction, coerceNumber } from "../src/lib/extraction/parse";
import { runExtraction } from "../src/lib/extraction/run";
import { buildOutputSchema } from "../src/lib/extraction/schema";
import { validateExtraction } from "../src/lib/extraction/validate";

const DEMO_USER = "00000000-0000-4000-8000-000000000001";

let pass = 0;
let fail = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/** A model response for sample 1: everything reconciles. */
const CLEAN_RESPONSE = JSON.stringify({
  document_type: "invoice",
  vendor_name: "Harbourline Print Co.",
  vendor_address: "Unit 7, Riverside Works, Bristol BS1 6QT, United Kingdom",
  vendor_tax_id: "GB 418 2290 55",
  invoice_number: "HL-2026-0431",
  issue_date: "2026-08-14",
  due_date: "2026-09-13",
  currency: "GBP",
  subtotal: 753.0,
  tax_amount: 150.6,
  tax_rate: 20,
  shipping_amount: 12.5,
  service_charge: null,
  discount_amount: null,
  total_amount: 916.1,
  payment_method: null,
  line_items: [
    { line_number: 1, description: "A5 saddle-stitched brochures, 250gsm", quantity: 500, unit_price: 0.84, line_total: 420.0 },
    { line_number: 2, description: "Business cards, matt laminate (box of 250)", quantity: 4, unit_price: 18.5, line_total: 74.0 },
    { line_number: 3, description: "Roll-up banner, 850mm x 2000mm", quantity: 2, unit_price: 62.0, line_total: 124.0 },
    { line_number: 4, description: "Artwork amends (hourly)", quantity: 3, unit_price: 45.0, line_total: 135.0 },
  ],
  uncertain_fields: [],
});

/** Sample 2: model transcribes the printed subtotal rather than fixing it. */
const MISMATCH_RESPONSE = JSON.stringify({
  document_type: "invoice",
  vendor_name: "Acme Corp",
  vendor_address: "88 Union Street, Manchester M1 2AB, United Kingdom",
  vendor_tax_id: "GB331902847",
  invoice_number: "AC-2026-0814",
  issue_date: "2026-08-14",
  due_date: "2026-09-13",
  currency: "GBP",
  subtotal: 1420.0,
  tax_amount: 284.0,
  tax_rate: 20,
  shipping_amount: null,
  service_charge: null,
  discount_amount: null,
  total_amount: 1704.0,
  payment_method: null,
  line_items: [
    { line_number: 1, description: "Consulting - Q2 discovery workshop", quantity: 1, unit_price: 850.0, line_total: 850.0 },
    { line_number: 2, description: "Technical documentation package", quantity: 1, unit_price: 390.0, line_total: 390.0 },
  ],
  uncertain_fields: [],
});

/** Sample 3: receipt, ambiguous date left null, messy string numbers. */
const RECEIPT_RESPONSE = JSON.stringify({
  document_type: "receipt",
  vendor_name: "Blue Ridge Coffee",
  vendor_address: "14 Mill Lane, Sheffield S1 4RG",
  vendor_tax_id: null,
  invoice_number: "0004821",
  issue_date: null,
  due_date: null,
  currency: "GBP",
  subtotal: "14.30",
  tax_amount: null,
  tax_rate: null,
  shipping_amount: null,
  service_charge: null,
  discount_amount: null,
  total_amount: "15.52",
  payment_method: "Visa ending 4412",
  line_items: [
    { line_number: 1, description: "Flat white", quantity: 2, unit_price: "4.20", line_total: "8.40" },
    { line_number: 2, description: "Almond croissant", quantity: 1, unit_price: "3.80", line_total: "3.80" },
    { line_number: 3, description: "Sparkling water 330ml", quantity: 1, unit_price: "2.10", line_total: "2.10" },
  ],
  uncertain_fields: [
    { field: "issue_date", confidence: 0.35, reason: "The date reads 03/04/2026 and the document gives no clue whether it is day-first or month-first." },
    { field: "vendor_tax_id", confidence: 0.6, reason: "No tax registration number appears anywhere on the receipt." },
  ],
});

function fakeCompletion(
  responses: string[],
  log: { calls: Array<{ repairHint?: string; maxTokens?: number }> },
): CompletionFn {
  let index = 0;
  return async (request): Promise<CompletionResult> => {
    log.calls.push({
      ...(request.repairHint !== undefined ? { repairHint: request.repairHint } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    });
    const text = responses[Math.min(index, responses.length - 1)] ?? "";
    index += 1;
    if (text.startsWith("__THROW__")) {
      const err = new Error(text.slice(9)) as Error & { status?: number };
      const status = Number(text.slice(9));
      if (Number.isFinite(status)) err.status = status;
      throw err;
    }
    return { text, model: "claude-opus-5", effort: "medium", inputTokens: 9000, outputTokens: 1200 };
  };
}

async function makeDocument(filename: string, storagePath: string): Promise<string> {
  const id = randomUUID();
  await db.insert(documents).values({
    id,
    userId: DEMO_USER,
    filename,
    mimeType: "application/pdf",
    sizeBytes: 2968,
    storagePath,
    status: "queued",
  });
  return id;
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- schema
  section("JSON Schema generation");
  const jsonSchema = buildOutputSchema() as Record<string, unknown>;
  check("schema is an object type", jsonSchema.type === "object");
  check(
    "additionalProperties is false (required by structured outputs)",
    jsonSchema.additionalProperties === false,
  );
  const required = jsonSchema.required as string[] | undefined;
  check("all 18 fields are required", required?.length === 18, `got ${required?.length}`);
  const serialised = JSON.stringify(jsonSchema);
  check(
    "no unsupported constraints leaked into the schema",
    !/"(minimum|maximum|minLength|maxLength|multipleOf)"/.test(serialised),
  );
  check("field descriptions travel with the schema", serialised.includes("Do not compute"));

  // ------------------------------------------------------ defensive parsing
  section("Defensive parsing");
  check("clean response parses", parseExtraction(CLEAN_RESPONSE).vendor_name === "Harbourline Print Co.");

  const fenced = parseExtraction("```json\n" + CLEAN_RESPONSE + "\n```");
  check("markdown-fenced response parses", fenced.total_amount === 916.1);

  const chatty = parseExtraction(`Here is the data you asked for:\n${CLEAN_RESPONSE}\nLet me know if you need anything else.`);
  check("response wrapped in prose parses", chatty.total_amount === 916.1);

  const receipt = parseExtraction(RECEIPT_RESPONSE);
  check("string numbers coerce to numbers", receipt.subtotal === 14.3 && typeof receipt.subtotal === "number");
  check("string line totals coerce", receipt.line_items[0]?.line_total === 8.4);

  check("comma thousands separators coerce", coerceNumber("1,420.00") === 1420);
  check("currency symbols strip", coerceNumber("£1,240.50") === 1240.5);
  check("accounting negatives coerce", coerceNumber("(180.00)") === -180);
  check("n/a becomes null", coerceNumber("n/a") === null);
  check("empty string becomes null", coerceNumber("") === null);
  check("unparseable text is rejected, not silently nulled", coerceNumber("about four") === undefined);
  // Regression: letter-stripping used to turn "1.5e3" into 1.53 silently.
  check("scientific notation is not corrupted", coerceNumber("1.5e3") === 1500, String(coerceNumber("1.5e3")));
  check("exponent with sign parses", coerceNumber("7.5305e+2") === 753.05, String(coerceNumber("7.5305e+2")));
  check("leading currency code strips", coerceNumber("USD 1,240.00") === 1240);
  check("trailing currency code strips", coerceNumber("1,240.00 GBP") === 1240);
  check("letters mid-number are rejected", coerceNumber("12abc34") === undefined);

  const negativeDiscount = parseExtraction(
    JSON.stringify({ ...JSON.parse(CLEAN_RESPONSE), discount_amount: -25 }),
  );
  check("negative discount normalises to positive", negativeDiscount.discount_amount === 25);

  const noQuantity = parseExtraction(
    JSON.stringify({
      ...JSON.parse(CLEAN_RESPONSE),
      line_items: [{ line_number: 1, description: "Thing", unit_price: 5, line_total: 5 }],
    }),
  );
  check("missing quantity defaults to 1", noQuantity.line_items[0]?.quantity === 1);

  let hint = "";
  try {
    parseExtraction("I could not read this document, sorry.");
  } catch (err) {
    hint = (err as { detail?: string }).detail ?? "";
  }
  check("non-JSON output is rejected", hint.includes("not valid JSON"), hint);

  hint = "";
  try {
    parseExtraction(JSON.stringify({ ...JSON.parse(CLEAN_RESPONSE), total_amount: "about four hundred" }));
  } catch (err) {
    hint = (err as { detail?: string }).detail ?? "";
  }
  check("wrong-typed field is rejected", hint.includes("total_amount"), hint);
  check("repair hint names the offending path", /total_amount/.test(hint) && hint.includes("Fix these fields"));

  // ---- adversarial: what a real model plausibly emits when it goes wrong ----
  section("Defensive parsing — adversarial cases");

  const base = JSON.parse(CLEAN_RESPONSE) as Record<string, unknown>;
  const mangle = (patch: Record<string, unknown>) => JSON.stringify({ ...base, ...patch });

  function rejects(label: string, raw: string, expectInHint = ""): void {
    try {
      parseExtraction(raw);
      check(label, false, "was accepted");
    } catch (err) {
      const detail = (err as { detail?: string }).detail ?? "";
      check(label, expectInHint === "" || detail.includes(expectInHint), detail.slice(0, 90));
    }
  }

  function accepts(label: string, raw: string, assertion: (r: ReturnType<typeof parseExtraction>) => boolean): void {
    try {
      check(label, assertion(parseExtraction(raw)));
    } catch (err) {
      check(label, false, String((err as Error).message).slice(0, 90));
    }
  }

  // Truncation is the single most likely malformation: the model hits a token
  // cap mid-object and the JSON simply stops.
  rejects("truncated mid-object is rejected", CLEAN_RESPONSE.slice(0, CLEAN_RESPONSE.length - 40), "not valid JSON");
  rejects("empty string is rejected", "", "not valid JSON");
  rejects("whitespace only is rejected", "   \n  ", "not valid JSON");
  rejects("a bare array is rejected", "[1,2,3]");
  rejects("a JSON scalar is rejected", '"just a string"');
  rejects("trailing comma is rejected", CLEAN_RESPONSE.replace("}", ",}"), "not valid JSON");
  rejects("NaN literal is rejected", mangle({ subtotal: 0 }).replace("\"subtotal\":0", "\"subtotal\":NaN"), "not valid JSON");
  rejects("line_items as an object is rejected", mangle({ line_items: { a: 1 } }), "line_items");
  rejects("null document_type is rejected", mangle({ document_type: null }), "document_type");
  rejects("unknown document_type is rejected", mangle({ document_type: "purchase_order" }), "document_type");
  rejects("line item missing description is rejected",
    mangle({ line_items: [{ line_number: 1, quantity: 1, unit_price: 1, line_total: 1 }] }), "description");

  // Things that look wrong but are recoverable — rejecting these would fail
  // documents the pipeline can actually handle.
  accepts("leading BOM is tolerated", "\uFEFF" + CLEAN_RESPONSE, (r) => r.total_amount === 916.1);
  accepts("scientific notation coerces", mangle({ subtotal: "7.5305e2" }), (r) => r.subtotal === 753.05);
  // Raw \uXXXX escapes as a model would emit them in the JSON text itself.
  accepts(
    "unicode escapes decode",
    CLEAN_RESPONSE.replace('"Harbourline Print Co."', '"Caf\\u00e9 R\\u00f6sti Ltd"'),
    (r) => r.vendor_name === "Café Rösti Ltd",
  );
  accepts("unexpected extra field is ignored", mangle({ invented_field: "ignore me" }), (r) => r.vendor_name === "Harbourline Print Co.");
  accepts("empty line_items array is valid", mangle({ line_items: [] }), (r) => r.line_items.length === 0);
  accepts("negative total is preserved (credit note)", mangle({ total_amount: -50 }), (r) => r.total_amount === -50);
  accepts("very long description is not truncated",
    mangle({ line_items: [{ line_number: 1, description: "x".repeat(2000), quantity: 1, unit_price: null, line_total: 1 }] }),
    (r) => r.line_items[0]?.description.length === 2000);

  // ------------------------------------------------------------- validation
  section("Validation (arithmetic is the load-bearing signal)");
  const cleanOutcome = validateExtraction(parseExtraction(CLEAN_RESPONSE));
  check("clean invoice raises no issues", cleanOutcome.issues.length === 0, JSON.stringify(cleanOutcome.issues));

  const mismatchOutcome = validateExtraction(parseExtraction(MISMATCH_RESPONSE));
  const subtotalIssue = mismatchOutcome.issues.find((i) => i.field === "subtotal");
  check("mismatch is detected", subtotalIssue !== undefined);
  check("mismatch is a conflict, not a soft check", subtotalIssue?.severity === "conflict");
  check(
    "message states both figures and the difference",
    subtotalIssue?.message === "Line items total 1,240.00 but subtotal reads 1,420.00 — 180.00 difference",
    subtotalIssue?.message,
  );

  const receiptOutcome = validateExtraction(receipt);
  check("model uncertainty becomes per-field confidence", receiptOutcome.confidence.issue_date === 0.35);
  const dateIssue = receiptOutcome.issues.find((i) => i.field === "issue_date");
  check(
    "low confidence raises a check issue carrying the model's reason",
    dateIssue?.severity === "check" && dateIssue.message.includes("day-first or month-first"),
    dateIssue?.message,
  );
  check(
    "confidence above threshold does not raise an issue",
    receiptOutcome.confidence.vendor_tax_id === 0.6 &&
      receiptOutcome.issues.filter((i) => i.field === "vendor_tax_id").length === 1,
  );
  check("receipt is not required to have a due date", !receiptOutcome.issues.some((i) => i.field === "due_date"));

  const missingDue = validateExtraction(
    parseExtraction(JSON.stringify({ ...JSON.parse(CLEAN_RESPONSE), due_date: null })),
  );
  check("invoice without a due date is flagged", missingDue.issues.some((i) => i.field === "due_date" && i.severity === "conflict"));

  const badDate = validateExtraction(
    parseExtraction(JSON.stringify({ ...JSON.parse(CLEAN_RESPONSE), issue_date: "17/08/2026" })),
  );
  check("non-ISO date is flagged, not coerced", badDate.issues.some((i) => i.field === "issue_date" && i.severity === "conflict"));

  const badCurrency = validateExtraction(
    parseExtraction(JSON.stringify({ ...JSON.parse(CLEAN_RESPONSE), currency: "pounds" })),
  );
  check("non-ISO currency is flagged", badCurrency.issues.some((i) => i.field === "currency"));

  const inventedField = validateExtraction(
    parseExtraction(
      JSON.stringify({
        ...JSON.parse(CLEAN_RESPONSE),
        uncertain_fields: [{ field: "nonexistent_field", confidence: 0.1, reason: "made up" }],
      }),
    ),
  );
  check("uncertainty about an unknown field is discarded", Object.keys(inventedField.confidence).length === 0);

  // -------------------------------------------------------- end-to-end runs
  section("End-to-end: sample 1 (clean invoice)");
  const doc1 = await makeDocument("sample-01-clean-invoice.pdf", "samples/sample-01-clean-invoice.pdf");
  const log1 = { calls: [] as Array<{ repairHint?: string; maxTokens?: number }> };
  const out1 = await runExtraction(doc1, DEMO_USER, {
    complete: fakeCompletion([CLEAN_RESPONSE], log1),
    readFile: async () => readFile("samples/sample-01-clean-invoice.pdf"),
  });
  check("run reports extracted", out1?.status === "extracted");
  check("one model call was made", log1.calls.length === 1);
  const [row1] = await db.select().from(documents).where(eq(documents.id, doc1));
  check("document moves to needs_review", row1?.status === "needs_review");
  check("processing claim is cleared", row1?.processingStartedAt === null);
  const [ext1] = await db.select().from(extractions).where(eq(extractions.documentId, doc1));
  check("extraction row written", ext1 !== undefined);
  check("generated column derived vendor from JSONB", ext1?.vendorName === "Harbourline Print Co.");
  check("generated column derived total", Number(ext1?.totalAmount) === 916.1);
  check("no validation issues stored", ext1?.validationIssues.length === 0);
  check("uncertain_fields is not persisted into data", !("uncertain_fields" in (ext1?.data ?? {})));
  check("raw response retained for debugging", (ext1?.rawResponse?.length ?? 0) > 0);

  section("End-to-end: sample 2 (arithmetic mismatch — the demo case)");
  const doc2 = await makeDocument("sample-02-mismatch-invoice.pdf", "samples/sample-02-mismatch-invoice.pdf");
  const log2 = { calls: [] as Array<{ repairHint?: string; maxTokens?: number }> };
  const out2 = await runExtraction(doc2, DEMO_USER, {
    complete: fakeCompletion([MISMATCH_RESPONSE], log2),
    readFile: async () => readFile("samples/sample-02-mismatch-invoice.pdf"),
  });
  check("run reports extracted (a mismatch is not an error)", out2?.status === "extracted");
  check("one issue recorded", out2?.status === "extracted" && out2.issueCount === 1);
  const [ext2] = await db.select().from(extractions).where(eq(extractions.documentId, doc2));
  check("printed subtotal stored verbatim, not corrected", ext2?.data.subtotal === 1420);
  check("conflict persisted with an actionable message", ext2?.validationIssues[0]?.message.includes("180.00 difference") === true);

  section("End-to-end: sample 3 (receipt with uncertainty)");
  const doc3 = await makeDocument("sample-03-receipt.pdf", "samples/sample-03-receipt.pdf");
  const log3 = { calls: [] as Array<{ repairHint?: string; maxTokens?: number }> };
  const out3 = await runExtraction(doc3, DEMO_USER, {
    complete: fakeCompletion([RECEIPT_RESPONSE], log3),
    readFile: async () => readFile("samples/sample-03-receipt.pdf"),
  });
  check("run reports extracted", out3?.status === "extracted");
  const [ext3] = await db.select().from(extractions).where(eq(extractions.documentId, doc3));
  check("string numbers persisted as numbers", ext3?.data.total_amount === 15.52);
  check("per-field confidence stored", ext3?.confidence.issue_date === 0.35);
  check("ambiguous date stored as null rather than guessed", ext3?.data.issue_date === null);

  // ------------------------------------------------------------ retry paths
  section("Retry and failure taxonomy");
  const doc4 = await makeDocument("retry-recovers.pdf", "samples/sample-01-clean-invoice.pdf");
  const log4 = { calls: [] as Array<{ repairHint?: string; maxTokens?: number }> };
  const out4 = await runExtraction(doc4, DEMO_USER, {
    complete: fakeCompletion(["not json at all", CLEAN_RESPONSE], log4),
    readFile: async () => readFile("samples/sample-01-clean-invoice.pdf"),
  });
  check("malformed then valid -> succeeds", out4?.status === "extracted");
  check("exactly two calls (one repair, not a loop)", log4.calls.length === 2);
  check("repair attempt carries a corrective hint", (log4.calls[1]?.repairHint ?? "").includes("not valid JSON"));

  const doc5 = await makeDocument("retry-exhausts.pdf", "samples/sample-01-clean-invoice.pdf");
  const log5 = { calls: [] as Array<{ repairHint?: string; maxTokens?: number }> };
  const out5 = await runExtraction(doc5, DEMO_USER, {
    complete: fakeCompletion(["garbage", "still garbage"], log5),
    readFile: async () => readFile("samples/sample-01-clean-invoice.pdf"),
  });
  check("twice malformed -> failed", out5?.status === "failed");
  check("failure code is SCHEMA_INVALID", out5?.status === "failed" && out5.code === "SCHEMA_INVALID");
  check("stops after two calls", log5.calls.length === 2);
  const [row5] = await db.select().from(documents).where(eq(documents.id, doc5));
  check("document marked failed", row5?.status === "failed");
  check("error code persisted", row5?.errorCode === "SCHEMA_INVALID");
  check("error message is human-readable", (row5?.errorMessage ?? "").includes("did not match"));
  const ext5 = await db.select().from(extractions).where(eq(extractions.documentId, doc5));
  check("NO extraction row written on failure (database uncorrupted)", ext5.length === 0);

  const doc6 = await makeDocument("permanent-400.pdf", "samples/sample-01-clean-invoice.pdf");
  const log6 = { calls: [] as Array<{ repairHint?: string; maxTokens?: number }> };
  const out6 = await runExtraction(doc6, DEMO_USER, {
    complete: fakeCompletion(["__THROW__400"], log6),
    readFile: async () => readFile("samples/sample-01-clean-invoice.pdf"),
  });
  check("400 -> failed as INVALID_REQUEST", out6?.status === "failed" && out6.code === "INVALID_REQUEST");
  check("permanent failure is NOT retried", log6.calls.length === 1);

  const doc7 = await makeDocument("rate-limited.pdf", "samples/sample-01-clean-invoice.pdf");
  const log7 = { calls: [] as Array<{ repairHint?: string; maxTokens?: number }> };
  const out7 = await runExtraction(doc7, DEMO_USER, {
    complete: fakeCompletion(["__THROW__429"], log7),
    readFile: async () => readFile("samples/sample-01-clean-invoice.pdf"),
  });
  check("429 -> failed as RATE_LIMITED", out7?.status === "failed" && out7.code === "RATE_LIMITED");
  check("rate limit is not repair-retried in-process", log7.calls.length === 1);

  const log11 = { calls: [] as Array<{ repairHint?: string; maxTokens?: number }> };
  const doc11 = await makeDocument("no-credentials.pdf", "samples/sample-01-clean-invoice.pdf");
  const out11 = await runExtraction(doc11, DEMO_USER, {
    complete: fakeCompletion(["__THROW__Could not resolve authentication method. Expected one of apiKey, authToken..."], log11),
    readFile: async () => readFile("samples/sample-01-clean-invoice.pdf"),
  });
  check("missing credentials -> NOT_AUTHORISED, not UNKNOWN", out11?.status === "failed" && out11.code === "NOT_AUTHORISED", out11?.status === "failed" ? out11.code : "");
  check("credential failure is permanent, not retried", log11.calls.length === 1);

  const doc8 = await makeDocument("missing-file.pdf", "samples/does-not-exist.pdf");
  const out8 = await runExtraction(doc8, DEMO_USER, {
    complete: fakeCompletion([CLEAN_RESPONSE], { calls: [] }),
    readFile: async (key) => readFile(key),
  });
  check("unreadable file -> FILE_UNREADABLE", out8?.status === "failed" && out8.code === "FILE_UNREADABLE");

  // ------------------------------------------------------------------ claim
  section("Atomic claim");
  const doc9 = await makeDocument("claim-test.pdf", "samples/sample-01-clean-invoice.pdf");
  await db.update(documents).set({ status: "processing", processingStartedAt: new Date() }).where(eq(documents.id, doc9));
  const contended = await runExtraction(doc9, DEMO_USER, {
    complete: fakeCompletion([CLEAN_RESPONSE], { calls: [] }),
    readFile: async () => readFile("samples/sample-01-clean-invoice.pdf"),
  });
  check("in-flight document cannot be claimed twice", contended === null);

  const otherUser = await runExtraction(doc1, "00000000-0000-4000-8000-0000000000aa", {
    complete: fakeCompletion([CLEAN_RESPONSE], { calls: [] }),
    readFile: async () => readFile("samples/sample-01-clean-invoice.pdf"),
  });
  check("another user cannot claim someone else's document", otherUser === null);

  const doc10 = await makeDocument("attempts-exhausted.pdf", "samples/sample-01-clean-invoice.pdf");
  await db.update(documents).set({ status: "failed", attempts: 3, errorCode: "SCHEMA_INVALID" }).where(eq(documents.id, doc10));
  const exhausted = await runExtraction(doc10, DEMO_USER, {
    complete: fakeCompletion([CLEAN_RESPONSE], { calls: [] }),
    readFile: async () => readFile("samples/sample-01-clean-invoice.pdf"),
  });
  check("attempt cap stops automatic retries", exhausted === null);

  // --------------------------------------------------------- re-extraction
  section("Re-extraction history");
  await db.update(documents).set({ status: "queued", attempts: 0 }).where(eq(documents.id, doc1));
  await runExtraction(doc1, DEMO_USER, {
    complete: fakeCompletion([MISMATCH_RESPONSE], { calls: [] }),
    readFile: async () => readFile("samples/sample-01-clean-invoice.pdf"),
  });
  const history = await db.select().from(extractions).where(eq(extractions.documentId, doc1));
  check("previous extraction retained as history", history.length === 2);
  check("exactly one is current", history.filter((e) => e.isCurrent).length === 1);
  const current = history.find((e) => e.isCurrent);
  check("the newest is the current one", current?.data.vendor_name === "Acme Corp");

  const dupe = await db.execute(sql`
    SELECT document_id FROM extractions WHERE is_current
    GROUP BY document_id HAVING count(*) > 1
  `);
  check("no document has two current extractions (index enforced)", dupe.rows.length === 0);

  // --------------------------------------------------------------- cleanup
  // Remove only what this suite created.
  //
  // This previously kept rows by matching seed *filenames*, which silently
  // deleted the whole seed the moment those filenames changed — later suites
  // then failed with a confusing 404 on a document that clearly exists in
  // seed.sql. Seed rows all carry the fixed 10000000-… prefix; test rows get
  // random UUIDs, so the id is the stable discriminator.
  await db.delete(documents).where(
    and(eq(documents.userId, DEMO_USER), sql`id::text NOT LIKE '10000000-%'`),
  );

  console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nharness crashed:", err);
  process.exit(1);
});
