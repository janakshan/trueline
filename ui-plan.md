# Trueline — UI Plan (v1)

Companion to `REQUIREMENTS.md` and `architecture.md`. Screens, states, and design tokens. No component code.

---

## 1. Design direction: "quiet instrument"

The category matters. This is a tool for checking numbers, not a marketing site — so it should read like Stripe's dashboard or Linear, not like a landing page. Dense, calm, borders over shadows, and **colour that means something**.

That last part is the organising rule of the whole system:

| Colour | Reserved for | Never used for |
|---|---|---|
| Neutral (stone) | all chrome, surfaces, text | emphasis |
| **Ink** (near-black) | primary actions | decoration |
| **Blue** | focus rings, links | buttons, headers, accents |
| **Amber** | "check this field" | warnings-in-general, highlights |
| **Red** | conflicts and failures | destructive-button styling alone |
| **Green** | approved / verified | success decoration |

Because amber only ever means *a human should look at this*, an amber dot carries real information the moment you see it. The instant amber becomes a generic highlight colour, the review screen stops working. **This constraint is load-bearing, not stylistic.**

**Anti-patterns explicitly avoided** (these are what make a demo look like a tutorial): Inter as the typeface, purple or blue gradients, a blue `bg-blue-500` primary button, drop shadows on every card, emoji as icons, full-width centred marketing hero on the login, and rounded-full pills everywhere. Each was a deliberate no.

**Typeface: IBM Plex Sans + IBM Plex Mono**, self-hosted via `next/font` (zero runtime cost, no layout shift). Plex reads as serious engineering software and has actual character, and Plex Mono is excellent for money, invoice numbers, and IDs. *Alternative if you want something more contemporary:* Geist Sans + Geist Mono — equally free, slightly more neutral, with a mild "default Vercel project" risk.

**Every monetary value, quantity, date, and ID renders in `tabular-nums`.** Columns of figures that don't align vertically are the single fastest way to make a finance tool look amateur.

---

## 2. Design tokens

Defined as semantic CSS variables rather than raw palette references. Two reasons: it stops a developer reaching for `bg-amber-200` on a whim and quietly breaking the colour rule above, and it makes dark mode a token swap rather than a rewrite.

### Colour

```css
@theme {
  /* Neutral — warm stone reads less clinical than pure grey */
  --color-surface:            #FFFFFF;
  --color-surface-sunken:     #FAFAF9;
  --color-surface-raised:     #FFFFFF;
  --color-surface-hover:      #F5F5F4;
  --color-border:             #E7E5E4;
  --color-border-strong:      #D6D3D1;
  --color-text:               #1C1917;
  --color-text-muted:         #57534E;
  --color-text-subtle:        #A8A29E;

  /* Ink — primary action */
  --color-primary:            #1C1917;
  --color-primary-hover:      #292524;
  --color-primary-fg:         #FFFFFF;

  /* Blue — focus and links ONLY */
  --color-focus:              #2551D9;
  --color-link:               #1C3FAE;

  /* Amber — "check this field" */
  --color-review-bg:          #FEF9EC;
  --color-review-border:      #D9820B;
  --color-review-text:        #92500A;

  /* Red — conflict / failure */
  --color-conflict-bg:        #FEF2F2;
  --color-conflict-border:    #DC2626;
  --color-conflict-text:      #B01818;

  /* Green — approved */
  --color-approved-bg:        #F0FDF4;
  --color-approved-border:    #16A34A;
  --color-approved-text:      #15803D;
}
```

⚠️ **Contrast rule that gets botched constantly:** amber and green at 400–500 fail WCAG AA on white. Text always uses the `-text` token (700-level); the `-border` token is for 2px edges and dots only, never type. Every text/background pair here clears 4.5:1.

### Type scale

Near-Tailwind defaults on purpose — the value is in the *usage rules*, not exotic pixel values.

