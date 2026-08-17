# Trueline — testing

```bash
docker run -d --rm --name trueline-pg -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=trueline -p 55432:5432 postgres:16-alpine
npm run db:seed && npm run dev -- --port 3111
npm test                     # everything
```

**169 assertions, all passing.** No API credits spent — Claude is mocked everywhere.

| Suite | Assertions | Covers |
|---|---|---|
| `typecheck` | — | `tsc --noEmit` under `strict` |
| `test:extraction` | 98 | parser, validation, retry, persistence |
| `test:auth` | 16 | every route rejects anonymous access |
| `test:api` | 28 | HTTP contract per route |
| `test:integration` | 27 | upload → extract → review → export |

---

## What these are for

This is a portfolio demo. The tests exist to stop it embarrassing you in front of a client, so they cover the three things that would actually do that: garbage from the model reaching the database, an endpoint serving data to a stranger, and the demo path breaking between screens.

### 1. Malformed model output

The largest suite, because it is the most likely failure. Rejected: truncated JSON (the most common real malformation — the model hits a token cap mid-object), bare arrays, JSON scalars, trailing commas, `NaN` literals, `line_items` as an object, null/unknown `document_type`, line items missing required fields, and wrong-typed values.

Tolerated where it is safe to: markdown fences, prose wrapping, a leading BOM, `"£1,240.50"`, `"(180.00)"` accounting negatives, `"n/a"`, unicode escapes, unexpected extra fields, empty line-item arrays, negative totals (credit notes), and 2,000-character descriptions.

The load-bearing rule is that unparseable input is **rejected, never silently nulled** — `"about four"` returns `undefined`, so Zod produces a precise error instead of a quiet `null` that looks like a legitimately absent field.

### 2. Auth coverage

The suite **walks the filesystem** rather than listing routes. Asserting "these six routes are protected" proves nothing about the seventh someone adds next month; discovering routes means an endpoint shipped without a guard fails the suite instead of quietly serving another user's invoices.

Every discovered API method must 401 anonymously, every page must redirect to `/sign-in`, and forged cookies are rejected in four shapes — garbage, right-shape-wrong-signature, empty, signature-stripped — plus a validly-signed but expired token.

### 3. Happy path

Real HTTP against the running app for every step: demo login → upload → extract → review → approve → export both CSV shapes → delete. Only the Claude call is injected, and extraction runs through `runExtraction` — the same function the route calls — so parse, validate and persist are the real code.

It asserts the behaviour the product is actually built on: the printed subtotal is stored verbatim, correcting it clears that conflict and surfaces the downstream total conflict, and the edited value reaches the CSV.

---

## Two real bugs these caught

⚠️ **Number coercion silently corrupted scientific notation.** `coerceNumber` stripped every `[A-Za-z]` to remove currency codes, which turned `"1.5e3"` into `"1.53"` — parsed happily as `1.53` instead of `1500`. A **1000× error that looks like an ordinary number**, so nothing downstream could catch it: not the schema (a number is a number), not the reconciliation check (it would just report a mismatch and blame the wrong field), not a reviewer glancing at the form.

Letters are now stripped only at the boundaries (`USD1240`, `1240GBP`), and the numeric pattern accepts an exponent. A letter anywhere else fails the match, so `"12abc34"` is rejected rather than mangled into a number. Regression assertions cover all six cases.

**A false-conflict bug in `validate.ts`**, found earlier by a live extraction: the total formula had no `service_charge` term, so a receipt with an 8.5% service charge raised a red conflict on internally consistent data. Fixed, with the field threaded through schema, type, formula, UI and CSV.

## Two bugs in the tests themselves

Worth recording, because both would have produced false confidence:

- **The BOM assertion checked decoded text.** `fetch().text()` strips a leading BOM per the WHATWG spec, so the check failed while the bytes on the wire were correct (`ef bb bf`, verified with `od`). Now asserted against `arrayBuffer()`. A byte-level guarantee cannot be tested through a decoded string.
- **The runner reported the wrong failing suite** — it read `$1` after `shift`, so every failure was attributed to `npx`.

---

## Deliberately not tested, and why

**Frontend components and browser interaction.** No jsdom, Testing Library, or Playwright. That is the single biggest gap, and it is a deliberate trade: component tests here would mostly assert that React renders props, while the interactions worth testing (drag-and-drop, autosave debounce, the mobile pane switch) need a real browser and a meaningful setup. The API layer beneath the UI is covered, and screenshots caught the two visual bugs that mattered. If this grew past a demo, Playwright on the happy path would be the first addition.

**The live Claude API.** Mocked everywhere. Live behaviour is verified separately and manually by `npm run check:claude`, because with ~$5 of credit a suite that spends money on every run is a suite nobody runs. The mock returns what the real model actually returned — captured from live output, not invented.

**One line inside the extract route.** The integration test calls `runExtraction` directly rather than through `POST /api/documents/[id]/extract`. Covering that seam needs a test-only injection hook in production code; a documented one-line gap is the better trade. The route's own auth, validation, and 409 handling *are* covered by the auth and smoke suites.

**Concurrency and the queue under load.** The atomic claim is tested for the two-tab case (second claim returns null) but not under genuine parallel load. Real contention testing needs a harness that outweighs a single-user demo.

**Neon specifically.** Everything runs against stock Postgres 16 in Docker. Connection-level behaviour — TLS, pooler, statement timeouts — is what a local container cannot exercise, so run the suite once against a real Neon branch before trusting the deploy.

**Rate limiter behaviour across instances.** Verified single-process (fires at attempt 9 of 8/min). It is in-memory by construction, so multi-instance behaviour is known-wrong rather than untested — see `docs/backend.md`.

**Accessibility, performance, visual regression.** No axe, Lighthouse, or snapshot tests. Contrast ratios and focus states were designed in and spot-checked, not asserted.
