# Trueline — frontend (increment 3)

All four screens from `ui-plan.md`, plus the endpoints they needed.

```bash
docker run -d --rm --name trueline-pg -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=trueline -p 55432:5432 postgres:16-alpine
export DATABASE_URL="postgres://postgres:test@localhost:55432/trueline"
export SESSION_SECRET="dev-only-secret-at-least-32-characters-long"
npm run db:seed && npm run dev -- --port 3111
```

Sign in at `/sign-in` — **Try the demo** needs no credentials.

---

## State: no library, and why

Server components own the data and query the database directly through
`lib/documents/queries.ts` — the same functions the API routes call, so the two
cannot drift. An internal HTTP round trip to reach our own database would be
pure latency, and on a cold Neon instance it is latency that shows.

Filtering lives in the **URL**, so it is server-rendered, shareable, and
survives a reload for free. That leaves three pieces of genuinely client-side
state, each owned by exactly one component and read only by its own children:

| State | Owner |
|---|---|
| Row selection, dialog open/closed | `documents-view.tsx` |
| Upload queue and per-file progress | `upload-panel.tsx` |
| Form values, save status, mobile tab | `review-view.tsx` |

Redux, Zustand, and Jotai solve *cross-tree* state sharing. There is none here,
so any of them would add a dependency, a provider, and a second place to look
for the truth in exchange for nothing. Mutations `POST`/`PATCH` and then call
`router.refresh()`, which re-runs the server component and pulls back
server-recomputed state — including re-validated flags after an edit.

**Dependencies added: `tailwindcss`, `@tailwindcss/postcss`.** No component
library, no icon package (~10 inline SVGs), no `clsx`/`tailwind-merge` (a
6-line `cn`), no date library, no CSV library.

---

## 1. Documents list

Table on desktop, cards below `md` — a horizontally scrolling table on a 375px
screen is the fastest way to look unfinished. Filter chips carry live counts.
Money renders in Plex Mono with tabular figures; dates stay in Plex Sans,
because monospaced dates read clunky.

Polling runs **only while something is in flight** and stops the moment the
queue drains — a permanent 2s interval against a free-tier database is a cost
with no matching benefit.

**Click through:**
1. `/documents` — 5 seeded rows, newest first. Totals right-aligned and
   vertically aligned digit-for-digit.
2. Chips: **Needs review 3**, **Approved 1**, **Failed 1**. Click each; the URL
   changes, the list filters, reload preserves it.
3. Click **Approved**, then reload — still filtered. Click **All** to clear.
4. Narrow the window below ~768px — the table becomes cards, checkbox on the
   left, total top-right.
5. Tick two rows → the selection bar appears (bottom-anchored on mobile).
6. `/documents?status=queued` → "No documents match this filter" + **Clear filter**.
7. Empty state: `DELETE FROM documents;` then reload → "No documents yet" with
   **Upload invoices** and **Load sample documents**. Click the latter — three
   documents appear.
8. Loading skeleton: throttle to Slow 3G in DevTools and reload — six skeleton
   rows at the real row height, no layout jump when data lands.
9. Error state: stop Postgres (`docker stop trueline-pg`) and reload — inline
   error panel with **Try again**, header still present.

## 2. Upload

A panel on the list, not a separate route. Images are downscaled to 2576px in a
canvas before upload — above that Claude discards the pixels, so sending them
costs bandwidth and image tokens for nothing. Upload progress uses `XMLHttpRequest`
because `fetch` gives no progress events, and a bar that jumps 0→100 is worse
than none. Two files upload concurrently; the browser drives the queue because
the free tier has no job runner.

**Click through:**
1. **Upload** → dropzone with limits stated up front: "PDF, JPG, PNG · up to
   10 MB each · 20 files at a time".
2. Drag a file over it — border turns blue, background tints. Drag away — reverts.
3. Drop `samples/sample-01-clean-invoice.pdf` → progress bar → *Extracting* →
   *Ready*. The list behind updates without a manual reload.
4. **Per-file rejection, not batch**: select a `.txt` and a valid PDF together.
   The `.txt` row shows "Unsupported type" and **the PDF still uploads**.
5. `head -c 11000000 /dev/urandom > /tmp/big.pdf` and upload it → "Too large —
   10.5 MB, limit is 10 MB", no retry button (a permanent failure).
6. With no `ANTHROPIC_API_KEY` set, extraction fails per row with a retryable
   error and a **Retry** button.
7. On completion: **Review N documents** — it does *not* auto-navigate.

## 3. Review

Split pane at `lg` and above (44% preview / 56% fields). Below that, a
`[Document | Fields]` segmented control — a 375px split pane is unusable.
Preview is a native `<object>`/`<img>`; the browser already has a PDF renderer,
and pdf.js would be ~1 MB to duplicate it.

**Confidence shows no numbers.** Three states: verified (no decoration at all),
check (amber edge + dot + reason), conflict (red edge + reason). Self-reported
model confidence is weakly calibrated, and "87%" implies a precision that does
not exist.

**Click through — the reconciliation strip is the thing to see:**
1. Open **Acme Corp** (`needs_review`, 1 flag). Subtotal has a red left edge and
   dot; the amber strip below Amounts reads *"Line items total 1,240.00 but
   subtotal reads 1,420.00 — 180.00 difference"*.
