#!/usr/bin/env bash
# Smoke test for the Trueline backend routes.
#
#   1. docker run -d --rm --name trueline-pg -e POSTGRES_PASSWORD=test \
#        -e POSTGRES_DB=trueline -p 55432:5432 postgres:16-alpine
#   2. export DATABASE_URL="postgres://postgres:test@localhost:55432/trueline"
#   3. npm run db:seed
#   4. npm run dev -- --port 3111
#   5. ./scripts/smoke-test.sh
#
# Exits non-zero on the first unmet expectation.

set -uo pipefail

BASE="${BASE:-http://localhost:3111}"
JAR="$(mktemp)"
PASS=0
FAIL=0

trap 'rm -f "$JAR"' EXIT

# expect <label> <expected-status> <curl args...>
expect() {
  local label="$1" want="$2"; shift 2
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [[ "$got" == "$want" ]]; then
    printf '  \033[32mPASS\033[0m  %-58s %s\n' "$label" "$got"
    PASS=$((PASS + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-58s expected %s, got %s\n' "$label" "$want" "$got"
    FAIL=$((FAIL + 1))
  fi
}

FIX="$(mktemp -d)"

# Every fixture carries this prefix, and the upload route stores the multipart
# filename, so cleanup can identify exactly the rows this suite created. Do not
# drop the prefix — the cleanup block at the bottom depends on it.
PREFIX="zz-smoke-"

printf '%%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' > "$FIX/${PREFIX}invoice.pdf"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR fake png body' > "$FIX/${PREFIX}receipt.png"
printf 'plain text pretending to be a pdf' > "$FIX/${PREFIX}disguised.pdf"
head -c 11000000 /dev/urandom > "$FIX/${PREFIX}toobig.pdf"
trap 'rm -f "$JAR"; rm -rf "$FIX"' EXIT

echo
echo "auth"
expect "unauthenticated list is rejected"            401 "$BASE/api/documents"
expect "unauthenticated upload is rejected"          401 -X POST "$BASE/api/documents" -F "file=@$FIX/${PREFIX}invoice.pdf"
expect "wrong password is rejected"                  401 -X POST "$BASE/api/auth/sign-in" -H 'Content-Type: application/json' -d '{"email":"demo@trueline.app","password":"wrong"}'
expect "unknown email is rejected identically"       401 -X POST "$BASE/api/auth/sign-in" -H 'Content-Type: application/json' -d '{"email":"nobody@example.com","password":"wrong"}'
expect "malformed email is rejected"                 400 -X POST "$BASE/api/auth/sign-in" -H 'Content-Type: application/json' -d '{"email":"not-an-email","password":"x"}'
expect "non-JSON sign-in body is rejected"           415 -X POST "$BASE/api/auth/sign-in" -H 'Content-Type: text/plain' -d 'hi'
expect "one-click demo login works"                  200 -c "$JAR" -X POST "$BASE/api/auth/demo"
expect "forged session cookie is rejected"           401 -H "Cookie: trueline_session=abc.123.def" "$BASE/api/documents"
expect "retired demo password no longer works"       401 -X POST "$BASE/api/auth/sign-in" -H 'Content-Type: application/json' -d '{"email":"demo@trueline.app","password":"docudata-demo"}'

echo
echo "POST /api/documents"
expect "valid PDF is accepted"                       201 -b "$JAR" -X POST "$BASE/api/documents" -F "file=@$FIX/${PREFIX}invoice.pdf"
expect "valid PNG is accepted"                       201 -b "$JAR" -X POST "$BASE/api/documents" -F "file=@$FIX/${PREFIX}receipt.png"

expect "spoofed content-type is caught by sniffing"  415 -b "$JAR" -X POST "$BASE/api/documents" -F "file=@$FIX/${PREFIX}disguised.pdf;type=application/pdf"
expect "oversized file is rejected"                  413 -b "$JAR" -X POST "$BASE/api/documents" -F "file=@$FIX/${PREFIX}toobig.pdf"
expect "missing file part is rejected"               400 -b "$JAR" -X POST "$BASE/api/documents" -F "notfile=@$FIX/${PREFIX}invoice.pdf"
expect "multiple file parts are rejected"            400 -b "$JAR" -X POST "$BASE/api/documents" -F "file=@$FIX/${PREFIX}invoice.pdf" -F "file=@$FIX/${PREFIX}receipt.png"
expect "JSON body is rejected"                       415 -b "$JAR" -X POST "$BASE/api/documents" -H 'Content-Type: application/json' -d '{}'

echo
echo "GET /api/documents"
expect "list returns rows"                           200 -b "$JAR" "$BASE/api/documents"
expect "status filter is accepted"                   200 -b "$JAR" "$BASE/api/documents?status=needs_review"
expect "unknown status is rejected"                  400 -b "$JAR" "$BASE/api/documents?status=banana"
expect "limit above max is rejected"                 400 -b "$JAR" "$BASE/api/documents?limit=200"
expect "limit below min is rejected"                 400 -b "$JAR" "$BASE/api/documents?limit=0"
expect "malformed cursor is rejected"                400 -b "$JAR" "$BASE/api/documents?cursor=garbage"

echo
echo "GET /api/documents/:id"
expect "seeded document is returned"                 200 -b "$JAR" "$BASE/api/documents/10000000-0000-4000-8000-000000000002"
expect "failed document is returned"                 200 -b "$JAR" "$BASE/api/documents/10000000-0000-4000-8000-000000000005"
expect "unknown uuid is not found"                   404 -b "$JAR" "$BASE/api/documents/99999999-9999-4999-8999-999999999999"
expect "non-uuid id is rejected"                     400 -b "$JAR" "$BASE/api/documents/not-a-uuid"
expect "injection-shaped id is rejected"             400 -b "$JAR" "$BASE/api/documents/1%27%20OR%20%271%27=%271"

echo
echo "invariants"
if curl -s -b "$JAR" "$BASE/api/documents/10000000-0000-4000-8000-000000000002" \
   | grep -qE '"(storagePath|storage_path|userId|user_id|rawResponse|passwordHash)"'; then
  printf '  \033[31mFAIL\033[0m  internal fields must not be serialised\n'; FAIL=$((FAIL + 1))
else
  printf '  \033[32mPASS\033[0m  internal fields are not serialised\n'; PASS=$((PASS + 1))
fi

echo
echo "cleanup"
# Deletes rows whose FILENAME carries $PREFIX — i.e. only what this suite
# uploaded.
#
# It used to sweep "every id without the 10000000- seed prefix" on the
# assumption that anything else was test garbage. Real uploads also get random
# uuids, so the suite destroyed the user's own documents (and DELETE unlinks the
# stored file too). Identify test data by something the test controls, never by
# "everything that isn't a fixture".
#
# Splitting on '}' puts one document per line; id precedes filename in the
# serialiser, so the line carrying the filename carries its id as well.
smoke_ids() {
  curl -s -b "$JAR" "$BASE/api/documents?limit=100" \
    | tr '}' '\n' \
    | grep "\"filename\":\"${PREFIX}" \
    | grep -o '"id":"[^"]*"' \
    | sed -E 's/"id":"([^"]*)"/\1/'
}

for id in $(smoke_ids); do
  curl -s -o /dev/null -b "$JAR" -X DELETE "$BASE/api/documents/$id"
done

LEFT=$(smoke_ids | grep -c . || true)
if [[ "$LEFT" == "0" ]]; then
  printf '  \033[32mPASS\033[0m  %-58s\n' "no test documents left behind"
  PASS=$((PASS + 1))
else
  printf '  \033[31mFAIL\033[0m  %-58s %s stray\n' "no test documents left behind" "$LEFT"
  FAIL=$((FAIL + 1))
fi

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
