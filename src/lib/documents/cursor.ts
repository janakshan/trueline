import { z } from "zod";
import { badRequest } from "@/lib/http/errors";

/**
 * Keyset pagination cursor over (createdAt, id).
 *
 * Offset pagination would be simpler, but this list is prepended to constantly
 * while a batch uploads — with OFFSET, a row inserted between page 1 and page 2
 * shifts everything down and the client silently re-sees or skips rows. A
 * keyset cursor is stable under concurrent inserts.
 */

const cursorSchema = z.object({
  t: z.string().datetime({ offset: true }),
  i: z.string().uuid(),
});

export interface Cursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  const payload = JSON.stringify({
    t: cursor.createdAt.toISOString(),
    i: cursor.id,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw badRequest("Malformed pagination cursor.");
  }

  const result = cursorSchema.safeParse(parsed);
  if (!result.success) throw badRequest("Malformed pagination cursor.");

  return { createdAt: new Date(result.data.t), id: result.data.i };
}
