import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { fileBlobs } from "@/lib/db/schema";

/**
 * Storage seam. Postgres today; object storage later without touching a route.
 *
 * This was the local filesystem, which cannot work on a serverless host: the
 * only writable path is /tmp, and /tmp is neither shared between instances nor
 * kept between invocations. An upload landed on one instance and the extraction
 * that read it back ran on another and found nothing — uploads returned 201 and
 * then failed with "the uploaded file could not be read", and every seeded
 * preview 404'd because the seed had written bytes to a laptop.
 *
 * Postgres is not where blobs belong at scale. For a demo whose files are
 * single-page invoices it costs nothing to operate, behaves identically in
 * development and production, and lets `db:seed` carry its own bytes. The
 * interface below is unchanged, so the swap to Vercel Blob or S3 stays a change
 * to this file plus a token.
 */
export interface Storage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Total bytes held, for the upload cap. */
  totalBytes(): Promise<number>;
}

/** Thrown when a key has no stored object, so callers can tell it from a real fault. */
export class StorageObjectNotFound extends Error {
  constructor(key: string) {
    super(`No stored object for key: ${key}`);
    this.name = "StorageObjectNotFound";
  }
}

export const postgresStorage: Storage = {
  async put(key, bytes) {
    // Upsert: re-extracting or re-uploading the same document must not collide
    // with the row a previous attempt left behind.
    await db
      .insert(fileBlobs)
      .values({ storageKey: key, bytes, byteSize: bytes.byteLength })
      .onConflictDoUpdate({
        target: fileBlobs.storageKey,
        set: { bytes, byteSize: bytes.byteLength },
      });
  },

  async get(key) {
    const [row] = await db
      .select({ bytes: fileBlobs.bytes })
      .from(fileBlobs)
      .where(eq(fileBlobs.storageKey, key))
      .limit(1);

    if (!row) throw new StorageObjectNotFound(key);
    return row.bytes;
  },

  async delete(key) {
    await db.delete(fileBlobs).where(eq(fileBlobs.storageKey, key));
  },

  async totalBytes() {
    const [row] = await db
      .select({ total: sql<string>`coalesce(sum(${fileBlobs.byteSize}), 0)` })
      .from(fileBlobs);
    return Number(row?.total ?? 0);
  },
};

export const storage: Storage = postgresStorage;

/** `documents/<documentId>/<sanitised filename>` */
export function buildStorageKey(documentId: string, filename: string): string {
  return join("documents", documentId, filename);
}
