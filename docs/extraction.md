# Trueline — extraction (increment 2)

```
src/lib/extraction/
├─ prompt.ts      the prompt — tune freely, nothing else depends on its wording
├─ schema.ts      Zod → JSON Schema → runtime validation → stored type
├─ client.ts      Claude call: streaming, caching, injectable transport
├─ parse.ts       defensive parsing and number coercion
├─ validate.ts    arithmetic and structural checks → validation_issues
├─ errors.ts      failure taxonomy (retryable vs permanent)
└─ run.ts         claim → extract → validate → persist

src/app/api/documents/[id]/extract/route.ts
scripts/make-samples.mjs      three sample PDFs, no dependencies
scripts/test-extraction.ts    75 assertions
```

```bash
npm run samples           # regenerate sample PDFs
npm run test:extraction   # 75 assertions, no API key needed
npm run test:api          # 27 route assertions
npm run check:claude      # live end-to-end check — needs a real key
```

---

## Configuration

Copy `.env.example` to `.env.local`. **`ANTHROPIC_API_KEY` is optional at boot** — upload, list, and detail all work without it, and only extraction fails, with a message naming the variable and where to put it. Everything else is required and validated at startup, so a misconfigured deploy fails immediately rather than mid-request.

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Optional at boot; required to extract |
| `EXTRACTION_MODEL` | `claude-opus-5` | |
| `EXTRACTION_EFFORT` | `medium` | `low` … `max` |
| `EXTRACTION_MAX_TOKENS` | `16000` | covers thinking **and** the response |
| `EXTRACTION_RETRY_MAX_TOKENS` | `32000` | truncation retry only |
| `EXTRACTION_BUDGET_MS` | `50000` | must stay under the route's `maxDuration` (60s) |

Model and effort are env-driven so cost/quality can be tuned without a code change or redeploy. The key is passed explicitly to the SDK rather than picked up implicitly from `process.env`, so the value validated at boot is the value used.

**When the key arrives, run `npm run check:claude` first.** It calls the API with a sample PDF, validates the response through the real pipeline, and prints tokens, cost, elapsed time, extracted fields, and flags — without touching the database. It fails loudly and specifically if the API rejects the generated JSON Schema, which is the failure mode most likely to still be lurking.

---

## Prompt design

**Transcribe, never compute — the one instruction the whole product rests on.** The prompt tells the model to report the printed subtotal even when the line items disagree with it. That feels wrong until you see the consequence: `validate.ts` compares the two and flags the difference for a human. If the model "helpfully" corrects the document, that check can never fire, and a real error reaches the accounts silently. The instruction is stated with its reasoning, because an unexplained rule that contradicts a model's instinct to be helpful is one it will quietly round off.

**The schema owns field meanings; the prompt owns judgment.** Field semantics live in Zod `.describe()` and reach the model inside the JSON Schema, so `subtotal` is defined in exactly one place. The prompt covers only what a schema cannot express: which party is the vendor, how to resolve an ambiguous date, that absent means `null` rather than inferred. Restating field definitions in prose would create two sources of truth that drift apart at the first edit.

**Sparse uncertainty, not blanket confidence.** The model is asked to populate `uncertain_fields` *only* where it is genuinely unsure, with a one-sentence reason — and told explicitly that an empty array is the expected answer for a clean document. Asking for a confidence score on all 15 fields invites `0.95` across the board, which is noise dressed as signal. This also holds the review UI to `ui-plan.md`'s rule that silence is the signal: if everything is flagged, nothing is.

---

## Pipeline

```
claim (atomic UPDATE)
  ↓  bytes from storage
  ↓  Claude: streaming, structured output, cached system prompt
  ↓  parse: JSON extraction → number coercion → Zod
  ↓  validate: arithmetic + structural → issues, confidence
  ↓  persist: one transaction
     → status = needs_review (never auto-approved)
```

**PDFs and images differ only in the content block** — `document` vs `image`, both base64 inline, both placed before the text instruction. **`max_tokens` is 16,000** because thinking is on by default on Opus 5 and counts against the same budget; sizing it for the answer alone truncates mid-JSON. **The system prompt carries a cache breakpoint** — it is byte-identical every call and the document is the only varying part, which is the textbook shared-prefix case.

**Nothing unvalidated ever reaches the database.** The write happens only after Zod passes, inside one transaction that unsets the previous current extraction, inserts the new one, and updates the document. A failure writes only the document's error fields — verified: after a doubly-malformed response there are zero extraction rows.

---

## Failure handling

One repair retry, and only for failures a retry can plausibly fix:

| Failure | Retried? | Code |
|---|---|---|
| Malformed / schema-invalid output | once, with a hint naming the bad paths | `SCHEMA_INVALID` |
| Truncated at `max_tokens` | once, at 32k | `OUTPUT_TRUNCATED` |
| Refusal | no | `REFUSED` |
| 400 invalid request | no | `INVALID_REQUEST` |
| 401/403 credentials | no | `NOT_AUTHORISED` |
| Unreadable file | no | `FILE_UNREADABLE` |
| 429 / 5xx / network / timeout | not in-process; document returns to `failed` for a later attempt | `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `NETWORK_ERROR`, `TIMEOUT` |

The repair hint quotes the offending field paths, so attempt two is corrective rather than a blind re-roll. Attempts are capped at 3, after which the route returns 409 — automatic retry of a permanent failure is how a free-tier demo drains its API budget overnight.

**Timeouts are budgeted, not per-call.** The run holds a 50s deadline under the route's `maxDuration = 60`, so our own abort fires first and writes a clean `TIMEOUT` row instead of the platform killing the function mid-write. A second attempt is not started if under 12s remain — an attempt that cannot finish still burns the tokens it generates before the abort lands.

---

## Two bugs the tests caught

⚠️ **The JSON Schema was invalid and every live call would have 400'd.** `z.number().int()` makes Zod emit `minimum`/`maximum` at the safe-integer bounds, and structured outputs reject numeric constraints. `buildOutputSchema()` now strips unsupported keywords recursively — which also means a future Zod release emitting a new keyword degrades to "ignored" rather than "every extraction fails". This would only have surfaced on the first real API call.

⚠️ **A missing API key was classified as retryable.** The SDK throws a plain `Error` with no HTTP status ("Could not resolve authentication method…"), which fell through to `UNKNOWN` and burned all three attempts against a problem no retry can fix. Now matched to `NOT_AUTHORISED`. Confirmed live over HTTP: three attempts consumed, then 409.

Both have regression tests.

---

## Test results

**75 assertions, all passing** — schema generation, defensive parsing, validation, three end-to-end runs, the retry paths, the atomic claim, and re-extraction history. Highlights:

| | |
|---|---|
| Markdown-fenced and prose-wrapped responses | parse |
| `"£1,240.50"`, `"(180.00)"`, `"n/a"`, `""` | coerce to `1240.5`, `-180`, `null`, `null` |
| `"about four"` | rejected, **not** silently nulled |
| Sample 2 mismatch | `Line items total 1,240.00 but subtotal reads 1,420.00 — 180.00 difference` |
| Printed subtotal 1,420.00 | stored verbatim, not corrected |
| Ambiguous date `03/04/2026` | stored `null` and flagged, never guessed |
| Malformed → valid | succeeds in exactly 2 calls |
| Malformed → malformed | fails, **0 extraction rows written** |
| 400 / credentials | 1 call, no retry |
| Concurrent claim | second returns null |
| Re-extraction | old row retained, exactly one current |

**Sample documents** are three generated PDFs (`npm run samples`): a clean invoice, one whose line items deliberately disagree with its printed subtotal, and a receipt with an ambiguous `03/04/2026` date and no tax ID. Generated by a hand-rolled ~120-line PDF writer rather than pulling in `pdf-lib` for three text-only pages. Rendered and visually confirmed to look like real invoices.

## Live results — verified against the real API

All three samples extracted correctly on `claude-opus-5` at `effort: medium`.

| Sample | Time | In / Out tokens | Cost | Outcome |
|---|---|---|---|---|
| Clean invoice | 6.3s | 2,020 / 442 | ~$0.021 | every field correct, reconciles, **no flags** |
| Mismatch invoice | ~7s | ~2,000 / ~450 | ~$0.021 | **transcribed the printed 1,420.00**, conflict raised |
| Receipt | ~7s | ~2,000 / ~500 | ~$0.021 | correct fields; one false conflict — see below |

**The schema is accepted.** The 400 I was most worried about did not happen.

**The central prompt instruction holds under a real model.** On the mismatch
invoice the model reported the printed subtotal of 1,420.00 rather than
"correcting" it to the 1,240.00 the line items sum to — so the reconciliation
check fired with the exact intended message. That behaviour is the product;
verifying it against the real model rather than a fixture is what makes it a
finding rather than an assumption.

**Ambiguous dates are reasoned, not guessed.** The receipt prints `03/04/2026`
with no explicit month. The model returned `2026-04-03` (day-first) and did not
flag it — correct, because the Sheffield address is evidence, which is exactly
what the prompt asks it to look for.

**Cost is ~4× lower than the estimate in `architecture.md`** ($0.021 vs the
$0.05–0.15 range). These are small single-page PDFs; a dense multi-page scan
will cost more. Re-measure before quoting a figure to a client.

⚠️ **Found a real bug in `validate.ts`: no concept of a service charge.**

The receipt prints `Subtotal 14.30 / Service 8.5% 1.22 / TOTAL 15.52` and
states "No VAT charged". The model correctly set `tax_amount: null` and
explained that the 1.22 is a service charge, not tax — **more correct than the
hand-written fixture in `seed.sql`**, which had recorded it as tax.

But the total check is `subtotal + tax + shipping − discount = total`, which
has nowhere to put 1.22, so it raises a **red conflict on a receipt that is
internally consistent**. A false red on clean data is the exact failure
`ui-plan.md` warns about — it teaches reviewers to ignore red.

The fix is a `service_charge` field (common on hospitality and restaurant
receipts, genuinely distinct from both tax and shipping). It touches the
extraction schema, the `ExtractionData` type, the total formula, the review
form, and the CSV headers. **Not yet done** — it changes the agreed field list
in `REQUIREMENTS.md`.

---

## Dependencies added

| Package | Why |
|---|---|
| `@anthropic-ai/sdk` | required for the extraction call |
| `tsx` (dev) | runs the TS test harness with tsconfig path aliases; Node's native type stripping doesn't resolve `@/*` |

---

## Open items

1. **No live verification** — see above. The single most important next step.
2. **Cost is unmeasured.** `architecture.md` estimates $0.05–0.15/document; measure with `count_tokens` on the samples before publishing a demo link.
3. **No rate limiting.** Still the top risk for a public demo. Belongs on this route now that it exists.
4. **`page_count` still null.** Claude could report it as an extraction field — a one-line schema addition.
5. **Prompt is untuned.** `PROMPT_VERSION` is recorded on every row so the effect of a change is measurable once there's real output to compare.
