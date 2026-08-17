import { scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

// promisify's inferred overload drops the options argument, so the 4-arg form
// is declared explicitly rather than cast at each call site.
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const MAX_MEM = 64 * 1024 * 1024;

/**
 * Verifies a password against a stored `scrypt$N$r$p$salt_b64$hash_b64` digest.
 *
 * Single-tenant demo, so this is node:crypto rather than an auth library — see
 * architecture.md. Comparison is timing-safe; a malformed or unknown-scheme
 * digest returns false rather than throwing, so a corrupt row cannot be
 * distinguished from a wrong password by response timing or status.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6) return false;

  const [scheme, nRaw, rRaw, pRaw, saltB64, hashB64] = parts as [
    string, string, string, string, string, string,
  ];
  if (scheme !== "scrypt") return false;

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  let expected: Buffer;
  let salt: Buffer;
  try {
    expected = Buffer.from(hashB64, "base64");
    salt = Buffer.from(saltB64, "base64");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;

  try {
    const derived = await scryptAsync(password, salt, KEY_LENGTH, {
      N,
      r,
      p,
      maxmem: MAX_MEM,
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
