/**
 * test-spend-guard.ts — the caps that stop a demo visitor spending your money.
 *
 * Runs against the database directly and never calls the Claude API, so it is
 * free to run and safe without a key.
 *
 * Every row it writes carries the ZZ_GUARD client-key prefix and is deleted
 * afterwards, including on failure. It never touches rows it did not create —
 * the usage table is a spend ledger, and wiping it would reset the live cap.
 */
import { and, count, gte, like, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { extractionUsage } from "@/lib/db/schema";
import { env } from "@/lib/env";
import {
  assertExtractionBudget,
  extractionUsageSummary,
  recordExtractionUsage,
} from "@/lib/extraction/spend-guard";

const ZZ_GUARD = "zz-guard-";
const USER = "00000000-0000-4000-8000-000000000001";
const DOC = "10000000-0000-4000-8000-000000000001";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
  const mark = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${mark}  ${label}${detail ? `  — ${detail}` : ""}`);
  ok ? (pass += 1) : (fail += 1);
}

/** Returns the thrown message, or null if the call was allowed. */
async function rejection(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return (error as { message?: string }).message ?? String(error);
  }
}

async function seedUsage(clientKey: string, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await recordExtractionUsage({ clientKey, userId: USER, documentId: DOC });
  }
}

async function cleanup(): Promise<void> {
  await db.delete(extractionUsage).where(like(extractionUsage.clientKey, `${ZZ_GUARD}%`));
}

async function main(): Promise<void> {
  await cleanup();

  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const [{ value: preExisting } = { value: 0 }] = await db
    .select({ value: count() })
    .from(extractionUsage)
    .where(gte(extractionUsage.createdAt, monthStart));

  console.log(`\n\x1b[1mPer-client hourly cap (${env.EXTRACTION_HOURLY_CLIENT_CAP}/hour)\x1b[0m`);

  const alice = `${ZZ_GUARD}alice`;
  const bob = `${ZZ_GUARD}bob`;

  check("a client with no history is allowed", (await rejection(() => assertExtractionBudget(alice))) === null);

  await seedUsage(alice, env.EXTRACTION_HOURLY_CLIENT_CAP - 1);
  check(
    "still allowed one call below the cap",
    (await rejection(() => assertExtractionBudget(alice))) === null,
  );

  await seedUsage(alice, 1);
  const blocked = await rejection(() => assertExtractionBudget(alice));
  check("blocked on reaching the cap", blocked !== null, blocked?.split(".")[0] ?? "");

  check(
    "a different client is unaffected by that",
    (await rejection(() => assertExtractionBudget(bob))) === null,
  );

  // Backdating proves the window slides rather than counting for all time.
  await db
    .update(extractionUsage)
    .set({ createdAt: sql`now() - interval '2 hours'` })
    .where(and(like(extractionUsage.clientKey, `${ZZ_GUARD}alice`)));
  check(
    "usage older than an hour no longer counts",
    (await rejection(() => assertExtractionBudget(alice))) === null,
  );

  console.log(`\n\x1b[1mDeployment monthly cap (${env.EXTRACTION_MONTHLY_CAP}/month)\x1b[0m`);

  // Top the month up to exactly the cap, spread over many distinct clients so
  // no per-client limit fires first — the case a per-client limit cannot see.
  const [{ value: current } = { value: 0 }] = await db
    .select({ value: count() })
    .from(extractionUsage)
    .where(gte(extractionUsage.createdAt, monthStart));

  const shortfall = env.EXTRACTION_MONTHLY_CAP - current - 1;
  for (let i = 0; i < shortfall; i += 1) await seedUsage(`${ZZ_GUARD}crowd-${i}`, 1);

  check(
    "a fresh client is allowed while the month has room",
    (await rejection(() => assertExtractionBudget(`${ZZ_GUARD}last`))) === null,
  );

  await seedUsage(`${ZZ_GUARD}last`, 1);
  const capped = await rejection(() => assertExtractionBudget(`${ZZ_GUARD}newcomer`));
  check("a fresh client is blocked once the month is spent", capped !== null, capped?.split(".")[0] ?? "");

  const summary = await extractionUsageSummary();
  check(
    "summary reports the month at its cap",
    summary.monthToDate >= env.EXTRACTION_MONTHLY_CAP && summary.remaining === 0,
    JSON.stringify(summary),
  );

  await cleanup();

  const [{ value: after } = { value: 0 }] = await db
    .select({ value: count() })
    .from(extractionUsage)
    .where(gte(extractionUsage.createdAt, monthStart));
  check("cleanup left pre-existing usage untouched", after === preExisting, `${preExisting} before, ${after} after`);

  console.log(`\n\x1b[1mpassed ${pass}, failed ${fail}\x1b[0m\n`);
}

main()
  .catch(async (error) => {
    console.error(error);
    fail += 1;
  })
  .finally(async () => {
    await cleanup();
    process.exit(fail === 0 ? 0 : 1);
  });
