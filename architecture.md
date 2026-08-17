# Trueline — Architecture (v1)

Companion to `REQUIREMENTS.md`. Decisions, trade-offs, and the shape of the build. No app code yet.

---

## 1. The three constraints that drive everything

Before folder structure, three platform limits shape every decision below. Get these wrong and the app looks fine locally and breaks on deploy.

**1. Vercel serverless request bodies cap at ~4.5 MB.** Our files go to 10 MB. So the browser cannot POST a file to an API route. Files must upload **direct from browser to blob storage**, and the API route only ever sees a URL. This is the single biggest shape-changer.

**2. Serverless functions have a wall-clock ceiling.** Hobby functions default to 10s; you raise it per-route with `maxDuration`. The ceiling has moved around with Vercel's Fluid Compute rollout, so verify what your account actually allows rather than trusting a number — but **design so no single request needs more than ~60s**. One Claude extraction fits in that budget. A batch of twenty does not. Therefore: **one document = one function invocation**, and something outside the function drives the queue.

**3. Neon free tier is 0.5 GB and auto-suspends after ~5 minutes idle.** Two consequences: don't put file bytes in Postgres, and expect a cold-start delay on the first query after the demo sits idle — which is exactly when a client clicks your portfolio link. Use the HTTP driver (no TCP pool to warm) and keep the first page's query count low.

---

## 2. Data flow: upload → extract → review → export

### Upload

```
Browser                          Vercel                        Blob store        Neon
   |                                |                              |               |
   | 1. pick files                  |                              |               |
   | 2. resize images (canvas)      |                              |               |
   |    to <=2576px long edge       |                              |               |
   |                                |                              |               |
   | 3. POST /api/uploads/token ---->|                             |               |
   |    (filename, size, type)      | validate type/size, sign     |               |
   |<------- upload token ----------|                              |               |
   |                                |                              |               |
   | 4. PUT file bytes ------------------------------------------->|               |
   |<------------------------------------------- blob URL ---------|               |
   |                                |                              |               |
   | 5. POST /api/documents -------->| insert row                                   |
   |    (blobUrl, filename, ...)    | status = 'queued' -------------------------->|
   |<------- document id -----------|                                              |
```

The file never passes through a function body, so the 4.5 MB cap is irrelevant. Images are downscaled **in the browser** with a `<canvas>` — Claude's high-resolution tier caps at 2576px on the long edge, so anything larger is bandwidth and tokens you pay for and the model discards. Zero dependencies, and it makes uploads faster too.

### Extract

The queue lives in Postgres. The **browser tab is the driver**, not the owner:

```
Browser                              /api/documents/[id]/extract
   |                                          |
   | for each queued doc, max 2 at a time     |
   | POST /extract ------------------------->  |
   |                                          | 1. CLAIM (atomic):
   |                                          |    UPDATE documents SET status='processing',
   |                                          |      attempts = attempts + 1,
   |                                          |      processing_started_at = now()
   |                                          |    WHERE id = $1
   |                                          |      AND (status IN ('queued','failed')
   |                                          |           OR processing_started_at < now() - '90 seconds')
   |                                          |    RETURNING *
   |                                          |    -> 0 rows = someone else has it. Return 409, move on.
   |                                          |
   |                                          | 2. fetch bytes from blob URL
   |                                          | 3. base64 -> Claude content block
   |                                          |      PDF   -> { type: 'document', ... }
   |                                          |      image -> { type: 'image', ... }
   |                                          | 4. messages.stream(), structured output
   |                                          | 5. Zod-validate the result
   |                                          | 6. run arithmetic + sanity checks
   |                                          | 7. write header + line items + flags
   |                                          |    status = 'needs_review' (or 'failed')
   |<------------------ status ---------------|
   |                                          |
   | poll GET /api/documents every 2s while any doc is 'processing'
```

