import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  createSessionToken,
  sessionCookieOptions,
} from "@/lib/auth/session";
import { clientKey, enforceRateLimit } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { AppError, notFound } from "@/lib/http/errors";
import { ok, route } from "@/lib/http/respond";

export const runtime = "nodejs";

/**
 * POST /api/auth/demo — one-click sign-in to the seeded demo account.
 *
 * Why this exists rather than the button posting a password: a credential a
 * client-side button can send is in the JavaScript bundle, so it is public no
 * matter how long it is. Minting the session server-side means the demo
 * password is never shipped to a browser and can be a genuine secret — which
 * matters because the same password guards the account through the normal form.
 *
 * The endpoint is deliberately narrow: it can only ever authenticate the one
 * configured demo address, so it is not a general "log in as anyone" hole.
 */
export const POST = route(async (request: Request) => {
  if (!env.DEMO_LOGIN_ENABLED) {
    throw new AppError("FORBIDDEN", "Demo login is disabled.");
  }

  // Looser than the password form — this is meant to be clicked — but still
  // bounded, so it cannot be used to hammer the database for free.
  enforceRateLimit(clientKey(request, "demo"), { limit: 10, windowMs: 60_000 });

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, env.DEMO_EMAIL))
    .limit(1);

  if (!user) {
    throw notFound("The demo account has not been seeded. Run `npm run db:seed`.");
  }

  const { token, maxAge } = createSessionToken(user.id);
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions(maxAge));

  return ok({ userId: user.id, demo: true });
});
