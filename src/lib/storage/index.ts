import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { env } from "@/lib/env";

/**
 * Minimal storage seam. Local filesystem today; Vercel Blob later without
 * touching any route — architecture.md's client-direct upload path swaps the
 * implementation here and adds a token route, and nothing else changes.
 */
export interface Storage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const ROOT = resolve(process.cwd(), env.STORAGE_DIR);

/**
 * Storage keys are built server-side from a UUID, never taken from user input,
 * but this resolves and re-checks anyway. A path check that only runs when you
 * remember to call it is the one that eventually gets skipped.
 */
function safePath(key: string): string {
  const full = resolve(ROOT, key);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    throw new Error(`Storage key escapes the storage root: ${key}`);
  }
  return full;
}

export const localStorage: Storage = {
  async put(key, bytes) {
    const full = safePath(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
  },
  async get(key) {
    return readFile(safePath(key));
  },
  async delete(key) {
    await rm(safePath(key), { force: true });
  },
};

export const storage: Storage = localStorage;

/** `documents/<documentId>/<sanitised filename>` */
export function buildStorageKey(documentId: string, filename: string): string {
  return join("documents", documentId, filename);
}
