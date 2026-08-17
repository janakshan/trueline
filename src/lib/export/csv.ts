/**
 * CSV writing. Hand-rolled because writing CSV is quoting rules, not parsing —
 * a library would not be earning its place.
 *
 * Two details that matter and that most hand-rolled writers miss:
 *
 *  1. A UTF-8 BOM, or Excel mangles non-ASCII vendor names.
 *  2. Formula injection. A cell beginning =, +, -, or @ is executed as a
 *     formula by Excel, Sheets, and LibreOffice — a vendor name of
 *     `=cmd|'/c calc'!A1` is a live attack, and vendor names come straight
 *     from an untrusted document.
 */

export const CSV_BOM = "﻿";

const RISKY_PREFIX = /^[=+\-@\t\r]/;

export function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  let text = typeof value === "number" ? String(value) : String(value);

  // Prefix with an apostrophe so spreadsheets treat it as literal text.
  if (RISKY_PREFIX.test(text)) text = `'${text}`;

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCell).join(",")];
  for (const row of rows) lines.push(row.map(escapeCell).join(","));
  // CRLF: the line ending every spreadsheet agrees on.
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}