**Why the browser drives it.** Vercel Hobby has no job queue and cron is far too coarse for a demo. The alternatives were a self-invoking function chain (fragile, and a runaway loop burns API credit) or holding one long request open (blows the time budget). A client-driven loop with an atomic claim in the database is simple, observable, and resumable — reload the page and it picks up anything still `queued`. The honest cost: **close the tab mid-batch and the remaining documents stay queued** until someone opens the app again. For a single-user demo that is an acceptable, explainable trade-off — and "resume on load" turns the weakness into a visible feature.

**Why the atomic claim matters.** Two open tabs would otherwise extract the same document twice and double the API bill. The conditional `UPDATE ... RETURNING` is the lock; if it returns no rows, another invocation owns it. The `processing_started_at < now() - 90s` clause is the other half: a function that times out mid-extraction leaves a row stuck in `processing` forever, and this reclaims it. **Every queue needs a stuck-job story** — most demos forget it and look broken the first time a request dies.

### Review

Preview on the left, form on the right, autosave on the right.

- PDF preview: a native `<embed>` / `<object>` pointed at the blob URL. The browser already has a PDF renderer; pulling in pdf.js (~1 MB) to duplicate it is not worth it. **Trade-off:** no bounding-box highlights linking a field to its spot on the page. That's genuinely nice-to-have, and it's out of scope in v1.
- Image preview: `<img>` with pan/zoom via CSS transforms.
- Header edits: `PATCH /api/documents/[id]` with a partial body, debounced ~500ms, optimistic UI.
- Line items: `PUT /api/documents/[id]/line-items` replacing the whole array. Replacing beats per-row PATCH/POST/DELETE because reordering and inserting rows would otherwise mean juggling ids and positions across three endpoints. At ~30 rows the payload is trivial.
- Totals recompute **client-side as you type** (instant feedback) and are **re-validated server-side on save** (the client is never the authority).

### Export

`GET /api/export?scope=selected&ids=...&granularity=line-item` streams back `text/csv` with a `Content-Disposition` header — a plain link the browser downloads. Two shapes:

- `granularity=document`: one row per document, line items collapsed to a count.
- `granularity=line-item`: one row per line item, header fields repeated on each row. This is the one bookkeepers actually want.

Written by hand (~30 lines). CSV writing is quoting rules, not a parsing problem, so a library isn't earning its place. Two details that matter and that most hand-rolled writers miss:

- **UTF-8 BOM** at the start, or Excel mangles non-ASCII vendor names.
- **CSV injection**: prefix any cell starting with `=`, `+`, `-`, or `@` with a single quote. A vendor name of `=cmd|...` in a spreadsheet is a real attack, and shipping a demo with that hole is a bad look on a portfolio piece.

---

## 3. PDFs vs images for the Claude API

Both go inline as base64 in the request. No client-side PDF text extraction, no OCR step — Claude reads PDFs natively, both the text layer and the visual layout, which is what makes line-item tables work.

| | PDF | Image |
|---|---|---|
| Content block | `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }` | `{ type: "image", source: { type: "base64", media_type: "image/png" \| "image/jpeg", data } }` |
| Pre-processing | none | downscale to ≤2576px long edge, browser-side |
| Hard limits | 32 MB request, page count well above our 10-page cap | ~4,784 tokens per image at full resolution |
| Our cap | 10 MB → ~13.3 MB base64, comfortably inside the request limit | 10 MB pre-resize, typically <1 MB after |

Two things to get right:

- **Base64 must have no newlines.** A wrapped base64 string is a confusing 400.
- **Block order:** document/image block *first*, then the text instruction. This is the documented ordering and it measurably helps.

**Considered and deferred: the Files API.** Uploading once and referencing a `file_id` would avoid re-sending bytes on every retry. It's a beta surface with its own header and an extra failure mode, and our retry volume is tiny. Inline base64 now; revisit if retries ever become the dominant cost.

### Extraction request shape

