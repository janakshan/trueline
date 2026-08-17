# Trueline — backend (increment 1)

Four routes, tested end to end. Companion to `architecture.md`.

```
src/
├─ app/api/
│  ├─ auth/sign-in/route.ts        POST   sign in
│  ├─ documents/route.ts           POST   upload · GET list
│  └─ documents/[id]/route.ts      GET    detail
└─ lib/
   ├─ env.ts                       fail-fast env parsing
   ├─ http/errors.ts               AppError + code→status map
   ├─ http/respond.ts              ok() / route() wrapper
   ├─ db/{client,schema}.ts        pool + typed schema
   ├─ auth/{password,session}.ts   scrypt verify + signed cookie
   ├─ documents/
   │  ├─ file-validation.ts        size, magic bytes, filename
   │  ├─ serialize.ts              row → API shape
   │  └─ cursor.ts                 keyset pagination
   └─ storage/index.ts             storage seam (local fs today)
```

## Running it

```bash
docker run -d --rm --name trueline-pg -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=trueline -p 55432:5432 postgres:16-alpine
export DATABASE_URL="postgres://postgres:test@localhost:55432/trueline"
npm run db:seed
npm run dev -- --port 3111
./scripts/smoke-test.sh      # 27 assertions
```

`.env.local` needs `DATABASE_URL`, `SESSION_SECRET` (≥32 chars), `STORAGE_DIR`.

---

## Conventions

**Errors.** Every failure returns the same envelope, from one `route()` wrapper:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [ … ] },
  "requestId": "…" }
