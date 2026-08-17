/**
 * Auth coverage — every route, discovered from the filesystem.
 *
 *   npm run test:auth      (needs the dev server running)
 *
 * The point is the *discovery*. Asserting "these five routes are protected"
 * proves nothing about the sixth someone adds next month. This walks
 * src/app/api and src/app/(app) and requires every route it finds to reject an
 * unauthenticated request — so a new endpoint shipped without a guard fails the
 * suite instead of quietly serving another user's invoices.
 */

import { readdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3111";
const REAL_UUID = "10000000-0000-4000-8000-000000000002";

/** Auth endpoints must be reachable without a session, or you can never get one. */
const PUBLIC_PATHS = [/^\/api\/auth\//, /^\/sign-in$/];

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function walk(dir: string, match: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full, match)));
    else if (entry.name === match) found.push(full);
  }
  return found;
}

/** `src/app/(app)/documents/[id]/route.ts` → `/documents/<uuid>` */
function toUrlPath(file: string, root: string): string {
  const rel = relative(root, file).replace(/\/(route|page)\.tsx?$/, "");
  const segments = rel
    .split("/")
    .filter((s) => !(s.startsWith("(") && s.endsWith(")"))) // route groups
    .map((s) => (s.startsWith("[") ? REAL_UUID : s));
  return "/" + segments.join("/");
}

async function methodsIn(file: string): Promise<string[]> {
  const source = await readFile(file, "utf8");
  return [...source.matchAll(/export const (GET|POST|PATCH|PUT|DELETE)\b/g)].map((m) => m[1]!);
}

async function main(): Promise<void> {
  const apiRoot = "src/app";
  const routeFiles = await walk("src/app/api", "route.ts");
  const pageFiles = await walk("src/app/(app)", "page.tsx");

  console.log(`\n\x1b[1mAPI routes (discovered ${routeFiles.length})\x1b[0m`);
  let guardedCount = 0;

  for (const file of routeFiles.sort()) {
    const path = toUrlPath(file, apiRoot);
    if (PUBLIC_PATHS.some((p) => p.test(path))) {
      console.log(`  \x1b[2mskip\x1b[0m  ${path} (auth endpoint, must be public)`);
      continue;
    }

    for (const method of await methodsIn(file)) {
      // No cookie at all — the baseline an anonymous visitor has.
      const response = await fetch(`${BASE}${path}`, {
        method,
        ...(method === "PATCH" || method === "POST"
          ? { headers: { "Content-Type": "application/json" }, body: "{}" }
          : {}),
      });
      guardedCount += 1;
      check(
        `${method.padEnd(6)} ${path} rejects anonymous`,
        response.status === 401,
        `got ${response.status}`,
      );
    }
  }

  console.log(`\n\x1b[1mPages (discovered ${pageFiles.length})\x1b[0m`);
  for (const file of pageFiles.sort()) {
    const path = toUrlPath(file, apiRoot);
    const response = await fetch(`${BASE}${path}`, { redirect: "manual" });
    const location = response.headers.get("location") ?? "";
    check(
      `GET    ${path} redirects to sign-in`,
      response.status >= 300 && response.status < 400 && location.includes("/sign-in"),
      `got ${response.status} -> ${location || "(no location)"}`,
    );
  }

  console.log(`\n\x1b[1mSession integrity\x1b[0m`);

  const forged = [
    ["structurally invalid", "garbage"],
    ["right shape, wrong signature", `${REAL_UUID}.9999999999.ZmFrZQ`],
    ["empty", ""],
    ["signature stripped", `${REAL_UUID}.9999999999.`],
  ] as const;

  for (const [label, token] of forged) {
    const response = await fetch(`${BASE}/api/documents`, {
      headers: { Cookie: `trueline_session=${token}` },
    });
    check(`forged cookie (${label}) rejected`, response.status === 401, `got ${response.status}`);
  }

  // A validly-signed but expired token must fail on expiry, not sail through.
  const { createHmac } = await import("node:crypto");
  const secret = process.env.SESSION_SECRET ?? "";
  const expired = `${REAL_UUID}.${Math.floor(Date.now() / 1000) - 60}`;
  const signature = createHmac("sha256", secret).update(expired).digest("base64url");
  const expiredResponse = await fetch(`${BASE}/api/documents`, {
    headers: { Cookie: `trueline_session=${expired}.${signature}` },
  });
  check(
    "validly-signed but expired session rejected",
    expiredResponse.status === 401,
    `got ${expiredResponse.status}`,
  );

  console.log(
    `\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m  (${guardedCount} method+path combinations checked)\n`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("harness crashed:", err);
  process.exit(1);
});
