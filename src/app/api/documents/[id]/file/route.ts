import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireUserId } from "@/lib/auth/session";
import { db } from "@/lib/db/client";
import { documents } from "@/lib/db/schema";
import { badRequest, notFound } from "@/lib/http/errors";
import { route } from "@/lib/http/respond";
import { storage } from "@/lib/storage";

export const runtime = "nodejs";

const paramsSchema = z.object({ id: z.string().uuid() });

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/documents/:id/file — the original bytes, for the review preview.
 *
 * Goes through the app rather than exposing storage directly, so ownership is
 * enforced on every fetch. Once storage moves to Vercel Blob this becomes a
 * signed-URL redirect; the URL the client uses does not change.
 */
export const GET = route<Context>(async (_request, context) => {
  const userId = await requireUserId();

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) throw badRequest("Document id must be a UUID.");

  const [row] = await db
    .select({ storagePath: documents.storagePath, mimeType: documents.mimeType, filename: documents.filename })
    .from(documents)
    .where(and(eq(documents.id, parsed.data.id), eq(documents.userId, userId)))
    .limit(1);

  if (!row) throw notFound("Document not found.");

  let bytes: Buffer;
  try {
    bytes = await storage.get(row.storagePath);
  } catch {
    throw notFound("The stored file could not be read.");
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      // Serving user-supplied bytes inline from the app's own origin is the
      // one genuine stored-XSS surface here. Magic-byte validation already
      // restricts uploads to PDF/PNG/JPEG, but these three headers close the
      // gap that validation alone cannot:
      "Content-Type": row.mimeType,
      // Without nosniff a browser may ignore Content-Type and sniff a polyglot
      // file as HTML, executing it on our origin.
      "X-Content-Type-Options": "nosniff",
      // Scripts in a PDF (they are legal, and the viewer runs them) get no
      // origin, no scripting, and no navigation. `sandbox` with no allow-list
      // is the most restrictive setting.
      "Content-Security-Policy": "sandbox; default-src 'none'; object-src 'none'",
      // inline so <embed>/<img> render it rather than triggering a download.
      // The filename is sanitised at upload (basename, control chars stripped),
      // so it cannot break out of the header.
      "Content-Disposition": `inline; filename="${row.filename}"`,
      "Cache-Control": "private, max-age=300",
      "Content-Length": String(bytes.byteLength),
    },
  });
});
