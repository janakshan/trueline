/**
 * Happy path, end to end: upload → extract → review → export.
 *
 *   npm run test:integration      (needs the dev server running)
 *
 * Every step is a real HTTP request against the running app except the Claude
 * call, which is injected. Extraction runs through `runExtraction` — the same
 * function the route calls — with a fake completion, so the parse, validate and
 * persist stages are the real ones.
 *
 * ⚠️ The one seam this does not cross is the single line inside
 * `/api/documents/[id]/extract` that invokes `runExtraction`. Covering it would
 * need a test-only hook in production code, which is a worse trade than a
 * documented gap.
 */

import { readFile } from "node:fs/promises";
import { runExtraction } from "../src/lib/extraction/run";
import type { CompletionFn } from "../src/lib/extraction/client";

const BASE = process.env.BASE ?? "http://localhost:3111";
const DEMO_USER = "00000000-0000-4000-8000-000000000001";
const SAMPLE = "samples/sample-02-mismatch-invoice.pdf";

let pass = 0;
let fail = 0;
let cookie = "";

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function step(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Cookie: cookie },
  });
}

/** What the model returns for the mismatch invoice: printed subtotal, not corrected. */
const MODEL_RESPONSE = JSON.stringify({
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
    { line_number: 1, description: "Consulting - Q2 discovery workshop", quantity: 1, unit_price: 850, line_total: 850 },
    { line_number: 2, description: "Technical documentation package", quantity: 1, unit_price: 390, line_total: 390 },
  ],
  uncertain_fields: [],
});

const fakeClaude: CompletionFn = async () => ({
  text: MODEL_RESPONSE,
  model: "fake-model",
  effort: "test",
  inputTokens: 2000,
  outputTokens: 450,
});

