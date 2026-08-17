/**
 * Regenerates db/seed.sql from REAL Claude extractions.
 *
 *   npm run seed:live
 *
 * ⚠️ Spends money — one API call per sample. Run it when the samples or the
 * prompt change, not routinely.
 *
 * Why this exists: the demo previously shipped hand-written extraction rows.
 * For a demo whose entire claim is extraction accuracy, showing fabricated
 * model output is the wrong thing to put in front of a client — the numbers
 * would be mine, not Claude's. This runs the real pipeline once and freezes the
 * result, so `npm run db:seed` stays free and reproducible afterwards.
 *
 * Document IDs are fixed so the test suites that reference them keep working.
 */

import { readFile, writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { documents, extractions, users } from "../src/lib/db/schema";
import { completeWithClaude, EXTRACTION_MODEL } from "../src/lib/extraction/client";
import { runExtraction } from "../src/lib/extraction/run";
import { storage, buildStorageKey } from "../src/lib/storage";

const DEMO_USER = "00000000-0000-4000-8000-000000000001";
const PRICE = { "claude-sonnet-5": { input: 2, output: 10 }, "claude-opus-5": { input: 5, output: 25 } } as Record<string, { input: number; output: number }>;

const SAMPLES = [
  // Seeded as approved: a human approving a clean document is a real action,
  // and without it the Approved filter chip reads 0 in the demo.
  { id: "10000000-0000-4000-8000-000000000001", file: "sample-01-clean-invoice.pdf", note: "clean invoice — should reconcile, no flags", approve: true },
  { id: "10000000-0000-4000-8000-000000000002", file: "sample-02-mismatch-invoice.pdf", note: "line items disagree with printed subtotal" },
  { id: "10000000-0000-4000-8000-000000000003", file: "sample-03-receipt.pdf", note: "receipt — service charge, no VAT" },
  { id: "10000000-0000-4000-8000-000000000004", file: "sample-04-logistics-invoice.pdf", note: "USD, discount + insurance, no due date" },
] as Array<{ id: string; file: string; note: string; approve?: boolean }>;

/** Kept fabricated on purpose: it represents a failure, not model output. */
const FAILED_DOC = {
  id: "10000000-0000-4000-8000-000000000005",
  filename: "scan_20260817_1042.jpg",
  storagePath: "samples/sample-03-receipt.pdf",
  errorCode: "SCHEMA_INVALID",
  errorMessage:
    "The model's response did not match the extraction schema after 3 attempts. The scan may be too low-contrast to read.",
};

const q = (v: string | null): string => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);
const j = (v: unknown): string => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;