2. Change subtotal to `1240`. The strip turns **green** ("Line items and totals
   reconcile") as you type — it is computed client-side from the form, so it
   does not wait for a round trip.
3. Blur the field → "Saving…" → "Saved". Reload: the value persisted, the
   subtotal flag is gone, and a **new** conflict appeared on Total (subtotal +
   tax = 1,524.00 vs the printed 1,704.00). That is correct — the printed total
   was computed from the wrong subtotal. *(Verified over the API.)*
4. The edited field now shows "· edited" instead of a flag — a human edit
   supersedes the model's opinion.
5. Open **Blue Ridge Coffee** → two amber *check* fields with the model's own
   reasons, no red.
6. Open **Meridian Logistics** → red conflict on Due date, "required for invoices".
7. Open the failed scan → error panel with **Retry extraction**; the preview
   still renders so the document is readable.
8. Edit a line item total → strip updates; **Add row** / **✕** work; the running
   **Sum** under the grid tracks.
9. **Approve** → chip turns green, label becomes **Reopen**. Then edit any field
   → status returns to *Needs review*, because the approval applied to the old values.
10. Below `lg`: segmented control, flag count badge on **Fields**, sticky
    Approve bar at the bottom.

## 4. Export

Modal on desktop, bottom sheet on mobile. The row-shape choice shows a diagram
of the resulting CSV rather than describing it — "granularity" is jargon, and
this is the setting people get wrong.

**Click through:**
1. Select 2 rows → **Export** → dialog opens with *Selected (2)* pre-chosen.
2. Switch to **All documents (5)**; the summary line updates.
3. Pick **One row per line item** — the little preview rows change shape.
4. **Download CSV** → opens in Excel/Numbers with columns intact.
5. With nothing selected, the *Selected (0)* option is disabled rather than a
   silent dead button.
6. `Esc` and the backdrop both close it.

---

## Verified

- `tsc --noEmit` clean under `strict`; 27/27 API assertions and 75/75
  extraction assertions still pass.
- Screenshotted with headless Chrome (`npm run shoot -- <path> <out.png> [w] [h]`
  — the system Chrome, not a 150 MB Playwright install): sign-in, list at 1440px,
  review at 1440px, empty state.
- Export checked end to end: both row shapes, **UTF-8 BOM present**, and a
  vendor name of `=cmd|'/c calc'!A1` emitted as `'=cmd|...` — formula injection
  neutralised.
- The live edit round trip in step 3 above was confirmed against the API.

⚠️ **Two things you should check by hand, because I could not.**

1. **The PDF preview renders as a dark rectangle in headless Chrome.** The
   viewer chrome is present, so the file is loading, and this is most likely a
   headless rendering artefact — but I cannot confirm it looks right in a real
   browser. Open a document and look at the left pane before believing it.
2. **Mobile layout is CSS-verified, not device-verified.** The breakpoints are
   right in the markup and the desktop/mobile split renders correctly at width,
   but the mobile screenshot run failed repeatedly (Chrome profile locking), so
   no phone-width image was captured. Resize a real browser to 375px.

## Error boundaries

| File | Catches |
|---|---|
| `app/global-error.tsx` | root layout failures — **the only boundary that can**; a segment `error.tsx` lives inside the layout it would need to replace |
| `app/not-found.tsx` | unmatched URLs, and `notFound()` outside the review segment |
| `app/(app)/error.tsx` | failures in the app layout itself |
| `app/(app)/documents/error.tsx` | the list |
| `app/(app)/documents/[id]/error.tsx` | the review screen, so a failure there keeps the list reachable |
| `app/(app)/documents/[id]/not-found.tsx` | unknown or malformed document id |

`global-error.tsx` renders its own `<html>`/`<body>` with inline styles and
system fonts on purpose: if the root layout failed, the stylesheet and font
variables it provides cannot be assumed to exist. A boundary that depends on
the thing that broke is not a boundary.

⚠️ **Known: `notFound()` renders correctly but returns HTTP 200.** Verified in
a production build, so it is not a dev artifact — `/documents/<unknown-uuid>`
and `/documents/not-a-uuid` both show "Document not found" with the correct UI
and a working back link, but the status line says 200. The streaming shell
flushes before the awaited database lookup resolves, so the status is already
committed by the time `notFound()` runs. Unmatched URLs (`/nonexistent-page`)
correctly return 404. For an authenticated app this is cosmetic — no crawler
sees it — but it would matter for uptime monitoring that keys on status codes.

## Not built

- **Pagination UI.** `nextCursor` is plumbed through and the API is tested, but
  the list requests 50 and shows no "Load more". Fine for a demo; a real
  account needs the button.
- **Sorting** beyond newest-first.
- **Keyboard shortcuts** for jumping between flagged fields (`n`/`p`), which
  `ui-plan.md` specifies for reviewing at volume.
- **Toasts** — feedback is inline only.
- **Dark mode** — tokens are semantic so it is a ~20-variable swap, deliberately
  deferred rather than half-shipped.
- **Delete from the UI.** `DELETE /api/documents/:id` exists and works; no
  button calls it yet.
