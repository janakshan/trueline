import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `pg` opens TCP sockets and must not be bundled into the server build.
  serverExternalPackages: ["pg"],
  experimental: {
    // Route handlers that accept file uploads need a body limit above Next's
    // 1 MB default. Vercel still caps serverless request bodies at ~4.5 MB —
    // see docs/backend.md for why the >4.5 MB path is a separate increment.
    serverActions: { bodySizeLimit: "10mb" },
  },
};

/**
 * Baseline security headers.
 *
 * `frame-ancestors 'none'` matters specifically here: the review screen is a
 * one-click Approve UI, which is exactly the shape clickjacking targets.
 *
 * The CSP allows 'unsafe-inline' for styles because Next injects them, and
 * 'unsafe-eval' in development only for React Fast Refresh. Tightening the
 * script policy further needs nonces, which is real work for a demo — the
 * XSS-relevant control is that React escapes rendered data, verified by test.
 */
nextConfig.headers = async () => [
  {
    source: "/:path*",
    headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      {
        key: "Content-Security-Policy",
        value: [
          "default-src 'self'",
          process.env.NODE_ENV === "production"
            ? "script-src 'self'"
            : "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          // The app talks to nothing but itself; the Claude call is server-side.
          "connect-src 'self'",
          "object-src 'self'",
          "base-uri 'none'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join("; "),
      },
    ],
  },
  {
    // More specific, and listed second so it overrides the block above.
    //
    // Two corrections the general policy gets wrong for served files:
    //  1. The global CSP was replacing the route's `sandbox` header, undoing
    //     the PDF-script containment it exists to provide.
    //  2. X-Frame-Options: DENY blocks <object>/<embed> in several browsers,
    //     which would break the review screen's own preview pane. SAMEORIGIN
    //     keeps clickjacking protection while letting our page embed it.
    source: "/api/documents/:id/file",
    headers: [
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      {
        key: "Content-Security-Policy",
        value: "sandbox allow-same-origin; default-src 'none'; object-src 'none'; frame-ancestors 'self'",
      },
    ],
  },
];

export default nextConfig;
