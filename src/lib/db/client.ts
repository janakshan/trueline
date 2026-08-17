import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * A single pooled client, cached across hot reloads in dev so `next dev` does
 * not open a new pool on every file change and exhaust Postgres connections.
 *
 * Driver note: architecture.md specified @neondatabase/serverless (HTTP) for
 * its faster cold start. This uses node-postgres instead, because the HTTP
 * driver only speaks to Neon's proxy and cannot connect to a local Postgres —
 * which would make the whole backend untestable outside a deploy. `pg` works
 * against both Neon's pooler and Docker. Swapping to neon-http later is a
 * change to this file only.
 */

declare global {
  // eslint-disable-next-line no-var
  var __truelinePool: pg.Pool | undefined;
}

function createPool(): pg.Pool {
  const needsSsl =
    /sslmode=require/.test(env.DATABASE_URL) || /\.neon\.tech/.test(env.DATABASE_URL);

  return new pg.Pool({
    connectionString: env.DATABASE_URL,
    ssl: needsSsl ? { rejectUnauthorized: true } : false,
    max: env.NODE_ENV === "production" ? 5 : 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
}

const pool = globalThis.__truelinePool ?? createPool();
if (env.NODE_ENV !== "production") globalThis.__truelinePool = pool;

export const db = drizzle(pool, { schema });
export { schema };