async function main(): Promise<void> {
  // ---------------------------------------------------------------- sign in
  step("Sign in (one-click demo)");
  const signIn = await fetch(`${BASE}/api/auth/demo`, { method: "POST" });
  const setCookie = signIn.headers.get("set-cookie") ?? "";
  cookie = setCookie.split(";")[0] ?? "";
  check("demo login returns 200", signIn.status === 200, `got ${signIn.status}`);
  check("session cookie issued", cookie.startsWith("trueline_session="));

  // ----------------------------------------------------------------- upload
  step("Upload");
  const bytes = await readFile(SAMPLE);
  const form = new FormData();
  form.append("file", new File([bytes], "integration-test.pdf", { type: "application/pdf" }));

  const upload = await api("/api/documents", { method: "POST", body: form });
  check("upload returns 201", upload.status === 201, `got ${upload.status}`);

  const uploaded = (await upload.json()) as { data: { id: string; status: string; vendorName: string | null } };
  const id = uploaded.data.id;
  check("document is queued", uploaded.data.status === "queued", uploaded.data.status);
  check("no extraction data yet", uploaded.data.vendorName === null);

  // ---------------------------------------------------------------- extract
  step("Extract (Claude mocked)");
  const outcome = await runExtraction(id, DEMO_USER, {
    complete: fakeClaude,
    readFile: async () => bytes,
  });
  check("extraction succeeds", outcome?.status === "extracted", JSON.stringify(outcome));
  check(
    "one validation issue raised",
    outcome?.status === "extracted" && outcome.issueCount === 1,
    outcome?.status === "extracted" ? String(outcome.issueCount) : "",
  );

  const afterExtract = await api(`/api/documents/${id}`);
  const detail = (await afterExtract.json()) as {
    data: {
      status: string;
      vendorName: string;
      totalAmount: number;
      flagCount: number;
      extraction: { data: { subtotal: number }; validationIssues: Array<{ field: string; severity: string; message: string }> };
    };
  };
  check("status is needs_review", detail.data.status === "needs_review", detail.data.status);
  check("vendor extracted", detail.data.vendorName === "Acme Corp", detail.data.vendorName);
  check("total extracted", detail.data.totalAmount === 1704, String(detail.data.totalAmount));
  check(
    "printed subtotal stored verbatim, not corrected",
    detail.data.extraction.data.subtotal === 1420,
    String(detail.data.extraction.data.subtotal),
  );
  check(
    "reconciliation conflict raised with an actionable message",
    detail.data.extraction.validationIssues[0]?.severity === "conflict" &&
      detail.data.extraction.validationIssues[0].message.includes("180.00 difference"),
    detail.data.extraction.validationIssues[0]?.message,
  );

  // ----------------------------------------------------------------- review
  step("Review — correct the subtotal");
  const patch = await api(`/api/documents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { subtotal: 1240 } }),
  });
  check("patch returns 200", patch.status === 200, `got ${patch.status}`);

  const reviewed = (await patch.json()) as {
    data: {
      extraction: {
        reviewedFields: string[];
        validationIssues: Array<{ field: string; message: string }>;
      };
    };
  };
  check(
    "subtotal marked as human-reviewed",
    reviewed.data.extraction.reviewedFields.includes("subtotal"),
    JSON.stringify(reviewed.data.extraction.reviewedFields),
  );
  check(
    "subtotal conflict cleared",
    !reviewed.data.extraction.validationIssues.some((i) => i.field === "subtotal"),
  );
  check(
    "downstream total conflict now surfaces (1240+284 != 1704)",
    reviewed.data.extraction.validationIssues.some((i) => i.field === "total_amount"),
    JSON.stringify(reviewed.data.extraction.validationIssues.map((i) => i.field)),
  );

  step("Review — approve");
  const approve = await api(`/api/documents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "approved" }),
  });
  const approved = (await approve.json()) as { data: { status: string } };
  check("status is approved", approved.data.status === "approved", approved.data.status);

  // ----------------------------------------------------------------- export
  step("Export");
  const perDoc = await api(`/api/export?scope=selected&ids=${id}&granularity=document`);
  check("document CSV returns 200", perDoc.status === 200, `got ${perDoc.status}`);
  check(
    "content-disposition triggers a download",
    (perDoc.headers.get("content-disposition") ?? "").includes("attachment"),
  );

  // Checked as raw bytes, not decoded text: fetch's text() strips a leading
  // BOM per the WHATWG spec, so a string-level assertion here always fails
  // even when the bytes are correct.
  const docBytes = new Uint8Array(await perDoc.clone().arrayBuffer());
  check(
    "UTF-8 BOM present on the wire (Excel)",
    docBytes[0] === 0xef && docBytes[1] === 0xbb && docBytes[2] === 0xbf,
    [...docBytes.slice(0, 3)].map((b) => b.toString(16)).join(" "),
  );

  const docCsv = await perDoc.text();
  const docLines = docCsv.trim().split("\r\n");
  check("one header + one row", docLines.length === 2, `${docLines.length} lines`);
  check("edited subtotal is in the export", docLines[1]?.includes("1240") === true, docLines[1]);
  check("service_charge column present", docLines[0]?.includes("service_charge") === true);

  const perItem = await api(`/api/export?scope=selected&ids=${id}&granularity=line_item`);
  const itemCsv = (await perItem.text()).trim().split("\r\n");
  check("line-item CSV has one row per item", itemCsv.length === 3, `${itemCsv.length} lines`);
  check("line item descriptions present", itemCsv[1]?.includes("Consulting") === true, itemCsv[1]);

  // ---------------------------------------------------------------- cleanup
  step("Cleanup");
  const del = await api(`/api/documents/${id}`, { method: "DELETE" });
  check("delete returns 200", del.status === 200, `got ${del.status}`);
  const gone = await api(`/api/documents/${id}`);
  check("document is gone", gone.status === 404, `got ${gone.status}`);

  console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("harness crashed:", err);
  process.exit(1);
});