| Token | Size / line-height | Used for |
|---|---|---|
| `text-2xs` | 11 / 16, +0.04em, uppercase | field labels, table headers, eyebrows |
| `text-xs` | 12 / 16 | helper text, timestamps, flag reasons |
| `text-sm` | 14 / 20 | **the workhorse** — table cells, buttons, most UI |
| `text-base` | 16 / 24 | form inputs, body copy |
| `text-lg` | 18 / 28 | section headings |
| `text-xl` | 22 / 30 | page titles |
| `text-2xl` | 28 / 36 | login headline, empty-state headline |

⚠️ **Form inputs must be ≥16px on mobile.** Safari on iOS auto-zooms the viewport on focus for anything smaller, and the resulting jump makes an app feel broken. Non-negotiable, and easy to miss because it never reproduces on desktop.

Weights: 400 body, 500 UI/labels, 600 headings and figures. No 700+ — heavy weights make dense interfaces shout.

### Spacing, sizing, radius

Tailwind's 4px base. Layout rhythm: **4 · 8 · 12 · 16 · 24 · 32 · 48 · 64**. Nothing off-scale.

| Token | Value |
|---|---|
| Page gutter | 16px mobile → 24px tablet → 32px desktop |
| Max content width | 1440px (documents list), full-bleed (review) |
| Control height | 44px mobile → 36px desktop |
| Table row height | 52px mobile → 44px desktop |
| Radius | 6px controls · 10px cards/panels · 14px modals · 9999px status chips only |
| Border | 1px `--color-border` default; 2px for field state edges |

⚠️ Every interactive target is **≥44×44px on mobile**, including table-row checkboxes and line-item delete buttons. The line-item grid is where this gets forgotten.

### Elevation and motion

**Borders for structure, shadow only for things that float.** Three shadows total: `sm` for dropdowns, `md` for modals/sheets, `lg` for the drag-over dropzone. Cards and table rows get borders, never shadows.

Motion: 150ms ease-out for hover/focus, 200ms for panels and sheets, 400ms for skeleton shimmer. All wrapped in `prefers-reduced-motion` — reduced motion kills the shimmer and the sheet slide, keeping opacity fades only.

### Icons

**Inline a local set of ~15 SVGs** (upload, file, image, check, alert-triangle, x-circle, chevrons, search, download, trash, refresh, loader, eye, plus). Consistent with the minimal-dependency stance in `architecture.md` — copy the paths from Lucide for visual consistency and keep the runtime dependency at zero. If the set grows past ~25, switch to `lucide-react` and take the tree-shaken hit.

### Dark mode

Tokens are semantic, so dark mode is a `[data-theme="dark"]` block redefining ~20 variables and nothing else. **Scope it as phase 2 and ship it properly or not at all** — a half-done dark mode with three unstyled panels looks far worse on a portfolio than a polished light-only app.

---

## 3. Shared state patterns

Defined once so all five screens behave identically. Inconsistent empty states are the clearest tell that a UI was assembled screen-by-screen.

**Loading → skeletons, not spinners.** Skeletons preserve layout, prevent content jump, and read as faster. They're also doing real work here: `architecture.md` flags a Neon cold start of up to ~1s on the first query after idle — which is exactly the click a client makes from your portfolio. A spinner makes that feel broken; a skeleton makes it feel like loading. Spinners are only for in-button action feedback.

**Empty → headline + one sentence + one primary action.** Never a bare "No data". No cheesy illustrations; a bordered dashed container with a single icon is enough.

**Error → inline panel, keep the chrome.** Never replace the whole page with an error. Structure: what failed (plain language), why if we know it, and a retry button. Never surface a raw stack trace or an error code alone.

**Success → the quietest thing that works.** Inline state change over toast; toast over modal. Never a modal to confirm something worked.

---

## 4. Sign in

**Layout.** A single card, max-width 380px, vertically centred on desktop and top-aligned with 48px of top padding on mobile (keeps the form above the keyboard). Wordmark above the card, one line of positioning text below it. Left-aligned inside the card — centred form labels read as a template.

**Contents.** Email, password, "Sign in" (primary, full-width, 44px).

⚠️ **The demo-access decision, and it matters more than the visuals.** A client clicking your portfolio link will not sign up, will not guess a password, and will not email you for credentials — they will close the tab. So the login screen carries a **"Try the demo" button above the form** that signs into the seeded account in one click, with the credentials also shown in small print. The form stays for realism; the button is what actually gets people in.

