import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { ok, route } from "@/lib/http/respond";

export const runtime = "nodejs";

export const POST = route(async () => {
  (await cookies()).delete(SESSION_COOKIE);
  return ok({ signedOut: true });
});
