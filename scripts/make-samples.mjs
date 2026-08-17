#!/usr/bin/env node
// make-samples.mjs — generate sample invoice/receipt PDFs.
//
//   node scripts/make-samples.mjs [outDir]     (default: ./samples)
//
// Hand-rolled PDF writer rather than a dependency: these are three text-only
// pages, and pdf-lib would be ~1 MB in the tree for that. Uses Helvetica with
// WinAnsiEncoding so currency symbols render.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PAGE_W = 595;
const PAGE_H = 842;

const escapeText = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Builds a content stream from {x, y, size, bold, text} draw ops. */
function buildContent(ops) {
  const parts = ["BT"];
  for (const op of ops) {
    parts.push(`/${op.bold ? "F2" : "F1"} ${op.size} Tf`);
    parts.push(`1 0 0 1 ${op.x} ${PAGE_H - op.y} Tm`);
    parts.push(`(${escapeText(op.text)}) Tj`);
  }
  parts.push("ET");
  for (const line of ops.filter((o) => o.rule)) {
    parts.push(`0.6 w ${line.x} ${PAGE_H - line.y} m ${line.x2} ${PAGE_H - line.y} l S`);
  }
  return Buffer.from(parts.join("\n"), "latin1");
}

function buildPdf(ops) {
  const content = buildContent(ops);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      "/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    null, // content stream, spliced in below
  ];

  const chunks = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets = [];
  let position = chunks[0].length;

  objects.forEach((body, index) => {
    const number = index + 1;
    offsets.push(position);
    const chunk =
      body === null
        ? Buffer.concat([
            Buffer.from(`${number} 0 obj\n<< /Length ${content.length} >>\nstream\n`, "latin1"),
            content,
            Buffer.from("\nendstream\nendobj\n", "latin1"),
          ])
        : Buffer.from(`${number} 0 obj\n${body}\nendobj\n`, "latin1");
    chunks.push(chunk);
    position += chunk.length;
  });

  const xrefStart = position;
  const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
  for (const offset of offsets) xref.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  xref.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );

  chunks.push(Buffer.from(xref.join(""), "latin1"));
  return Buffer.concat(chunks);
}

/** Lays out a document from a small description object. */
function invoiceOps(doc) {
  const ops = [];
  let y = 60;
  const right = (text, size, yy, bold = false) =>
    ops.push({ x: 545 - text.length * size * 0.5, y: yy, size, text, bold });

  ops.push({ x: 50, y, size: 20, text: doc.vendor.name, bold: true });
  y += 18;
  for (const line of doc.vendor.address) {
    ops.push({ x: 50, y, size: 9, text: line });
    y += 12;
  }
  if (doc.vendor.taxId) {
    ops.push({ x: 50, y, size: 9, text: `VAT Reg No: ${doc.vendor.taxId}` });
    y += 12;
  }

  ops.push({ x: 400, y: 62, size: 16, text: doc.title, bold: true });
  let metaY = 86;
  for (const [label, value] of doc.meta) {
    ops.push({ x: 400, y: metaY, size: 9, text: `${label}: ${value}` });
    metaY += 13;
  }

  y = Math.max(y, metaY) + 24;
  if (doc.billTo) {
    ops.push({ x: 50, y, size: 9, text: "Bill To:", bold: true });
    y += 13;
    for (const line of doc.billTo) {
      ops.push({ x: 50, y, size: 9, text: line });
      y += 12;
    }
    y += 14;
  }

  ops.push({ x: 50, y, size: 9, text: "Description", bold: true });
  ops.push({ x: 330, y, size: 9, text: "Qty", bold: true });
  ops.push({ x: 390, y, size: 9, text: "Unit Price", bold: true });
  ops.push({ x: 490, y, size: 9, text: "Amount", bold: true });
  ops.push({ x: 50, y: y + 6, x2: 545, rule: true, size: 9, text: "" });
  y += 20;

  for (const item of doc.items) {
    ops.push({ x: 50, y, size: 9, text: item.description });
    ops.push({ x: 330, y, size: 9, text: String(item.qty) });
    ops.push({ x: 390, y, size: 9, text: item.unitPrice });
    ops.push({ x: 490, y, size: 9, text: item.amount });
    y += 16;
  }

  ops.push({ x: 50, y: y + 2, x2: 545, rule: true, size: 9, text: "" });
  y += 20;

  for (const [label, value, bold] of doc.totals) {
    ops.push({ x: 390, y, size: bold ? 11 : 9, text: label, bold: Boolean(bold) });
    right(value, bold ? 11 : 9, y, Boolean(bold));
    y += bold ? 18 : 15;
  }

  if (doc.footer) {
    y += 24;
    for (const line of doc.footer) {
      ops.push({ x: 50, y, size: 8, text: line });
      y += 11;
    }
  }
  return ops;
}