**States.**

- *Default* — clean form.
- *Loading* — button shows inline spinner and its label becomes "Signing in…"; inputs disabled; form dimmed to 60%.
- *Error* — inline red panel above the form: **"Email or password is incorrect."** ⚠️ Deliberately ambiguous. Distinguishing "no such account" from "wrong password" is account enumeration; even on a single-user demo, getting it right is the kind of detail a technical client notices.
- *Success* — button state persists through the redirect; no flash of empty dashboard.
- *Rate-limited* — "Too many attempts. Try again in 60 seconds," with the button disabled and a live countdown.

**Mobile.** Full-width card, 16px gutters, 16px inputs, `autocomplete="email"` / `"current-password"` so password managers work.

---

## 5. Documents list

The home screen. **Table on desktop, cards on mobile** — this is the central responsive decision, because a horizontally scrolling table on a 375px screen is the fastest way to look unfinished.

**Header.** Title "Documents" with a muted count. Right: "Upload" (primary). Below: filter chips — `All` · `Needs review (n)` · `Approved` · `Failed`, with counts baked in so the queue state is legible without clicking. A live "3 processing" indicator with a pulsing dot appears in the header only while work is running.

**Desktop table columns:** checkbox · vendor (bold) with filename beneath in `text-xs` muted · issue date · **total, right-aligned, tabular** · status chip · flag count (amber dot + number, blank when zero) · row actions on hover.

**Mobile card:** vendor bold top-left, total bold top-right (tabular); filename muted on line two; date and status chip on line three. Whole card is one tap target to the review screen.

**Bulk selection.** Selecting rows raises an action bar — sticky *below the header* on desktop, sticky *to the bottom edge* on mobile (thumb reach) — showing "12 selected", "Export", "Clear".

**Sorting.** Click column headers on desktop. Mobile gets a single sort dropdown: newest, oldest, highest total, needs review first.

**States.**

- *Empty (first run)* — the highest-leverage screen in the app for a portfolio. Dashed-border panel, upload icon, **"No documents yet"**, one line of subtext, then **two** actions: "Upload invoices" (primary) and **"Load 5 sample documents" (secondary)**. ⚠️ Most people evaluating your demo will not have an invoice PDF handy. The sample-data button is the difference between them seeing the product and them seeing an empty box.
- *Loading* — 6 skeleton rows matching real row height exactly.
- *Populated with work in flight* — processing rows show an animated chip and are not clickable into a broken form; they stay in place rather than reordering as they complete (rows jumping under the cursor is disorienting).
- *Filter empty* — "No documents match this filter" + "Clear filter".
- *Fetch error* — inline panel, chrome intact, "Couldn't load documents" + Retry.
- *Partially failed batch* — a dismissible amber banner above the table: "3 of 20 documents failed to extract. Review and retry."

---

## 6. Upload

Not a separate route — a dropzone on the documents screen that becomes a queue panel. Modal on desktop, bottom sheet on mobile.

**Idle dropzone.** Dashed 2px border, upload icon, "Drop invoices here or **browse**", and constraints stated in `text-xs` muted: "PDF, JPG, PNG · up to 10 MB each · 20 files at a time". Stating limits up front prevents the most common failure interaction.

**Drag-over.** Border becomes solid blue, background tints to `--color-review-bg`'s neutral equivalent, `lg` shadow appears. No scaling or bouncing — restraint reads as expensive.

**Queue panel** (replaces the dropzone once files are accepted). Header: "4 of 20 complete" with a thin determinate bar. Each row: type icon or thumbnail, filename (truncated middle, preserving the extension), and a right-side status that progresses **Uploading 62% → Queued → Extracting… → Ready to review / Failed**.

⚠️ **Per-file rejection, never batch rejection.** A 12 MB file among 20 must fail on its own row with a specific reason ("Too large — 12.4 MB, limit is 10 MB") while the other 19 proceed. Rejecting the whole batch because one file was oversized is the single most common upload-UX mistake, and the fix is trivial.

