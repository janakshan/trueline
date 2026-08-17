# Trueline — deploying to Vercel + Neon

A runbook for putting the demo on a public URL without handing your API budget
to the internet. Roughly 30 minutes end to end.

The order matters: **database first, spend limits before the first public link.**
Everything up to step 6 is free to undo.

---

## 1. Create the Neon database

1. <https://console.neon.tech> → **New Project**. Postgres 17, region closest to
   your Vercel region (`aws-eu-west-2` if you deploy to London).
2. Name the database `trueline`.
3. Copy the **pooled** connection string. It looks like:

   ```
   postgres://user:pass@ep-xxx-pooler.eu-west-2.aws.neon.tech/trueline?sslmode=require
   ```

**Take the pooled one, not the direct one.** Serverless functions open a
connection per invocation; the direct endpoint runs out of connections under
concurrency, and the failure looks like random 500s rather than anything
obviously connection-related. `src/lib/db/client.ts` keys TLS off `sslmode=require`
and `.neon.tech`, so the pooled string turns SSL on by itself.

---

## 2. Migrate the production database from your machine

Migrations run from your laptop against Neon, not from Vercel. A build step that
migrates would run on every deploy and on every preview branch, which is how a
preview environment ends up mutating production data.

```bash
cd trueline

# One-off, in this shell only — do not put the production URL in .env.local
export DATABASE_URL="postgres://…-pooler….neon.tech/trueline?sslmode=require"

npm run db:status     # expect: 0001, 0002 pending
npm run db:migrate
npm run db:status     # expect: both applied, none pending
```

Then seed the demo account and its five sample documents:

```bash
export SESSION_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
export DEMO_PASSWORD='…'     # any strong string; nobody types it, see step 4
npm run db:seed
```

> ⚠️ **`db:seed` deletes the demo user and everything cascading from it.** That
> is what makes it idempotent, and it is fine on a demo whose only rows are
> seed rows. Never run it against a database holding anything you care about.

**Two known snags on Neon:**

- The schema was verified on stock Postgres 16 in Docker, not on Neon. Nothing
  here uses an exotic feature, but `db:migrate` is the first real test —
  run it before wiring up Vercel, while a mistake is still cheap.
- After seeding, four of the five document previews will 404. `scripts/seed-files.mjs`
  copies samples into `.storage/samples/`, but `db/seed.sql` points those rows at
  `documents/<id>/<filename>`. On Vercel it is moot — see step 6.

---

## 3. Import the project into Vercel

1. <https://vercel.com/new> → import `janakshan/trueline`.
2. Framework preset **Next.js**. Leave build and output settings alone.
3. **Do not deploy yet** — add the environment variables first, or the first
   build boots without `SESSION_SECRET` and fails at `src/lib/env.ts` with a
   readable error. (That failure is the env parser doing its job.)

---

## 4. Environment variables

Vercel → Project → **Settings → Environment Variables**. Set these for
**Production** (and Preview, if you want previews to work):

| Variable | Value | Required |
|---|---|---|
| `DATABASE_URL` | the pooled Neon string from step 1 | **yes** |
| `SESSION_SECRET` | 32+ random chars — `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` | **yes** |
| `ANTHROPIC_API_KEY` | `sk-ant-…` from the workspace you create in step 5 | no¹ |
| `DEMO_PASSWORD` | the same value you seeded with | no² |
| `EXTRACTION_MONTHLY_CAP` | `200` | no |
| `EXTRACTION_HOURLY_CLIENT_CAP` | `10` | no |
| `EXTRACTION_MODEL` | `claude-sonnet-5` if you want cheaper than the `claude-opus-5` default | no |
| `STORAGE_DIR` | `/tmp/storage` — see step 6 | recommended |

¹ Optional by design. Without it the site still works: sign-in, the seeded
documents, review, and export all run; only a *new* extraction fails, with a
message naming the variable. That is the safe state to launch in.

² Only used by password sign-in. The demo button does not need it.

**Everything else has a working default** (`DEMO_EMAIL`, `DEMO_LOGIN_ENABLED`,
the extraction tuning knobs), so the table above is the whole list.

### Keeping the API key safe

- **The key only ever exists server-side.** It is read in `src/lib/env.ts`, used
  in `src/lib/extraction/client.ts`, and passed explicitly to the SDK rather
  than picked up from the ambient environment. No `NEXT_PUBLIC_` prefix means
  Next will not inline it into client bundles — that prefix is the single
  mistake that leaks keys in this framework, and nothing here uses it.
- **It is never in the repo.** `.env.local` is gitignored; `.env.example` carries
  only the placeholder `sk-ant-api03-...`.