async function main(): Promise<void> {
  console.log(`\n\x1b[1mRe-extracting ${SAMPLES.length} samples with ${EXTRACTION_MODEL}\x1b[0m`);
  console.log(`\x1b[2m  estimated cost ~$${(SAMPLES.length * 0.009).toFixed(3)}\x1b[0m\n`);

  // Fresh slate for the demo user so re-runs are idempotent.
  await db.delete(documents).where(eq(documents.userId, DEMO_USER));

  let totalCost = 0;
  const rows: Array<{ doc: typeof documents.$inferSelect; ext: typeof extractions.$inferSelect }> = [];

  for (const sample of SAMPLES) {
    const bytes = await readFile(`samples/${sample.file}`);
    const storagePath = buildStorageKey(sample.id, sample.file);
    await storage.put(storagePath, bytes);

    await db.insert(documents).values({
      id: sample.id,
      userId: DEMO_USER,
      filename: sample.file,
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      storagePath,
      status: "queued",
    });

    process.stdout.write(`  ${sample.file.padEnd(34)} `);
    const started = Date.now();
    const outcome = await runExtraction(sample.id, DEMO_USER, { complete: completeWithClaude });

    if (outcome?.status !== "extracted") {
      console.log(`\x1b[31mFAILED\x1b[0m ${JSON.stringify(outcome)}`);
      process.exit(1);
    }

    const [row] = await db
      .select({ doc: documents, ext: extractions })
      .from(documents)
      .innerJoin(extractions, eq(extractions.documentId, documents.id))
      .where(eq(documents.id, sample.id));
    if (!row) throw new Error("no extraction row");

    const rate = PRICE[row.ext.model ?? ""] ?? PRICE["claude-sonnet-5"]!;
    const cost = ((row.ext.inputTokens ?? 0) / 1e6) * rate.input + ((row.ext.outputTokens ?? 0) / 1e6) * rate.output;
    totalCost += cost;

    const flags = row.ext.validationIssues.length;
    console.log(
      `\x1b[32mOK\x1b[0m ${((Date.now() - started) / 1000).toFixed(1)}s  $${cost.toFixed(4)}  ` +
        `${row.ext.data.vendor_name ?? "?"} · ${row.ext.data.currency ?? "?"} ${row.ext.data.total_amount ?? "?"} · ` +
        `${row.ext.data.line_items.length} items · ${flags} flag${flags === 1 ? "" : "s"}`,
    );
    rows.push(row);
  }

  console.log(`\n\x1b[1m  total spent: $${totalCost.toFixed(4)}\x1b[0m`);

  // ---------------------------------------------------------------- emit SQL
  const parts: string[] = [
    "-- seed.sql — demo account + sample documents.",
    "--",
    "-- ⚠️ GENERATED by `npm run seed:live`. Do not hand-edit the extraction rows:",
    "--    they are real Claude output, captured so the demo shows genuine",
    "--    extraction accuracy rather than numbers someone typed. Regenerate with",
    "--    seed:live if the samples or the prompt change.",
    "--",
    `-- Model: ${rows[0]?.ext.model ?? "?"}   Captured: ${new Date().toISOString().slice(0, 10)}`,
    "--",
    "-- Demo login: demo@trueline.app — use the one-click button; the password",
    "-- lives in .env.local as DEMO_PASSWORD and is never sent to the browser.",
    "--",
    "-- Idempotent: deleting the user cascades to documents and extractions.",
    "-- No BEGIN/COMMIT: migrate.mjs wraps this. By hand: psql -1 -f.",
    "",
    "DELETE FROM users WHERE email = 'demo@trueline.app';",
    "",
    "INSERT INTO users (id, email, password_hash) VALUES (",
    `  '${DEMO_USER}',`,
    "  'demo@trueline.app',",
    `  ${q((await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, DEMO_USER)))[0]?.h ?? "")}`,
    ");",
    "",
  ];

  rows.forEach(({ doc, ext }, index) => {
    const sample = SAMPLES[index]!;
    parts.push(
      `-- ${index + 1}. ${ext.data.vendor_name ?? doc.filename} — ${sample.note}`,
      `--    ${ext.validationIssues.length === 0 ? "no flags" : ext.validationIssues.map((i) => `${i.severity}: ${i.field}`).join("; ")}`,
      "INSERT INTO documents (id, user_id, filename, mime_type, size_bytes, page_count, storage_path, status, attempts, created_at)",
      "VALUES (",
      `  '${doc.id}', '${DEMO_USER}',`,
      `  ${q(doc.filename)}, 'application/pdf', ${doc.sizeBytes}, 1,`,
      `  ${q(doc.storagePath)}, ${q(sample.approve ? "approved" : doc.status)}, ${doc.attempts}, now() - interval '${SAMPLES.length - index} days'`,
      ");",
      "",
      "INSERT INTO extractions (id, document_id, data, confidence, validation_issues, model, effort, input_tokens, output_tokens, created_at)",
      "VALUES (",
      `  '${ext.id}', '${doc.id}',`,
      `  ${j(ext.data)},`,
      `  ${j(ext.confidence)},`,
      `  ${j(ext.validationIssues)},`,
      `  ${q(ext.model)}, ${q(ext.effort)}, ${ext.inputTokens}, ${ext.outputTokens}, now() - interval '${SAMPLES.length - index} days'`,
      ");",
      "",
    );
  });

  parts.push(
    "-- 5. Failed extraction — no extraction row, error reason on the document.",
    "--    Deliberately fabricated: it represents a failure state, not model output.",
    "INSERT INTO documents (id, user_id, filename, mime_type, size_bytes, page_count, storage_path, status, attempts, error_code, error_message, created_at)",
    "VALUES (",
    `  '${FAILED_DOC.id}', '${DEMO_USER}',`,
    `  ${q(FAILED_DOC.filename)}, 'image/jpeg', 3984588, 1,`,
    `  ${q(FAILED_DOC.storagePath)}, 'failed', 3,`,
    `  ${q(FAILED_DOC.errorCode)},`,
    `  ${q(FAILED_DOC.errorMessage)},`,
    "  now() - interval '2 hours'",
    ");",
    "",
  );

  await writeFile("db/seed.sql", parts.join("\n"));
  console.log(`\x1b[32m  wrote db/seed.sql from live output\x1b[0m\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("failed:", err);
  process.exit(1);
});