**States.** Idle · drag-over · validating · uploading (per-row determinate) · extracting (per-row indeterminate) · mixed success/failure · complete.

On completion the panel does **not** auto-navigate. It shows "Review 12 documents" as a primary action, because yanking someone into a screen they didn't ask for is disorienting.

**Failure handling.** Per-row "Retry" for retryable errors; permanent failures (unsupported type, corrupt PDF) show the reason with no retry, since offering a button that will always fail is worse than offering none.

**Mobile.** Bottom sheet at 90vh, 52px rows, native file picker with `accept` and `capture` so camera-scanned receipts work — a genuinely nice demo moment on a phone.

---

## 7. Review

The centrepiece. Everything else is scaffolding around this screen.

### Desktop (≥1024px)

**Sticky top bar:** back chevron · filename · status chip · flag summary ("3 to check") · autosave indicator · `Re-extract` (secondary) · **`Approve` (primary, ink)**.

**Two panes**, 44% preview / 56% fields. Fields get the larger share because the line-item grid needs horizontal room; a "expand preview" toggle temporarily takes the preview full-width for reading fine print. A fixed ratio plus a toggle beats a draggable divider — it solves the same need with a fraction of the complexity and no persisted-state bug surface.

**Left pane (preview).** Own scroll container, sticky. Native `<embed>` for PDFs, `<img>` with CSS pan/zoom for images. Multi-page PDFs get a compact `‹ 2 / 7 ›` control floating bottom-centre over the preview.

**Right pane (fields).** Three sections, generous vertical rhythm:

1. **Document** — type, vendor, vendor address, tax ID, invoice number, issue date, due date, currency.
2. **Amounts** — subtotal, tax, tax rate, shipping, discount, total. All right-aligned and tabular.
3. **Line items** — an editable grid: #, description, qty, unit price, line total. Add row, delete row, drag to reorder. Row totals recompute as you type.

### The reconciliation strip — the hero moment

A persistent band pinned between the Amounts and Line items sections, showing the arithmetic check live:

- **Balanced:** thin green left edge, `text-xs`, "Line items and totals reconcile." Quiet.
- **Mismatched:** amber band, `text-sm`, **"Line items total 1,240.00 but subtotal reads 1,420.00 — 180.00 difference"**, with a "Jump to line items" link.

⚠️ This is the single most demo-able element in the product, and it's worth building first. It's the concrete answer to the question every client asks — *"how do I know the AI got it right?"* — and it recomputes live as they edit, which makes the answer visible rather than claimed. The whole review screen should be laid out so this strip is on screen without scrolling.

### Confidence indicators

**Do not show numeric percentages.** `architecture.md` flags that self-reported model confidence is weakly calibrated; rendering "87%" implies a precision that doesn't exist and actively invites over-trust. Three visual states instead:

| State | Treatment | Trigger |
|---|---|---|
| **Verified** | no decoration at all | passes checks, high confidence |
| **Check** | 2px amber left edge on the input + amber dot beside the label; reason in `text-xs` amber beneath | low confidence *or* structural oddity (implausible date, unknown currency) |
| **Conflict** | 2px red left edge + reason always visible, never a tooltip | arithmetic mismatch or required field missing |

Two rules that make it work:

- **Silence is the signal.** If more than roughly 20% of fields are marked, the marking is noise. Tune thresholds until a typical clean invoice shows zero or one flag.
- **A human edit clears the flag** and swaps it for a subtle "edited" dot. Once a person has touched a field, the model's opinion about it is irrelevant, and continuing to show amber implies the app doesn't trust the user.

**Reasons are always human-readable** — "Line items sum to 1,240.00, subtotal reads 1,420.00", never "confidence 0.62" or "VALIDATION_ERR_3". A flag without a legible reason is just an anxious yellow box.

### Keyboard flow

Reviewing twenty invoices is a keyboard task. `n` / `p` jump to next/previous flagged field, `⌘↵` approves, `Esc` returns to the list, `Tab` moves through the line-item grid cell by cell. A `?` overlay lists them. Small effort, and it reads as a tool built by someone who has actually done the work.

