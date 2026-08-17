import { basename, extname } from "node:path";
import {
  badRequest,
  payloadTooLarge,
  unsupportedMediaType,
} from "@/lib/http/errors";
import { MAX_FILE_BYTES, type SupportedMimeType } from "@/lib/db/schema";

export interface ValidatedFile {
  filename: string;
  mimeType: SupportedMimeType;
  sizeBytes: number;
  bytes: Buffer;
}

/**
 * Magic-byte signatures. The browser-supplied Content-Type on a multipart part
 * is attacker-controlled — renaming `payload.exe` to `invoice.pdf` sets it to
 * application/pdf — so the declared type is treated as a hint and the first
 * bytes are what actually decide.
 */
const SIGNATURES: ReadonlyArray<{
  mimeType: SupportedMimeType;
  magic: readonly number[];
}> = [
  { mimeType: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mimeType: "image/png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
];

function sniffMimeType(bytes: Buffer): SupportedMimeType | null {
  for (const { mimeType, magic } of SIGNATURES) {
    if (bytes.length < magic.length) continue;
    if (magic.every((byte, i) => bytes[i] === byte)) return mimeType;
  }
  return null;
}

/**
 * Strips directory components and control characters, collapses whitespace,
 * and caps length. Prevents `../../etc/passwd` and CRLF injection into any
 * later Content-Disposition header.
 */
export function sanitiseFilename(raw: string): string {
  const base = basename(raw.replace(/\\/g, "/"))
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  if (base === "" || base === "." || base === "..") return "upload";

  const ext = extname(base).slice(0, 10);
  const stem = base.slice(0, base.length - ext.length).slice(0, 120);
  return `${stem || "upload"}${ext}`;
}

/**
 * Validates one multipart file part. Order matters: size is checked before the
 * body is buffered where possible, and content sniffing runs last because it
 * is the only check that needs the bytes in memory.
 */
export async function validateUploadedFile(value: unknown): Promise<ValidatedFile> {
  if (!(value instanceof File)) {
    throw badRequest("Field 'file' must be a file upload.");
  }

  if (value.size === 0) {
    throw badRequest("Uploaded file is empty.");
  }

  if (value.size > MAX_FILE_BYTES) {
    throw payloadTooLarge(
      `File is ${(value.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`,
      { sizeBytes: value.size, maxBytes: MAX_FILE_BYTES },
    );
  }

  const bytes = Buffer.from(await value.arrayBuffer());

  // Guard against a lying Content-Length: re-check the real buffered size.
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw payloadTooLarge("File exceeds the 10 MB limit.", {
      sizeBytes: bytes.byteLength,
      maxBytes: MAX_FILE_BYTES,
    });
  }

  const sniffed = sniffMimeType(bytes);
  if (!sniffed) {
    throw unsupportedMediaType(
      "File must be a PDF, PNG, or JPEG. The file's contents did not match any supported format.",
      { declaredType: value.type || null },
    );
  }

  return {
    filename: sanitiseFilename(value.name),
    mimeType: sniffed,
    sizeBytes: bytes.byteLength,
    bytes,
  };
}
