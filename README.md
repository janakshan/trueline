# Trueline

Upload an invoice or receipt, Claude extracts the structured fields, and you review and correct them beside the original before exporting to CSV.
The interesting part isn't the extraction — it's the review step: how the app decides which numbers a human needs to look at.

> **This is a portfolio demo, not a product.** Single tenant, no sign-up, no billing, no accounting integrations. It exists to show how I design an AI feature end to end — schema, failure handling, and human-in-the-loop review — rather than to be run by anyone in production. Scope limits and known gaps are listed honestly at the bottom.

---

## Screenshots

**Documents** — status per document, and a flag count that says how many fields want a human.

![Documents list](docs/screenshots/documents.png)

**Review** — extracted fields beside the original PDF, with the reconciliation strip. The model transcribed the printed subtotal of `1,420.00`; the line items sum to `1,240.00`. The app does not pick a winner — it shows the `180.00` gap and lets a person decide.

![Review screen](docs/screenshots/review.png)

<sub>The review screenshot is cropped to the field panel; the full screen is a split pane with the PDF preview on the left, which Chrome's headless renderer captures blank.</sub>

---

## How it works

```mermaid
flowchart TB
    B["Browser"]

    subgraph ingest["Upload"]
        UP["POST /api/documents<br/><i>sniff real content type, 10 MB cap</i>"]
        FS[("File storage<br/><i>local disk behind an interface</i>")]
    end

    subgraph pipeline["Extraction — src/lib/extraction"]
        CLAIM["<b>claim</b><br/><i>atomic UPDATE, one worker wins</i>"]
        CALL["<b>call Claude</b><br/><i>structured output, cached system prompt</i>"]
        PARSE["<b>parse</b><br/><i>JSON → number coercion → Zod</i>"]
        VAL["<b>validate</b><br/><i>arithmetic + structural checks</i>"]
    end

    DB[("Postgres<br/><i>documents · extractions</i>")]
    REVIEW["<b>Review screen</b><br/><i>preview + editable fields</i><br/>status = needs_review"]
    CSV["GET /api/export<br/><i>per document or per line item</i>"]

    B -->|"drag PDF / image"| UP
    UP --> FS
    UP --> DB
    B -->|"Extract"| CLAIM
    CLAIM --> DB
    FS -->|"bytes"| CALL
    CLAIM --> CALL
    CALL --> PARSE
    PARSE --> VAL
    VAL -->|"issues + confidence,<br/>one transaction"| DB
    DB --> REVIEW
    REVIEW -->|"corrections, then Approve"| DB
    DB --> CSV

    classDef check fill:#fef3c7,stroke:#d97706,color:#000
    class VAL,REVIEW check
```

Nothing is ever auto-approved. Every successful extraction lands on `needs_review`, and only a human moves it to `approved`.

---

## Key decisions

**1. The prompt transcribes; it never computes.** The model is told to report the printed subtotal *even when the line items disagree with it*, and the instruction ships with its reasoning so the model doesn't quietly round it off. This feels wrong until you trace the consequence: `validate.ts` compares the printed subtotal against the sum of the line items and flags the difference. If the model "helpfully" corrects the document, that check can never fire and a genuine error reaches the accounts silently. Verified against the real API — on the mismatch sample the model reported `1,420.00`, not the `1,240.00` the rows add up to.

**2. Arithmetic is the trusted signal; model confidence is only a hint.** Reconciliation is deterministic, reproducible, and explainable to a client — it catches the failure that actually matters, a plausible number in the wrong place. Self-reported confidence gets a coloured dot, nothing more. Every flag carries a message a reviewer can act on (`Line items total 1,240.00 but subtotal reads 1,420.00 — 180.00 difference`), because a flag without a legible reason is just a yellow box.

**3. Uncertainty is sparse by design.** The model populates `uncertain_fields` only where it is genuinely unsure, with a one-sentence reason, and is told an empty array is the expected answer for a clean document. Asking for a confidence score on all 15 fields invites `0.95` across the board — noise dressed as signal. Silence is the signal: if everything is flagged, nothing is.

**4. Retry only what a retry can plausibly fix.** Failures are split into retryable and permanent rather than being counted together. Malformed output gets one repair attempt with a hint naming the offending field paths, so attempt two is corrective instead of a blind re-roll; a 401 or a refusal gets none. Attempts cap at 3, and the run holds its own 50s deadline under the route's 60s limit so a timeout writes a clean error row instead of being killed mid-write. Automatic retry of a permanent failure is how a free-tier demo drains its API budget overnight.

**5. The database owns its invariants.** Generated columns derive `vendor_name`, `total_amount`, and `issue_date` from the extraction JSON so the list view is plain indexed SQL that cannot drift; a partial unique index enforces one current extraction per document; CHECK constraints encode the states the UI depends on. Migrations are numbered raw SQL with a ~90-line runner, while Drizzle handles queries with types pulled *from* the live schema — so the database is the source of truth and the types follow it.

---

## Tech stack

