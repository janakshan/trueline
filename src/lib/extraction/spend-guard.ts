import { and, count, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { extractionUsage } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { AppError } from "@/lib/http/errors";

/**
 * The money guard.
 *
 * Extraction is the only endpoint that spends money, and a public demo hands
 * the account to anyone who clicks "Try the demo". Two limits, because they
 * fail differently:
 *
 *  - **Per client, per hour** — stops one visitor looping the button.
 *  - **Whole deployment, per calendar month** — stops a hundred visitors each
 *    politely staying under the hourly limit, which is the failure the
 *    per-client limit cannot see.
 *
 * Both counters live in Postgres rather than process memory. The in-memory
 * limiter in src/lib/auth/rate-limit.ts is still in front of this and still
 * useful — it rejects a flood without touching the database — but it cannot
 * bound spend, because serverless instances do not share a Map and a cold start
 * resets the window.
 *
 * ⚠️ This is the second line of defence, not the first. It is enforced by our
 * own code, so a bug here is a bug in the cap. The limit that cannot be argued
 * with is the workspace spend limit set in the Anthropic Console, which is
 * enforced by the API itself. Set both.
 */

/**
 * Read-only check, run before the work starts. Throws if either cap is spent.
 *
 * Deliberately separate from recording. A request can be rejected after this
 * point without ever reaching the API — the document may be owned by another
 * invocation, or out of attempts — and charging budget for a call that was
 * never made would let anyone drain the month's cap by hammering a document
 * that cannot run.
 */
export async function assertExtractionBudget(clientKey: string): Promise<void> {
  const now = new Date();

  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const [{ value: clientCalls } = { value: 0 }] = await db
    .select({ value: count() })
    .from(extractionUsage)
    .where(
      and(eq(extractionUsage.clientKey, clientKey), gte(extractionUsage.createdAt, hourAgo)),
    );

  if (clientCalls >= env.EXTRACTION_HOURLY_CLIENT_CAP) {
    throw new AppError(
      "TOO_MANY_REQUESTS",
      `This demo allows ${env.EXTRACTION_HOURLY_CLIENT_CAP} extractions per hour. Try again later — the sample documents already show extracted results.`,
      { scope: "client", limit: env.EXTRACTION_HOURLY_CLIENT_CAP, windowHours: 1 },
    );
  }

  // Calendar month in UTC. A month boundary that moves with the viewer's
  // timezone would make the cap ambiguous at exactly the moment it matters.
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [{ value: monthlyCalls } = { value: 0 }] = await db
    .select({ value: count() })
    .from(extractionUsage)
    .where(gte(extractionUsage.createdAt, monthStart));

  if (monthlyCalls >= env.EXTRACTION_MONTHLY_CAP) {
    throw new AppError(
      "TOO_MANY_REQUESTS",
      "This demo has reached its monthly extraction budget. The sample documents still show real extracted results, and uploads, review and export all keep working.",
      { scope: "deployment", limit: env.EXTRACTION_MONTHLY_CAP, windowDays: 30 },
    );
  }

}

/**
 * Records one billable attempt. Called once the document has actually been
 * claimed, which is the point at which the API call is going to happen.
 *
 * A failed extraction still counts: a truncated or refused response has already
 * generated tokens, so it cost money and must consume budget.
 *
 * ⚠️ Check-then-record is not atomic. Two simultaneous requests can both pass
 * the final slot, overshooting a cap by roughly the number of concurrent
 * callers — one or two calls in practice. The alternative is holding a
 * transaction open across a 50-second API call, which trades a cent for a
 * connection pool. The Console spend limit is the backstop that does not race.
 */
export async function recordExtractionUsage(options: {
  clientKey: string;
  userId: string;
  documentId: string;
}): Promise<void> {
  await db.insert(extractionUsage).values({
    clientKey: options.clientKey,
    userId: options.userId,
    documentId: options.documentId,
  });
}

/** Current usage, for the ops check in the deployment runbook. */
export async function extractionUsageSummary(): Promise<{
  monthToDate: number;
  monthlyCap: number;
  remaining: number;
}> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [{ value: monthToDate } = { value: 0 }] = await db
    .select({ value: count() })
    .from(extractionUsage)
    .where(gte(extractionUsage.createdAt, monthStart));

  return {
    monthToDate,
    monthlyCap: env.EXTRACTION_MONTHLY_CAP,
    remaining: Math.max(0, env.EXTRACTION_MONTHLY_CAP - monthToDate),
  };
}