- Model: `claude-opus-5`.
- Structured output: `output_config.format` built from the Zod schema via the SDK's `zodOutputFormat` helper, so the response is schema-constrained rather than prose we parse hopefully.
- `effort: "medium"`. Opus 5 is unusually strong at low/medium, and extraction is perception plus transcription, not deep reasoning. Medium keeps us inside the time budget. Treat this as a tuning knob, not a constant — sweep it against a folder of real invoices before you call it done.
- Streaming (`messages.stream()` + `getFinalMessage()`). Not for UI — for timeout safety. The SDK guards against non-streaming requests with large `max_tokens`, and streaming keeps the connection alive.
- `max_tokens: 16000`. **Thinking is on by default on Opus 5 and counts against `max_tokens` alongside the response.** Size this for both or you get truncated JSON, which surfaces as a schema-validation failure and looks like a model problem when it's a config problem.
- **Prompt caching** with a `cache_control` breakpoint at the end of the system prompt. The system prompt (field definitions, extraction rules, edge-case guidance) is identical on every request; the document is not. Classic shared-prefix / varying-suffix — cache reads run about a tenth of input price.

**Cost, roughly.** A 5-page invoice lands somewhere around 8–12k input tokens and 1–3k output, so on the order of **$0.05–0.15 per document** at Opus 5 pricing. Measure it with `count_tokens` on a real sample before you publish the link — don't quote my estimate to a client.

⚠️ **A public demo with a shared account is an open faucet on your API credit.** Before the URL goes in a proposal: a per-day document cap on the seeded account, a hard rejection of files over the size limit, and a spend alert on the Anthropic console. This is the thing most likely to actually bite you.

---

## 4. Error-handling strategy for AI failures

The organising principle: **there is no "trust the model" path.** Every document lands in human review regardless of how confident the extraction looked. Validation doesn't gate anything — it decides *where the reviewer looks first*. That framing is worth stating out loud to clients, because it's the difference between a demo and a liability.

### Two separate concepts, often conflated

**Extraction failed** — we have no data. Terminal or retryable, shown as a `failed` row with a reason and a retry button.

**Extraction succeeded but is suspect** — we have data with flags on it. This is the *normal* path, not an error. Status `needs_review`, flagged fields highlighted.

### Failure taxonomy

| Failure | Detection | Class | Response |
|---|---|---|---|
| Function timeout | request dies mid-extraction | retryable | stale-claim sweep reclaims the row after 90s; retry |
| Rate limited (429) | SDK exhausts its own retries | retryable | back off, respect `retry-after`, surface "busy, retrying" |
| Overloaded (529) | API status | retryable | exponential backoff |
| Malformed / schema-invalid output | Zod parse fails | retryable **once** | one clean retry; then fail and store the raw text |
| Truncated output (`stop_reason: "max_tokens"`) | check `stop_reason` | retryable **once** | retry with higher `max_tokens`; usually a config bug |
| Refusal (`stop_reason: "refusal"`) | check `stop_reason` **before reading content** | permanent | show plainly, no retry |
| Bad request (400) — file too large, too many pages, corrupt PDF | API error | permanent | actionable message; don't burn retries |
| Auth / billing (401/403) | API error | permanent | operator problem, not a user problem — say so |

Rules that hold across all of them:

- **Cap attempts at 3**, then require an explicit human retry. Automatic infinite retry on a permanent failure is how a free-tier demo silently drains an API budget overnight.
- **Check `stop_reason` before touching `response.content`.** Code that reads `content[0].text` unconditionally throws on a refusal, and the resulting stack trace tells you nothing about what actually happened.
- **Store `error_code`, `error_message`, `attempts`, and a truncated `raw_response`** on the row. Truncate hard (~8 KB) — Neon's 0.5 GB fills faster than you'd think, and you only need enough to diagnose.
- **Distinguish retryable from permanent in the schema**, not in a string match on the error message.

### Validation: what actually flags a field

Three signals, in descending order of how much I'd trust them:

1. **Arithmetic.** `subtotal + tax + shipping − discount = total`, and `sum(line_total) = subtotal`, each within a small tolerance for rounding. This is deterministic, explainable, and catches the failure mode that matters most — a plausible-looking number in the wrong place.
2. **Structural rules.** Required field missing. Date not parseable or implausibly far from today. Currency not a valid ISO 4217 code. Negative quantity. `due_date` before `issue_date`.
3. **Model-reported confidence**, stored as a `field_confidence` JSON object alongside the row.

⚠️ **Be honest about signal 3.** Self-reported LLM confidence is weakly calibrated — a model can be fluently confident and wrong. Treat it as a soft hint that colours a field amber, never as a gate. **The arithmetic check is the load-bearing signal** and it's also the one that demos well, because you can show it catching a real error live. If a client asks "how do you know it's right?", the answer is the reconciliation check and the human in the loop — not a confidence score.

Every flag carries a human-readable reason (`"Line items sum to 1,240.00 but subtotal reads 1,420.00"`), stored in a `validation_issues` JSON column and rendered next to the field. A flag without a reason is just a scary yellow box.

---

## 5. Data model

Hybrid: typed columns for anything queried, exported, or validated; JSON for sparse metadata.

- **`users`** — `id`, `email`, `password_hash`, `created_at`
- **`documents`** — `id`, `user_id`, file metadata (`filename`, `mime_type`, `size_bytes`, `page_count`, `blob_url`), queue state (`status`, `attempts`, `processing_started_at`, `error_code`, `error_message`, `raw_response`), the fifteen header fields from `REQUIREMENTS.md` as real columns, plus `field_confidence` (jsonb), `validation_issues` (jsonb), and usage telemetry (`model`, `input_tokens`, `output_tokens`)
- **`line_items`** — `id`, `document_id`, `position`, `description`, `quantity`, `unit_price`, `line_total`

Status enum: `queued → processing → needs_review → approved`, plus `failed`. Note there is no `auto_approved` — by design.

**Why typed columns and not one jsonb blob.** CSV export becomes a plain `SELECT`, the arithmetic checks can run in SQL, and the database enforces types instead of hoping the app does. Money as `numeric`, never float. The cost is a migration whenever the field list changes, which for a fixed schema like invoices is a fine trade.

---

## 6. Folder structure

```
trueline/
├─ src/
│  ├─ app/
│  │  ├─ (auth)/sign-in/page.tsx
│  │  ├─ (app)/
│  │  │  ├─ layout.tsx                    # session guard, nav
│  │  │  ├─ documents/page.tsx            # list + upload dropzone
│  │  │  └─ documents/[id]/page.tsx       # review: preview | form
│  │  ├─ api/                             # see route list below
│  │  ├─ layout.tsx
│  │  └─ globals.css
│  ├─ components/
│  │  ├─ upload/                          # dropzone, client-side resize, queue driver
│  │  ├─ review/                          # preview pane, header form, line-item grid
│  │  ├─ documents/                       # table, status chip, export dialog
│  │  └─ ui/                              # shared primitives
│  ├─ lib/
│  │  ├─ auth/                            # hashing, session cookie, getSession()
│  │  ├─ db/                              # drizzle client, schema.ts, queries/
│  │  ├─ extraction/
│  │  │  ├─ schema.ts                     # Zod — the single source of truth
│  │  │  ├─ prompt.ts                     # system prompt (cached prefix)
│  │  │  ├─ client.ts                     # Claude call, streaming, retries
│  │  │  └─ errors.ts                     # failure taxonomy -> error_code
│  │  ├─ validation/                      # arithmetic + structural checks
│  │  └─ export/                          # CSV writer, BOM, injection guard
│  └─ middleware.ts                       # redirect unauthenticated -> /sign-in
├─ drizzle/                               # generated migrations
├─ scripts/seed.ts                        # demo user + sample documents
└─ .env.example
```

