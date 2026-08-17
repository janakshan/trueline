#!/usr/bin/env node
// migrate.mjs — apply pending SQL migrations, or run the seed.
//
//   node db/migrate.mjs          apply pending migrations
//   node db/migrate.mjs --seed   apply pending migrations, then run db/seed.sql
//   node db/migrate.mjs --status list applied / pending and exit
//
// Requires DATABASE_URL. Only dependency is `pg` (devDependency — this never
// ships in the serverless bundle; the app itself uses @neondatabase/serverless).

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "migrations");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

// Neon requires TLS; a local Docker Postgres does not. Decide from the URL
// rather than making the caller pass a flag.
const needsSsl =
  /sslmode=require/.test(connectionString) || /\.neon\.tech/.test(connectionString);

const client = new pg.Client({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: true } : false,
});

const args = new Set(process.argv.slice(2));

async function main() {
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await client.query("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.version));
  const pending = files.filter((f) => !applied.has(f));

  if (args.has("--status")) {
    for (const f of files) console.log(`${applied.has(f) ? "applied" : "pending"}  ${f}`);
    return;
  }

  // A migration that vanished from disk but is recorded as applied means the
  // working tree and the database disagree. Fail loudly rather than guess.
  for (const version of applied) {
    if (!files.includes(version)) {
      throw new Error(`Migration ${version} is recorded as applied but is missing from disk.`);
    }
  }

  if (pending.length === 0) {
    console.log("No pending migrations.");
  }

  for (const file of pending) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    process.stdout.write(`applying ${file} ... `);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log("ok");
    } catch (err) {
      await client.query("ROLLBACK");
      console.log("FAILED");
      throw err;
    }
  }

  if (args.has("--seed")) {
    const sql = await readFile(join(HERE, "seed.sql"), "utf8");
    process.stdout.write("seeding ... ");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
      console.log("ok");
    } catch (err) {
      await client.query("ROLLBACK");
      console.log("FAILED");
      throw err;
    }
  }
}

try {
  await main();
} catch (err) {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