- **Give the demo its own workspace and its own key** (step 5), so revoking it
  costs you nothing else.
- **Set it as a Sensitive variable in Vercel** — the value becomes write-only
  and cannot be read back out of the dashboard afterwards.
- **Rotate it if it ever reaches a log, a screenshot, or a chat.** Rotation is
  a minute; deciding whether a leak mattered is an afternoon.

---

## 5. Spend limits — do this before the URL is public

Two layers, because they fail differently. The app's caps are enforced by code
in this repo, so a bug in them is a bug in your cap. The Console limit is
enforced by the API itself and cannot be argued with.

### Layer 1 — the Anthropic Console (the one that actually stops spending)

1. <https://platform.claude.com> → **Settings → Workspaces → Create Workspace**,
   name it `trueline-demo`.
2. In that workspace: **Limits → set a monthly spend limit.** $5 is plenty —
   at roughly $0.02 a call that is ~250 extractions.
3. **Create the API key inside that workspace**, not the default one. Keys,
   spend, and rate limits are all workspace-scoped, so a runaway loop drains
   this budget and stops, instead of your whole account.
4. **Billing → Alerts:** set an email alert well under the cap (say $2), so you
   hear about it before the demo stops working rather than after.

Set the *workspace* limit, not just an account alert. An alert emails you; a
limit refuses the call.

### Layer 2 — the app's own caps (`src/lib/extraction/spend-guard.ts`)

Counted in Postgres, so they hold across serverless instances and survive cold
starts — unlike the in-memory limiter, which cannot bound spend because each
instance keeps its own map.

| Cap | Default | Stops |
|---|---|---|
| `EXTRACTION_HOURLY_CLIENT_CAP` | 10/hour per IP | one visitor looping the Extract button |
| `EXTRACTION_MONTHLY_CAP` | 200/month, whole deploy | a hundred visitors each politely staying under the hourly limit |

At ~$0.02 a call the defaults cap the demo near **$4/month**, comfortably under
a $5 workspace limit. Both are env vars — no redeploy needed to change them,
just an update and a restart.

Budget is only charged once a document is actually claimed, so hammering a
document that is already running or out of attempts cannot drain the month.
Verified by `npm run test:spend-guard` (9 assertions, no API calls).

Check usage at any time:

```sql
select count(*) from extraction_usage
where created_at >= date_trunc('month', now());
```

---

## 6. File storage on Vercel

Vercel's filesystem is read-only except `/tmp`, and `/tmp` does not survive
between invocations. So set `STORAGE_DIR=/tmp/storage` and expect:

- **uploads work** — you can upload, extract, review and export within a session;
- **previews 404 after a cold start**, because the bytes are gone.

The five seeded documents show real extracted data regardless, since extractions
live in Postgres, not on disk. For a portfolio demo that is an acceptable
limitation and honestly stated in the README. The real fix is Vercel Blob:
`src/lib/storage/index.ts` is a three-method interface behind which the local
disk sits, so swapping it is one file plus a token route.

---

## 7. Deploy, then point the domain

1. **Deploy**. Watch the build log for `Invalid environment configuration` —
   that is `env.ts` telling you exactly which variable is missing.
2. Vercel → **Settings → Domains** → add `trueline.janakshan.dev`.
3. At your DNS provider, add the `CNAME` Vercel shows you for the `trueline`
   subdomain. Propagation is usually minutes.
4. Confirm: `dig +short trueline.janakshan.dev` returns records, and the site
   loads over HTTPS.

---

## 8. Verify the live site

Run `scripts/verify-live.sh` (added alongside this doc):

```bash
./scripts/verify-live.sh https://trueline.janakshan.dev
```

It signs in with the demo button and checks the whole path — session cookie
flags, the seeded documents, the reconciliation flag on the mismatch invoice,
CSV export, and that anonymous callers are refused. It never triggers an
extraction, so it costs nothing.

Then click through it once yourself, because a script cannot see a broken
layout:

- [ ] `/` redirects to `/sign-in`
- [ ] **Try the demo** signs you in
- [ ] the documents list shows five rows with status chips
- [ ] the Acme invoice shows the amber reconciliation strip and the £180.00 gap
- [ ] editing the subtotal marks it reviewed and updates the totals
- [ ] **Export CSV** downloads and opens correctly in a spreadsheet
- [ ] the same on a phone-width screen

---

## Rollback

Vercel keeps every deployment: **Deployments → … → Promote to Production** on
the last good one. Migrations are roll-forward only — `0002` is additive and
safe to leave in place, since nothing reads `extraction_usage` unless the
extract route runs.
