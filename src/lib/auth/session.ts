import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { unauthorized } from "@/lib/http/errors";

// Defined in constants.ts (no imports) so middleware can use it on the edge.
export { SESSION_COOKIE } from "./constants";
import { SESSION_COOKIE } from "./constants";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * Stateless signed-cookie session: `<userId>.<expiresAt>.<hmac>`.
 *
 * No server-side session store, which means no extra table and no Neon round
 * trip to check auth. The trade-off is that sessions cannot be revoked before
 * expiry — acceptable for a single-user demo, and the reason to move to a
 * session table (or Auth.js) the moment there are real users.
 */

function sign(payload: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(payload).digest("base64url");
}

export function createSessionToken(userId: string): { token: string; maxAge: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${userId}.${expiresAt}`;
  return { token: `${payload}.${sign(payload)}`, maxAge: SESSION_TTL_SECONDS };
}

export function verifySessionToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [userId, expiresAtRaw, signature] = parts as [string, string, string];
  const payload = `${userId}.${expiresAtRaw}`;

  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  // Length check first: timingSafeEqual throws on mismatched lengths.
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isInteger(expiresAt) || expiresAt * 1000 < Date.now()) return null;

  return userId;
}

/** Returns the authenticated user id, or null. */
export async function getSessionUserId(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return token ? verifySessionToken(token) : null;
}

/** Returns the authenticated user id, or throws a 401. */
export async function requireUserId(): Promise<string> {
  const userId = await getSessionUserId();
  if (!userId) throw unauthorized();
  return userId;
}

export const sessionCookieOptions = (maxAge: number) =>
  ({
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge,
  }) as const;