const SAMPLES = {
  // 1. Clean: line items sum to subtotal, totals reconcile.
  "sample-01-clean-invoice.pdf": {
    title: "INVOICE",
    vendor: {
      name: "Harbourline Print Co.",
      address: ["Unit 7, Riverside Works", "Bristol BS1 6QT", "United Kingdom"],
      taxId: "GB 418 2290 55",
    },
    meta: [
      ["Invoice No", "HL-2026-0431"],
      ["Issue Date", "14 August 2026"],
      ["Due Date", "13 September 2026"],
      ["Currency", "GBP (£)"],
    ],
    billTo: ["Marlow & Finch Ltd", "22 Beaufort Road", "Bath BA1 2QN"],
    items: [
      { description: "A5 saddle-stitched brochures, 250gsm", qty: 500, unitPrice: "£0.84", amount: "£420.00" },
      { description: "Business cards, matt laminate (box of 250)", qty: 4, unitPrice: "£18.50", amount: "£74.00" },
      { description: "Roll-up banner, 850mm x 2000mm", qty: 2, unitPrice: "£62.00", amount: "£124.00" },
      { description: "Artwork amends (hourly)", qty: 3, unitPrice: "£45.00", amount: "£135.00" },
    ],
    totals: [
      ["Subtotal", "£753.00"],
      ["VAT @ 20%", "£150.60"],
      ["Delivery", "£12.50"],
      ["Total Due", "£916.10", true],
    ],
    footer: ["Payment within 30 days. Bank: Lloyds 30-96-11 / 41229087.", "Late payment interest charged at 8% above base rate."],
  },

  // 2. Arithmetic mismatch: items sum to 1,240.00, printed subtotal says 1,420.00.
  //    The model must transcribe 1,420.00, not silently correct it.
  "sample-02-mismatch-invoice.pdf": {
    title: "INVOICE",
    vendor: {
      name: "Acme Corp",
      address: ["88 Union Street", "Manchester M1 2AB", "United Kingdom"],
      taxId: "GB331902847",
    },
    meta: [
      ["Invoice No", "AC-2026-0814"],
      ["Issue Date", "14/08/2026"],
      ["Due Date", "13/09/2026"],
    ],
    billTo: ["Northbank Partners", "5 Exchange Quay", "Salford M5 3EQ"],
    items: [
      { description: "Consulting - Q2 discovery workshop", qty: 1, unitPrice: "£850.00", amount: "£850.00" },
      { description: "Technical documentation package", qty: 1, unitPrice: "£390.00", amount: "£390.00" },
    ],
    totals: [
      ["Subtotal", "£1,420.00"],
      ["VAT @ 20%", "£284.00"],
      ["Total Due", "£1,704.00", true],
    ],
    footer: ["Thank you for your business."],
  },

  // 3. Receipt: no tax ID, no due date, ambiguous numeric date (03/04/2026),
  //    and a handwritten-style note. Should produce uncertainty + flags.
  "sample-03-receipt.pdf": {
    title: "RECEIPT",
    vendor: {
      name: "Blue Ridge Coffee",
      address: ["14 Mill Lane", "Sheffield S1 4RG"],
      taxId: null,
    },
    meta: [
      ["Receipt No", "0004821"],
      ["Date", "03/04/2026"],
      ["Server", "Tom"],
    ],
    billTo: null,
    items: [
      { description: "Flat white", qty: 2, unitPrice: "4.20", amount: "8.40" },
      { description: "Almond croissant", qty: 1, unitPrice: "3.80", amount: "3.80" },
      { description: "Sparkling water 330ml", qty: 1, unitPrice: "2.10", amount: "2.10" },
    ],
    totals: [
      ["Subtotal", "14.30"],
      ["Service 8.5%", "1.22"],
      ["TOTAL", "15.52", true],
    ],
    footer: ["Paid by card - Visa ending 4412", "No VAT charged. Thank you!"],
  },

  // 4. USD invoice with a discount, freight, many line items, and no due date —
  //    exercises a different currency, more fields, and the "due date required
  //    for invoices" conflict, so the demo covers more than one failure shape.
  "sample-04-logistics-invoice.pdf": {
    title: "INVOICE",
    vendor: {
      name: "Meridian Logistics Pte Ltd",
      address: ["12 Keppel Road, #04-11", "Singapore 089057"],
      taxId: "SG198203411K",
    },
    meta: [
      ["Invoice No", "ML-8830"],
      ["Issue Date", "17 August 2026"],
      ["Terms", "On receipt"],
      ["Currency", "USD ($)"],
    ],
    billTo: ["Colombo Trading Co.", "44 Galle Face Terrace", "Colombo 03, Sri Lanka"],
    items: [
      { description: "Ocean freight - Colombo to Singapore (2 pallets)", qty: 2, unitPrice: "$315.00", amount: "$630.00" },
      { description: "Customs handling and documentation", qty: 1, unitPrice: "$85.00", amount: "$85.00" },
      { description: "Fuel surcharge", qty: 1, unitPrice: "$47.25", amount: "$47.25" },
      { description: "Container seal and inspection", qty: 4, unitPrice: "$12.50", amount: "$50.00" },
      { description: "Warehouse storage (3 days)", qty: 3, unitPrice: "$28.00", amount: "$84.00" },
    ],
    totals: [
      ["Subtotal", "$896.25"],
      ["Volume discount", "-$25.00"],
      ["Freight insurance", "$18.40"],
      ["Amount Due", "$889.65", true],
    ],
    footer: ["Payment on receipt. Wire to DBS Bank, SWIFT DBSSSGSG.", "All shipments subject to standard terms of carriage."],
  },
};

const outDir = process.argv[2] ?? "samples";
await mkdir(outDir, { recursive: true });

for (const [filename, doc] of Object.entries(SAMPLES)) {
  const pdf = buildPdf(invoiceOps(doc));
  await writeFile(join(outDir, filename), pdf);
  console.log(`${filename.padEnd(34)} ${String(pdf.length).padStart(6)} bytes`);
}
console.log(`\nWrote ${Object.keys(SAMPLES).length} samples to ${outDir}/`);
