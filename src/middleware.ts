import { NextResponse, type NextRequest } from "next/server";
// Must be the dependency-free module: importing from session.ts pulls
// node:crypto into the edge bundle and fails the build.
import { SESSION_COOKIE } from "@/lib/auth/constants";

/**
 * Two jobs: the session guard, and the Content-Security-Policy.
 *
 * ── Session guard ──────────────────────────────────────────────────────────
 * Defense in depth, not the primary guard. Every page already sits under a
 * layout that checks the session, and every data API route calls
 * requireUserId(). This exists so that a page or route added later without
 * thinking about auth is still protected by default — the failure mode it
 * prevents is a future omission, not a current hole.
 *
 * It deliberately only checks that a cookie is *present*, not that it is valid.
 * Middleware runs on the edge runtime, where node:crypto's HMAC verification is
 * unavailable; the real signature check happens in verifySessionToken() on the
 * Node runtime. A forged cookie gets past this and is rejected there.
 *
 * ── CSP ────────────────────────────────────────────────────────────────────
 * The policy lives here rather than in next.config.ts because it needs a
 * per-request nonce. A static `script-src 'self'` blocks the four inline
 * bootstrap scripts the App Router emits to stream the RSC payload, so React
 * never hydrates and every page renders blank — which is exactly what it did
 * in production while dev mode looked fine, because dev allows 'unsafe-inline'.
 *
 * Next reads the nonce out of the CSP on the *request* headers
 * (see get-script-nonce-from-header.js) and stamps it onto its own scripts, so
 * the policy has to be set on both the request and the response.
 */

const isProduction = process.env.NODE_ENV === "production";

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    // A nonce makes browsers ignore 'unsafe-inline' entirely (CSP3), so dev
    // keeps the permissive form — React Fast Refresh needs eval and inline.
    isProduction
      ? `script-src 'self' 'nonce-${nonce}'`
      : "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
    // Next injects styles inline and offers no nonce hook for them.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // The app talks to nothing but itself; the Claude call is server-side.
    "connect-src 'self'",
    "object-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The served-file route sets its own, stricter policy in next.config.ts:
 * `sandbox` to contain scripts inside a hostile PDF, and `frame-ancestors 'self'`
 * so the review screen can still embed it. Layering the page policy on top
 * would emit two headers, and browsers enforce the intersection — the
 * `frame-ancestors 'none'` here would win and blank the preview pane.
 */
const SERVED_FILE = /^\/api\/documents\/[^/]+\/file$/;

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasCookie = request.cookies.has(SESSION_COOKIE);

  const nonce = generateNonce();
  const csp = contentSecurityPolicy(nonce);
  const ownsPolicy = !SERVED_FILE.test(pathname);

  /** Carries the policy inbound so Next can read the nonce, and outbound so the browser enforces it. */
  const withPolicy = (response: NextResponse): NextResponse => {
    if (ownsPolicy) response.headers.set("Content-Security-Policy", csp);
    return response;
  };

  const forward = () => {
    if (!ownsPolicy) return NextResponse.next();
    const headers = new Headers(request.headers);
    headers.set("Content-Security-Policy", csp);
    return withPolicy(NextResponse.next({ request: { headers } }));
  };

  // The sign-in page is matched only so it receives a nonce — it must stay
  // reachable without a session, or nobody can ever acquire one.
  if (pathname === "/sign-in") return forward();

  if (pathname.startsWith("/api/")) {
    // Auth endpoints must stay reachable without a session, for the same reason.
    if (pathname.startsWith("/api/auth/")) return forward();
    if (hasCookie) return forward();

    return withPolicy(
      NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
        { status: 401 },
      ),
    );
  }

  if (!hasCookie) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    return withPolicy(NextResponse.redirect(url));
  }

  return forward();
}

export const config = {
  // Everything except Next internals and static files.
  //
  // `sign-in` is no longer excluded: it is a page like any other and needs its
  // nonce, so the guard above lets it through explicitly instead.
  //
  // `.html` is in the static list because files served from public/ are assets,
  // not app routes — sending them through session middleware redirects them to
  // sign-in, which broke the screenshot tool's bootstrap page. Nothing in
  // public/ is meant to be auth-gated; anything that needs a session is an app
  // route and stays covered.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|html)$).*)",
  ],
};
