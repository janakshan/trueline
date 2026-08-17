# Trueline — database

```
db/
├─ migrations/0001_init.sql   schema (users, documents, extractions)
├─ seed.sql                   demo account + 5 sample documents
├─ migrate.mjs                ~90-line runner
└─ README.md
```

```bash
export DATABASE_URL="postgres://…"   # Neon, or local Docker
npm run db:migrate    # apply pending migrations
npm run db:seed       # migrate, then seed (idempotent)
npm run db:status     # list applied / pending
```

Local Postgres for development:

```bash
docker run -d --rm --name trueline-pg -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=trueline -p 55432:5432 postgres:16-alpine
export DATABASE_URL="postgres://postgres:test@localhost:55432/trueline"
```

**Demo login:** `demo@trueline.app` — password is `DEMO_PASSWORD` in `.env.local`
(this file used to print a literal password that has since been retired; the
smoke test asserts the old one no longer works). Prefer the one-click **Try the
demo** button, which never sends a password to the browser.

---

## Migration tooling: plain SQL files + a small runner

**The choice.** Numbered `.sql` files, a `schema_migrations` table, and ~90 lines of Node. One dev-only dependency (`pg`), which never enters the serverless bundle — the app itself uses `@neondatabase/serverless` over HTTP.

**Why not `drizzle-kit generate`,** given `architecture.md` picks Drizzle as the query layer? Three reasons. Generated columns, partial unique indexes, `COMMENT ON`, and multi-condition CHECK constraints are either unsupported or awkward in an ORM DSL, and this schema leans on all four. Raw SQL also pastes straight into the Neon console when something needs debugging at 1am. And it keeps the DDL readable by anyone, including a client reviewing the repo, without knowing Drizzle's API.

**Drizzle still earns its place for queries.** The workflow is: write SQL migrations, then `drizzle-kit pull` to regenerate `schema.ts` from the live database. The database is the source of truth and the TypeScript types are derived from it, so the two cannot drift — which is the failure mode this split usually has.

**What the runner deliberately does not do:** no down-migrations (roll forward — a down migration on a demo is theatre), no checksums, no baselining, no locking. If this grew past one developer, the next step is Atlas or Sqitch, not more Node.

---

## Tables

**`users`** — one row in v1. Email stored pre-lowercased with a CHECK enforcing it, so the plain UNIQUE index is the whole story rather than half of it. Password is `node:crypto` scrypt, self-describing format: `scrypt$N$r$p$salt_b64$hash_b64`.

**`documents`** — the file and its position in the queue: metadata, `storage_path`, `status`, `attempts`, `processing_started_at`, and error fields. Holds **no extracted data**, so re-extraction never touches the file record.

**`extractions`** — what the model produced plus human review state: `data` (the Zod-validated payload), `confidence`, `validation_issues`, `reviewed_fields`, `edits`, telemetry, and `is_current`. Multiple rows per document keep re-extraction history.

### Key decisions, one line each

- **`status` is `text` + CHECK, not a native ENUM** — adding or retiring a status is a constraint swap instead of an `ALTER TYPE` dance, and it maps cleanly to a TypeScript union.
- **Line items live inside `extractions.data`, not a fourth table** — they are only ever read with their parent, and per-line-item CSV export is one `jsonb_array_elements` lateral join (verified below).
- **Generated columns derive `vendor_name`, `currency`, `total_amount`, `issue_date`, `line_item_count` from `data`** — the list view, sorting, and CSV export become plain indexed SQL, and Postgres maintains them so they cannot drift from the JSON.
- **Every generated column is regex-guarded** — a malformed extraction writes `NULL` rather than failing the whole INSERT, so one bad document never blocks a batch.
- **`issue_date` is `text`, not `date`** — every text→date path in Postgres (`to_date`, `::date`) is STABLE rather than IMMUTABLE, and generated columns require IMMUTABLE. ISO-8601 sorts and range-compares lexicographically exactly as dates do. ⚠️ Changing this to `date` will stop the migration applying; the constraint is documented in the schema so nobody "fixes" it.
- **A partial unique index enforces one current extraction per document** — `is_current` correctness lives in the database, not in a hopeful application invariant.
- **CHECK constraints encode two states the UI depends on** — a `failed` row must carry an `error_code`, and a `processing` row must carry a `processing_started_at`, or the stale-claim sweep in `architecture.md` can never reclaim it.
- **`edits` is a jsonb array, not an audit table** — bounded by how many fields a document has and never queried across documents; promote it if audit becomes a real requirement.
- **`raw_response` is capped at 8 KB by CHECK** — Neon's free 0.5 GB fills faster than you'd expect, and diagnosis rarely needs more.
- **A partial index covers only in-flight rows** (`status IN ('queued','processing')`) — the queue-claim index stays small and hot regardless of how many documents accumulate.

---

## Test results

Run against **PostgreSQL 16.13** in a throwaway Docker container, then torn down.

| Check | Result |
|---|---|
| `0001_init.sql` on a clean database | ✅ applies |
| `seed.sql` | ✅ applies |
| Re-run migrate (idempotency) | ✅ "No pending migrations"; row counts unchanged |
| Re-run seed | ✅ 1 user / 5 documents / 4 extractions — no duplication |
| Generated columns populate from JSONB alone | ✅ all 5, nothing app-populated |
| Per-line-item export via `jsonb_array_elements` | ✅ correct rows |
| Reconciliation check in SQL | ✅ 3 balanced, 1 MISMATCH (Acme: 1,240.00 vs 1,420.00) |
| Demo password verifies via scrypt; wrong password rejected | ✅ |
| Broken migration | ✅ rolls back, no partial table, not recorded, exit 1 |
| Recorded migration missing from disk | ✅ fails loudly, exit 1 |
| Atomic queue claim; second claim returns 0 rows | ✅ |
| Malformed JSON (`"total_amount":"n/a"`, `"issue_date":"17/08/2026"`) | ✅ NULLs, insert succeeds |

All eight CHECK/unique constraints were tested by attempting to violate them; all eight rejected:
failed-without-error-code · processing-without-claim · oversized file · unsupported MIME ·
unknown status · non-lowercase email · second current extraction · oversized `raw_response`.

⚠️ **One thing this does not prove.** The schema was verified on stock Postgres 16, not on Neon. Neon is Postgres-compatible and nothing here uses an exotic feature, but run `npm run db:migrate` against the real Neon branch before relying on it — connection-level behaviour (TLS, pooler, statement timeouts) is the part a local container can't exercise.

---

## Seed data

Five documents, chosen to cover every state in `ui-plan.md`:

| # | Document | Status | Demonstrates |
|---|---|---|---|
| 1 | Northwind Supplies, £1,103.13 | `approved` | happy path; one human edit in `edits` and `reviewed_fields` |
| 2 | Acme Corp, £1,704.00 | `needs_review` | **the reconciliation strip** — line items 1,240.00 vs subtotal 1,420.00 |
| 3 | Blue Ridge Coffee, £13.24 | `needs_review` | receipt; two amber "check this" fields |
| 4 | Meridian Logistics, $737.25 | `needs_review` | red conflict — required `due_date` missing; also a discount |
| 5 | `scan_20260817_1042.jpg` | `failed` | error state after 3 attempts, with a retry affordance |

Document 2's numbers were picked to match the example text in `ui-plan.md` exactly, so the seeded demo reproduces the screenshot in the design doc.

⚠️ **`storage_path` points at `samples/*` files that do not exist yet.** The review screen's preview pane will show its fallback state until real sample PDFs and images are added. That's the correct next step before this is demo-ready.
