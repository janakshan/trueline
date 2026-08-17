import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { clientKey, enforceRateLimit } from "@/lib/auth/rate-limit";
import { requireUserId } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { documents, type SupportedMimeType } from "@/lib/db/schema";
import { ok, route } from "@/lib/http/respond";
import { buildStorageKey, storage } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * POST /api/documents/samples — seed the demo account with the sample invoices.
 *
 * Exists for the empty state: most people evaluating this demo will not have an
 * invoice PDF to hand, and an empty box is a dead demo. Copies the files into
 * storage exactly as a real upload would, so the resulting rows are ordinary
 * documents with nothing special about them.
 */
const SAMPLES: Array<{ filename: string; mimeType: SupportedMimeType }> = [
  { filename: "sample-01-clean-invoice.pdf", mimeType: "application/pdf" },
  { filename: "sample-02-mismatch-invoice.pdf", mimeType: "application/pdf" },
  { filename: "sample-03-receipt.pdf", mimeType: "application/pdf" },
];

export const POST = route(async (request: Request) => {
  const userId = await requireUserId();

  // Creates three documents per call; unbounded it is a free way to fill the
  // database and queue extractions.
  enforceRateLimit(clientKey(request, "samples"), { limit: 10, windowMs: 60 * 60 * 1000 });
  const created: string[] = [];

  for (const sample of SAMPLES) {
    const bytes = await readFile(join(process.cwd(), "samples", sample.filename));
    const id = randomUUID();
    const storagePath = buildStorageKey(id, sample.filename);
    await storage.put(storagePath, bytes);

    try {
      await db.insert(documents).values({
        id,
        userId,
        filename: sample.filename,
        mimeType: sample.mimeType,
        sizeBytes: bytes.byteLength,
        storagePath,
        status: "queued",
      });
      created.push(id);
    } catch (err) {
      await storage.delete(storagePath).catch(() => {});
      await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
      throw err;
    }
  }

  return ok({ created }, { status: 201 });
});
