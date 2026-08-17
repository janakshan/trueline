import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { z } from "zod";
import { verifyPassword } from "@/lib/auth/password";
import {
  SESSION_COOKIE,
  createSessionToken,
  sessionCookieOptions,
} from "@/lib/auth/session";
import { clientKey, enforceRateLimit } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { AppError } from "@/lib/http/errors";
import { ok, route } from "@/lib/http/respond";

export const runtime = "nodejs";

const signInSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

export const POST = route(async (request: Request) => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new AppError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Expected Content-Type: application/json.",
    );
  }

  // Applied before the password check so a brute force cannot use response
  // timing to distinguish attempts, and before touching the database at all.
  enforceRateLimit(clientKey(request, "sign-in"), { limit: 8, windowMs: 60_000 });

  const body = signInSchema.parse(await request.json());

  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, body.email))
    .limit(1);

  // Deliberately identical response for unknown email and wrong password:
  // distinguishing them is account enumeration. The dummy verify keeps the
  // timing of both branches comparable.
  const valid = user
    ? await verifyPassword(body.password, user.passwordHash)
    : await verifyPassword(body.password, "scrypt$16384$8$1$AAAA$AAAA");

  if (!user || !valid) {
    throw new AppError("UNAUTHORIZED", "Email or password is incorrect.");
  }

  const { token, maxAge } = createSessionToken(user.id);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions(maxAge));

  return ok({ userId: user.id });
});