### Autosave

Header indicator, three states: `Saved` (muted, with relative time) · `Saving…` · `Couldn't save — Retry` (amber, persistent). ⚠️ **Never a toast per keystroke.** On save failure, local edits stay in the inputs — never silently revert someone's typing.

### States

- *Loading* — skeleton preview block plus skeleton field rows in the real layout.
- *Still extracting* — preview renders immediately (it's just a file), fields area shows a centred processing state with the live status. Never an empty form that looks like extraction returned nothing.
- *Extraction failed* — preview still renders; the fields pane is replaced by an error panel with the plain-language reason and a Retry button. Keeping the preview matters: the user can at least read the document.
- *Preview failed to load* — fallback panel with a file icon and "Open original" link; fields remain fully usable.
- *Needs review* — the normal state.
- *Approved* — green chip, a quiet banner reading "Approved · 2 hours ago" with a "Reopen" action. Fields stay editable; locking them would be a false sense of finality.
- *Save error* — inline, non-destructive.

### Mobile (<1024px)

A 375px split pane is useless, so: **a segmented control at the top — `[ Document | Fields ]`** — switching one full-width pane, swipeable between them. Sticky bottom bar carries the flag count on the left and `Approve` on the right. The segmented control shows the flag count as a badge on `Fields`, so the count is visible while reading the document.

Line items become stacked cards rather than a grid: description on top, then a qty × unit price = total row. Swipe left on a card to delete.

---

## 8. Export

Modal on desktop (480px), bottom sheet on mobile. Four blocks:

**Scope** — radio: "Selected (12)" / "All documents (48)".

**Row shape** — two selectable cards, each with a tiny 3-row diagram of the resulting CSV shape:
- *One row per document* — line items collapsed to a count.
- *One row per line item* — header fields repeated per row.

⚠️ Showing the shape rather than describing it is worth the extra effort. "Granularity" is jargon; a picture of three rows is instantly legible, and this is the choice users get wrong.

**Columns** — collapsed by default (sensible defaults pre-checked), expanding to a grouped checklist: Document / Amounts / Line items, each group with select-all.

**Summary + warning** — a live line reading "48 rows · 14 columns". If unapproved documents are in scope: an amber inline note, *"3 of 12 documents are still awaiting review."* Informational, **not blocking** — exporting work-in-progress is legitimate and the app shouldn't second-guess it.

**States.** Default · nothing selected (primary disabled with a hint, not a silent dead button) · generating (spinner in button, "Preparing…") · success (sheet closes, toast "Exported 48 rows") · error (inline panel, sheet stays open so the configuration isn't lost).

---

## 9. Cross-cutting details

**Status chips** — one mapping, used everywhere, no exceptions:

| Status | Style |
|---|---|
| Queued | neutral bg, muted text |
| Processing | neutral bg, animated pulsing dot |
| Needs review | amber bg, amber-700 text |
| Approved | green bg, green-700 text |
| Failed | red bg, red-700 text |

**Toasts** — bottom-right desktop, top mobile. Success auto-dismisses at 4s; errors persist until dismissed. Never more than two stacked.

**Focus** — 2px `--color-focus` ring at 2px offset on every interactive element, always visible. Never `outline: none` without a replacement.

**Accessibility floor** — all text ≥4.5:1; every icon-only button gets an `aria-label`; the flag states carry text reasons, so colour is never the sole signal (which also means the review screen works for a colourblind user); `prefers-reduced-motion` honoured throughout.

**Empty-to-full choreography** — new rows fade in over 200ms rather than appearing instantly. It's the one place a little motion earns its keep, because it shows the queue working.

---

## 10. Build order

If time runs short, build in this order — it front-loads everything that makes the demo persuasive:

1. **Review screen + reconciliation strip.** The product's entire argument lives here.
2. **Documents list, including the empty state with sample data.** First screen anyone sees.
3. **Upload with per-file states.**
4. **Export.**
5. **Login polish** (the demo button matters more than the styling).
6. **Dark mode**, only if everything above is genuinely finished.
