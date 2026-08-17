import { NextResponse, type NextRequest } from "next/server";
// Must be the dependency-free module: importing from session.ts pulls
// node:crypto into the edge bundle and fails the build.
import { SESSION_COOKIE } from "@/lib/auth/constants";

/**
 * Defense in depth, not the primary guard.
 *
 * Every page already sits under a layout that checks the session, and every
 * data API route calls requireUserId(). This exists so that a page or route
 * added later without thinking about auth is still protected by default —
 * the failure mode it prevents is a future omission, not a current hole.
 *
 * It deliberately only checks that a cookie is *present*, not that it is valid.
 * Middleware runs on the edge runtime, where node:crypto's HMAC verification is
 * unavailable; the real signature check happens in verifySessionToken() on the
 * Node runtime. A forged cookie gets past this and is rejected there.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasCookie = request.cookies.has(SESSION_COOKIE);

  if (pathname.startsWith("/api/")) {
    // Auth endpoints must stay reachable without a session, or you can never
    // acquire one.
    if (pathname.startsWith("/api/auth/")) return NextResponse.next();
    if (hasCookie) return NextResponse.next();

    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
      { status: 401 },
    );
  }

  if (!hasCookie) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except the sign-in page, Next internals, and static files.
  //
  // `.html` is in the static list because files served from public/ are assets,
  // not app routes — sending them through session middleware redirects them to
  // sign-in, which broke the screenshot tool's bootstrap page. Nothing in
  // public/ is meant to be auth-gated; anything that needs a session is an app
  // route and stays covered.
  matcher: [
    "/((?!sign-in|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|html)$).*)",
  ],
};