`lib/extraction/schema.ts` is the keystone. One Zod schema produces the JSON Schema sent to Claude, validates the response that comes back, and types the database writes. When a field changes, it changes in exactly one place.

---

## 7. API routes

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/auth/sign-in` | verify password, set session cookie |
| `POST` | `/api/auth/sign-out` | clear cookie |
| `POST` | `/api/uploads/token` | validate type/size, return a signed direct-upload token |
| `POST` | `/api/documents` | create rows from completed blob uploads (`status = 'queued'`) |
| `GET` | `/api/documents` | list; the polling endpoint |
| `GET` | `/api/documents/[id]` | header + line items + flags |
| `PATCH` | `/api/documents/[id]` | field edits and approval |
| `DELETE` | `/api/documents/[id]` | delete row and blob |
| `PUT` | `/api/documents/[id]/line-items` | replace the line-item array |
| `POST` | `/api/documents/[id]/extract` | claim + extract. `maxDuration` raised. Also serves retry. |
| `GET` | `/api/export` | CSV download |

Eleven routes. `extract` doubles as retry because the atomic claim already accepts `failed` rows — a separate `/retry` endpoint would be the same code behind a second name.

**Polling, not SSE.** An SSE stream holds a serverless function open for its whole lifetime, which burns the exact budget we're trying to protect. A 2-second poll while anything is `processing`, and nothing at all when the list is idle, is cheaper and simpler. Real-time push is the right answer on infrastructure we don't have here.

---

## 8. Dependencies, and what each one buys

| Package | Why it earns its place |
|---|---|
| `@anthropic-ai/sdk` | non-negotiable |
| `zod` | one schema drives the Claude JSON Schema (`zodOutputFormat`), response validation, and request-body validation. Three jobs, one dependency. |
| `drizzle-orm` + `drizzle-kit` | typed SQL and migrations with a near-zero runtime |
| `@neondatabase/serverless` | HTTP driver — no TCP connection pool to exhaust or warm up on serverless |
| `@vercel/blob` | direct browser→storage uploads; the only clean way past the 4.5 MB body cap |

**Deliberately not added:**

- **An auth library.** Single user, one seeded account. `node:crypto` gives `scrypt` for hashing and HMAC for a signed session cookie, with `timingSafeEqual` for comparison — no dependency at all. ⚠️ This is defensible *because* it's single-tenant. The moment Trueline grows real users, replace it with Auth.js; hand-rolled auth is a footgun at any larger scale, and I'd say so unprompted to a client rather than let them discover it.
- **pdf.js.** The browser renders PDFs. Covered above.
- **A CSV library.** Writing CSV is quoting rules, not parsing.
- **`sharp`.** Image resizing happens in the browser via canvas — no server dependency, no cold-start weight, less upload bandwidth.
- **A state management library.** React state plus route handlers covers this app.

**One revision to `REQUIREMENTS.md`:** that doc named Prisma. I'd use **Drizzle** instead. Prisma ships a query-engine binary that adds meaningful cold-start latency, and on a free-tier demo the cold start *is* the first impression a client gets. Drizzle compiles to SQL with almost no runtime. If you'd rather keep Prisma for familiarity, that's a legitimate call — just know you're trading first-load speed for DX.

---

## 9. Known risks

1. **Closing the tab pauses the batch.** Documented above; resume-on-load mitigates it. The real fix is a job queue, which the free tier doesn't offer.
2. **Neon cold start on an idle demo.** First query after ~5 minutes idle is slow. Keep the documents page to a single query, and consider a skeleton state so it reads as loading rather than broken.
3. **Public demo cost exposure.** Cap documents per day, enforce file size, set a spend alert. Do this *before* the link goes out.
4. **Extraction quality is unmeasured.** Nothing here proves accuracy. If you want a number for your portfolio, build a small labelled set (20–30 real invoices) and measure field-level accuracy — otherwise make no claim at all.
5. **`maxDuration` ceilings shift.** Verify what your account allows rather than trusting a documented default, and keep the per-document budget well under it.