```

`code` is stable and machine-readable; `message` is for humans and may change, so clients must never parse it. Every response carries `x-request-id`, and unexpected errors are logged server-side with that id but returned as a bare `INTERNAL_ERROR` — driver messages and stack traces leak schema details.

**Success.** Always `{ "data": … }`, with `{ "meta": … }` where there's pagination.

**Validation.** Zod on every input — body, query string, and path params. A `ZodError` escaping a handler is caught by the wrapper and rendered as a 400 with field-level `details`, so no route repeats that plumbing.

---

## Routes

### `POST /api/auth/sign-in`

Not on your list, but every other route needs a session, so the increment is untestable without it. Deliberately minimal.

Unknown email and wrong password return an identical 401, and the unknown-email branch still runs a dummy scrypt verify so the two paths take comparable time. Distinguishing them — by message, status, or timing — is account enumeration.

### `POST /api/documents`

`multipart/form-data`, one `file` part → 201 with the queued document.

Three validation decisions worth flagging:

- **Content type is decided by magic bytes, not the browser.** The multipart `Content-Type` is attacker-controlled: rename `payload.exe` to `invoice.pdf` and it arrives as `application/pdf`. The first bytes are checked against PDF/PNG/JPEG signatures and the declared type is demoted to a hint in `details`.
- **Size is checked twice** — once against `File.size`, then again against the real buffered length, because the first is a client-supplied claim.
- **One file per request, enforced.** Multiple `file` parts are a 400 rather than silently taking the first. Batch uploads issue one request per file so a single bad file can't fail the batch — the per-file rejection behaviour `ui-plan.md` calls for.

Filenames are stripped to a basename with control characters removed, so `../../../etc/passwd.pdf` stores as `passwd.pdf` and a CR/LF can't be injected into a later `Content-Disposition`.

If the insert fails after the bytes are written, the file is deleted — a failed insert must not orphan storage.

⚠️ **Scope limit.** This accepts the file *through* the route handler, which Vercel caps at ~4.5 MB even though our own limit is 10 MB. The client-direct-to-blob path from `architecture.md` is a separate increment; it swaps `lib/storage` and adds a token route without changing this contract.

### `GET /api/documents`

`?status=&limit=&cursor=` → rows plus `meta.counts` and `meta.nextCursor`.

**Keyset pagination, not `OFFSET`.** This list is prepended to constantly while a batch uploads — with `OFFSET`, a row inserted between page 1 and page 2 shifts everything down and the client silently re-sees or skips rows. The cursor is an opaque `(createdAt, id)` tuple; the tuple comparison keeps it stable when timestamps collide. Verified by walking 5 pages at `limit=2`: 9 rows, 0 duplicates, same set and order as one shot.

`meta.counts` ships on every response because the client polls this every 2s and the filter chips need counts — one extra grouped query beats four round trips.

### `GET /api/documents/:id`

Document plus its current extraction, or `extraction: null` for a failed one.

**Ownership is in the `WHERE` clause, not a check after the fetch**, and another user's document returns **404, not 403** — a 403 confirms the id exists, which is an existence oracle. A non-UUID path segment is a 400 rather than a 500 from the driver failing to cast it.

Responses go through explicit serialisers. `storage_path`, `user_id`, `raw_response`, and `password_hash` never leave the server, and the smoke test asserts it — returning `...row` would leak each new internal column automatically the day someone adds one.

---

## Dependencies added

| Package | Why |
|---|---|
| `next`, `react`, `react-dom` | the stated stack |
| `zod` | one library covering env parsing, body/query/param validation, and later the Claude output schema |
| `drizzle-orm` | typed queries over the SQL schema; no runtime driver of its own |
| `pg` | **promoted from devDependency to dependency** — see below |
| `typescript`, `@types/*` | dev only |

⚠️ **Two deviations from `architecture.md`, both deliberate:**

**`pg` instead of `@neondatabase/serverless`.** The Neon HTTP driver only speaks to Neon's proxy — it cannot connect to a local Postgres, which would make the entire backend untestable outside a deploy. `pg` works against both Neon's pooler and Docker. The cold-start advantage of the HTTP driver is real; swapping back is a change to `lib/db/client.ts` alone, and I'd do it once there's a Neon branch to test against.

**No `@vercel/blob` yet.** Adding it now would mean an untestable upload path. The storage seam exists so that swap is one file.

---

## Test results

27 assertions, all passing (`./scripts/smoke-test.sh`), plus these checks run manually:

| Check | Result |
|---|---|
| `tsc --noEmit` under `strict` + `noUnusedLocals`/`noUnusedParameters` | clean |
| Path traversal `../../../etc/passwd.pdf` | stored as `passwd.pdf` |
| Control chars + CRLF in filename | stripped |
| Files on disk vs uploaded rows | 4 / 4, no orphans |
| Keyset pagination, 5 pages at `limit=2` | 9 rows, no duplicates or skips |
| Second user's list | 0 rows (demo user's 9 invisible) |
| Second user fetching demo user's document | 404 |
| Tampered session cookie | 401 |
| Validly-signed but expired session | 401 |
| Internal fields in responses | none |

Typecheck caught two real bugs before any test ran: an unused import, and `promisify(scrypt)` resolving to a 3-argument overload that dropped the options object — which would have silently used scrypt's default cost parameters instead of the stored `N`/`r`/`p`.

---

## Known gaps

1. **Database outages return 503, not 500.** A connection failure (`ECONNREFUSED`
   and friends) is unwrapped from Drizzle's nested cause chain and returned as
   `SERVICE_UNAVAILABLE` with "The database is unavailable." Previously it
   surfaced as a generic `INTERNAL_ERROR`, which told a user their sign-in had
   failed when their credentials were never checked. The pool reconnects on its
   own once the database is back — no restart needed.
2. ⚠️ **Unimplemented methods bypass the error envelope.** `DELETE /api/documents` returns Next's built-in 405 with an empty body, not `{ error: … }`. Resolves itself as `PATCH`/`DELETE` get implemented; until then it's an inconsistency in the contract.
3. **`page_count` is always null.** Counting PDF pages needs a parser, and the extraction step can report it more reliably than a regex over object streams.
4. **No rate limiting.** `architecture.md` flags a public demo as an open faucet on API credit. Needs a per-day cap before the URL goes in a proposal — it belongs on the extract route, which doesn't exist yet.
5. **Money crosses the wire as a JSON number.** Fine below 2^53, but `numeric` → JSON number drops trailing zeros (`1704.00` → `1704`), so the client must format. If money ever needs exactness end to end, serialise as a string.
6. **Sessions can't be revoked before expiry** — stateless signed cookie, no session table. Called out in `architecture.md`; the fix is a session table or Auth.js once there are real users.

## Next increment

`POST /api/documents/[id]/extract` — the atomic claim, the Claude call, and the failure taxonomy. That's where the product actually lives, and it needs `lib/extraction/schema.ts` (the Zod schema driving both the API request and response validation) first.
