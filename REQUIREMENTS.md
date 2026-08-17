# Trueline — Requirements (v1)

**What it is:** a single-user web app where you upload invoices/receipts (PDF or image), Claude extracts structured data, you review and correct it beside a document preview, then export to CSV.

**Why it exists:** a portfolio demo proving I can ship an AI-integration product end to end — schema design, human-in-the-loop review, and export — not just an API wrapper.

---

## User stories

1. As a user, I sign in with email + password so my documents stay private.
2. I drag 1–20 files (PDF/JPG/PNG) onto the app and they queue for processing.
3. I see each document's status (queued → processing → needs review → approved → failed) in a list, so I know what's left.
4. I open a document and see the original preview on the left and the extracted fields on the right.
5. I edit any field — header or line item — and my correction saves immediately.
6. I see which fields the model was unsure about, so I know where to look first.
7. I add, delete, or reorder line items when extraction missed a row.
8. I mark a document approved once it's correct.
9. I select documents and export them to CSV, choosing one row per document or one row per line item.
10. I delete a document and its file.
11. If extraction fails, I see why and can retry it.

## Data fields to extract

**Header (per document)**

| Field | Type | Notes |
|---|---|---|
| `document_type` | enum | `invoice` \| `receipt` |
| `vendor_name` | string | required |
| `vendor_address` | string | nullable |
| `vendor_tax_id` | string | nullable (VAT/GST/EIN) |
| `invoice_number` | string | nullable for receipts |
| `issue_date` | date | ISO 8601 (`YYYY-MM-DD`) |
| `due_date` | date | nullable |
| `currency` | string | ISO 4217 (`USD`, `LKR`, `GBP`…) |
| `subtotal` | decimal | |
| `tax_amount` | decimal | nullable |
| `tax_rate` | decimal | nullable, percent |
| `shipping_amount` | decimal | nullable |
| `discount_amount` | decimal | nullable |
| `total_amount` | decimal | required |
| `payment_method` | string | nullable (receipts) |

**Line items (repeating)**

`line_number` (int) · `description` (string) · `quantity` (decimal, default 1) · `unit_price` (decimal, nullable) · `line_total` (decimal)

**Derived, not extracted:** a per-field `confidence` (0–1) returned by the model, and a `needs_review` flag set when any field is below threshold or when `subtotal + tax + shipping − discount ≠ total`. That arithmetic check is the demo's most convincing feature — show it.

## Screens

1. **Sign in** — email + password. No sign-up in the UI; the demo account is seeded.
2. **Documents** — the home screen. Table of documents with status chips, vendor, date, total, and a "needs review" count. Bulk select → export. Upload dropzone lives here.
3. **Review** — split pane. Left: page preview with page navigation. Right: editable header form + line-item grid, low-confidence fields highlighted, running totals that recompute as you edit. Approve / re-extract / delete.
4. **Export** — modal from the documents screen: pick columns, pick row granularity (per document / per line item), download CSV.

## Out of scope

Multi-user accounts, teams, roles, sharing · password reset and email verification · OCR of handwriting · document types beyond invoices/receipts · accounting integrations (QuickBooks, Xero) · payments or billing · email/inbox ingestion · duplicate detection · vendor normalisation across documents · approval workflows · audit log · mobile-native app · UI localisation · exports other than CSV · training or fine-tuning a custom model · analytics dashboards.

## Assumptions

- **Stack:** Next.js (App Router) + TypeScript, Postgres via Prisma, Tailwind + shadcn/ui. One repo, one deploy.
- **Extraction:** Claude API, `claude-opus-5`, using structured outputs (`output_config.format` with a JSON schema) so the response validates against the field list above. PDFs go in as document blocks; images as image blocks. Batch uploads process sequentially with retry on transient failure.
- **Limits:** 10 MB and 10 pages per file, 20 files per upload batch. English-language documents; any currency.
- **Hosting:** deployed with a public URL and a seeded read-only-ish demo account. Files in object storage, originals retained until deleted.
- **Auth:** email + password, hashed, session cookie. Single tenant — every document belongs to the one user.
- **Confidence threshold:** 0.85 for the review flag; tunable.
- **Non-goal:** accuracy benchmarking. The demo shows the workflow, not a claimed extraction accuracy figure.

## Open question

None blocking. If a client asks "can it do X?", the honest answer for v1 is the out-of-scope list above.
