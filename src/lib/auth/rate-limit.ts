import { AppError } from "@/lib/http/errors";

/**
 * Fixed-window rate limiter, in process memory.
 *
 * ⚠️ Best-effort by construction. Serverless instances do not share memory, so
 * N instances allow N × the limit, and a cold start resets the window. Real
 * distributed limiting needs Redis or Upstash — both paid services, excluded by
 * the project constraints.
 *
 * It is still worth having: it stops a naive scripted brute force against the
 * one publicly-known account on a low-traffic deploy, which is the actual
 * threat here. Anything stronger is a lie about what this provides.
 */

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();

/** Evicts expired entries so a long-lived process cannot grow unboundedly. */
function sweep(now: number): void {
  if (buckets.size < 500) return;
  for (const [key, window] of buckets) {
    if (window.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimit {
  limit: number;
  windowMs: number;
}

export function enforceRateLimit(key: string, { limit, windowMs }: RateLimit): void {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  existing.count += 1;
  if (existing.count > limit) {
    const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
    throw new AppError(
      "TOO_MANY_REQUESTS",
      `Too many attempts. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`,
      { retryAfterSeconds: retryAfter },
    );
  }
}

/**
 * Best-effort client identity. `x-forwarded-for` is spoofable in general, but
 * on Vercel the platform overwrites it, so it is trustworthy there and merely
 * imperfect elsewhere. Falls back to a shared bucket rather than to no limit —
 * failing open on an unknown client is the wrong direction.
 */
export function clientKey(request: Request, scope: string): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  return `${scope}:${ip}`;
}

/** Test seam — the suites need a clean slate between cases. */
export function resetRateLimits(): void {
  buckets.clear();
}