| | | |
|---|---|---|
| **Next.js 15** (App Router) + **React 19** | one repo, one deploy | server components for the data screens, client components only where there's state |
| **TypeScript** + **Zod** | one schema, four jobs | Zod defines the extraction shape, generates the JSON Schema sent to Claude, validates the response at runtime, and infers the stored type |
| **Postgres 16** + **Drizzle ORM** | `node-postgres`, not the Neon HTTP driver | the HTTP driver only speaks to Neon's proxy, which would make the backend untestable outside a deploy |
| **Tailwind v4** | semantic design tokens, not palette names | `bg-review-bg` says what it means; amber is reserved for "a human should look at this" and never used as decoration |
| **`@anthropic-ai/sdk`** | streaming, structured outputs, prompt caching | model and effort are env-driven so cost/quality tunes without a redeploy |
| **`node:crypto`** | scrypt hashing + HMAC-signed session cookie | no auth dependency; unknown email and wrong password fail identically so responses can't enumerate accounts |

No test framework, no component library, no state manager — the harnesses are plain TypeScript and the components are hand-rolled against the design tokens.

---

## Run it locally

Requires **Node 20+** (developed on 24) and Docker for Postgres.

```bash
git clone git@github.com:janakshan/trueline.git
cd trueline
npm install

# Postgres
docker run -d --name trueline-pg -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=trueline -p 55432:5432 postgres:16-alpine

# Config — only DATABASE_URL and SESSION_SECRET are required to boot
cp .env.example .env.local
#   DATABASE_URL=postgres://postgres:test@localhost:55432/trueline
#   SESSION_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")

npm run db:seed     # schema + demo account + 5 sample documents
npm run dev
```

Open <http://localhost:3000> and click **Try the demo** — it mints the session server-side, so no password is sent to the browser. (The seeded account's password is not in the repo, by design; the button is the way in.)

**`ANTHROPIC_API_KEY` is optional.** Upload, list, review, and export all work without it against the seeded extractions — only running a *new* extraction needs a key, and it fails with a message naming the variable. With a key set, `npm run check:claude` does a live end-to-end check against a sample PDF and prints tokens, cost, and elapsed time without touching the database.

| Command | |
|---|---|
| `npm run dev` | dev server |
| `npm test` | every suite (needs the dev server up) |
| `npm run db:seed` / `db:status` | seed / list migrations |
| `npm run samples` | regenerate the sample PDFs |
| `npm run check:claude` | live API check — needs a real key |

---

## Tests

`npm test` runs a typecheck plus four suites — **170 assertions**, all passing:

| Suite | | Covers |
|---|---|---|
| parser + pipeline | 98 | schema generation, defensive parsing, validation, retry paths, atomic claim |
| auth coverage | 16 | 9 method+path combinations, page redirects, forged and expired session cookies |
| api smoke | 29 | every route's success and rejection cases |
| integration | 27 | upload → extract → correct → approve → export, end to end |

The auth suite walks the filesystem to discover every route and page rather than listing them, so a route added later is covered the day it lands — the failure it's guarding against is a future omission, not a current hole.

The parser suite is the one worth reading: `"£1,240.50"` coerces to `1240.5`, `"(180.00)"` to `-180`, `"n/a"` to `null` — but `"about four"` is **rejected rather than silently nulled**, and the ambiguous date `03/04/2026` is stored `null` and flagged rather than guessed.

The API suite tags its own uploads with a `zz-smoke-` filename prefix and cleans up only those. An earlier version identified test data by exclusion — "anything without the seed prefix" — and deleted a real upload. Identify test data by something the test controls, never by what it isn't.

---

## Scope and known gaps

**Deliberately out of scope:** multi-user accounts and roles, password reset, OCR of handwriting, document types beyond invoices and receipts, accounting integrations, duplicate detection, approval workflows, audit log, exports other than CSV.

**Known gaps, honestly:**

- **`npm run db:seed` leaves 4 of 5 document previews 404ing.** `scripts/seed-files.mjs` copies the samples to `.storage/samples/`, but `db/seed.sql` — regenerated later from live extractions — points those rows at `documents/<id>/<filename>`. The fields and flags all render correctly; only the preview pane is affected.
- **No rate limiting on the extract route.** Sign-in is rate limited; extraction is not, which is the top risk for a publicly reachable demo.
- **Accuracy is not benchmarked.** The samples show the workflow, not a claimed extraction accuracy figure. Cost measured at roughly $0.02 per single-page sample — re-measure before quoting anything for dense multi-page scans.
- **Verified on stock Postgres 16, not on Neon.** Nothing here uses an exotic feature, but connection-level behaviour is the part a local container can't exercise.
- **`page_count` is always null**, and the prompt is untuned — `PROMPT_VERSION` is recorded on every row so the effect of a change is measurable once there's real output to compare.

Design notes and reasoning live in [`architecture.md`](architecture.md), [`REQUIREMENTS.md`](REQUIREMENTS.md), [`ui-plan.md`](ui-plan.md), and [`docs/`](docs/).
