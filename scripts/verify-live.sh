#!/usr/bin/env bash
# verify-live.sh — end-to-end check of a deployed Trueline against the demo account.
#
#   ./scripts/verify-live.sh https://trueline.janakshan.dev
#
# It never triggers an extraction, so running it costs nothing and cannot
# consume the monthly cap.
#
# It does write once: it corrects the Acme invoice's subtotal, checks the edit
# persisted, then puts the original value back so the demo still shows the
# mismatch. The one trace it leaves is `subtotal` listed in reviewedFields —
# harmless, but `npm run db:seed` resets the demo to pristine if you care.

set -uo pipefail

BASE="${1:-}"
if [[ -z "$BASE" ]]; then
  echo "usage: $0 <base-url>" >&2
  exit 2
fi
BASE="${BASE%/}"

PASS=0
FAIL=0
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s  — %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected $3, got $2"; fi; }

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

SEEDED=10000000-0000-4000-8000-000000000002   # the mismatch invoice
MISSING=99999999-9999-4999-8999-999999999999

printf '\n\033[1mTrueline — %s\033[0m\n' "$BASE"

printf '\n\033[1mReachable and secured\033[0m\n'
check "site responds"                        "$(status "$BASE/sign-in")" 200
check "root redirects to sign-in"            "$(status -o /dev/null "$BASE/")" 307
check "anonymous API call is refused"        "$(status "$BASE/api/documents")" 401
check "unknown page redirects anonymous"     "$(status "$BASE/nope")" 307

HEADERS="$(curl -s -D - -o /dev/null "$BASE/sign-in")"
if [[ "$BASE" == https://* ]]; then
  grep -qi 'strict-transport-security' <<<"$HEADERS" && ok "HSTS header present" || bad "HSTS header present" "absent"
else
  printf '  \033[33mSKIP\033[0m  HSTS header (http base URL)\n'
fi
grep -qi 'x-content-type-options: nosniff' <<<"$HEADERS" && ok "nosniff header present" || bad "nosniff header present" "absent"
grep -qi 'content-security-policy' <<<"$HEADERS" && ok "CSP header present" || bad "CSP header present" "absent"

printf '\n\033[1mDemo sign-in\033[0m\n'
LOGIN="$(curl -s -c "$JAR" -D - -o /dev/null -X POST "$BASE/api/auth/demo" -w '%{http_code}')"
CODE="$(tail -1 <<<"$LOGIN")"
check "one-click demo signs in" "$CODE" 200

COOKIE_LINE="$(grep -i 'set-cookie' <<<"$LOGIN" || true)"
grep -qi 'httponly'      <<<"$COOKIE_LINE" && ok "session cookie is HttpOnly" || bad "session cookie is HttpOnly" "flag missing"
if [[ "$BASE" == https://* ]]; then
  grep -qi 'secure' <<<"$COOKIE_LINE" && ok "session cookie is Secure" || bad "session cookie is Secure" "flag missing"
else
  printf '  \033[33mSKIP\033[0m  Secure cookie flag (http base URL)\n'
fi
grep -qi 'samesite'      <<<"$COOKIE_LINE" && ok "session cookie sets SameSite" || bad "session cookie sets SameSite" "flag missing"
grep -qi 'password'      <<<"$LOGIN"       && bad "no credential in the response" "found one" || ok "no credential in the response"

check "authenticated list works"             "$(status -b "$JAR" "$BASE/api/documents")" 200
check "documents page renders"               "$(status -b "$JAR" "$BASE/documents")" 200

printf '\n\033[1mSeeded data\033[0m\n'
LIST="$(curl -s -b "$JAR" "$BASE/api/documents?limit=100")"
COUNT="$(grep -o '"id":"' <<<"$LIST" | wc -l | tr -d ' ')"
if [[ "$COUNT" -ge 5 ]]; then ok "at least five seeded documents ($COUNT)"; else bad "at least five seeded documents" "found $COUNT"; fi

DETAIL="$(curl -s -b "$JAR" "$BASE/api/documents/$SEEDED")"
grep -q 'Acme' <<<"$DETAIL" && ok "mismatch invoice is present" || bad "mismatch invoice is present" "vendor not found"
grep -q '1,240.00' <<<"$DETAIL" && ok "flag names the line-item sum" || bad "flag names the line-item sum" "1,240.00 not in the issue message"
grep -q '1420' <<<"$DETAIL" && ok "printed subtotal kept verbatim, not corrected" || bad "printed subtotal kept verbatim" "1420 not found"
grep -qi 'difference' <<<"$DETAIL" && ok "reconciliation flag is raised" || bad "reconciliation flag is raised" "no issue message"

check "review page renders"                  "$(status -b "$JAR" "$BASE/documents/$SEEDED")" 200
check "unknown document is a 404"            "$(status -b "$JAR" "$BASE/api/documents/$MISSING")" 404
check "non-uuid id is rejected"              "$(status -b "$JAR" "$BASE/api/documents/not-a-uuid")" 400

printf '\n\033[1mInternal fields stay internal\033[0m\n'
if grep -qE '"(storagePath|storage_path|userId|user_id|rawResponse|passwordHash)"' <<<"$DETAIL"; then
  bad "internal fields are not serialised" "found one in the payload"
else
  ok "internal fields are not serialised"
fi

printf '\n\033[1mReview and export\033[0m\n'
PATCHED="$(status -b "$JAR" -X PATCH "$BASE/api/documents/$SEEDED" \
  -H 'Content-Type: application/json' \
  -d '{"fields":{"subtotal":1240}}')"
check "a correction saves" "$PATCHED" 200

AFTER="$(curl -s -b "$JAR" "$BASE/api/documents/$SEEDED")"
grep -q '"subtotal":1240' <<<"$AFTER" && ok "correction is persisted" || bad "correction is persisted" "subtotal did not change"
grep -q '"reviewedFields":\[[^]]*"subtotal"' <<<"$AFTER" \
  && ok "corrected field is marked reviewed" \
  || bad "corrected field is marked reviewed" "subtotal not in reviewedFields"

# Put it back, so the demo keeps showing the mismatch the case study describes.
RESTORED="$(status -b "$JAR" -X PATCH "$BASE/api/documents/$SEEDED" \
  -H 'Content-Type: application/json' \
  -d '{"fields":{"subtotal":1420}}')"
check "seeded mismatch is restored" "$RESTORED" 200

CSV="$(curl -s -b "$JAR" -D - "$BASE/api/export?ids=$SEEDED&granularity=document")"
grep -qi 'content-disposition: attachment' <<<"$CSV" && ok "CSV downloads as an attachment" || bad "CSV downloads as an attachment" "no disposition header"
grep -qi 'text/csv' <<<"$CSV" && ok "CSV content type is set" || bad "CSV content type is set" "wrong type"
grep -q 'vendor' <<<"$(tr 'A-Z' 'a-z' <<<"$CSV")" && ok "CSV has a header row" || bad "CSV has a header row" "no vendor column"

printf '\n\033[1mSpend guard is wired up\033[0m\n'
# Not exercised for real: proving the cap by spending money defeats the point.
# This only confirms the route is reachable and refuses anonymous callers.
check "extract route rejects anonymous callers" \
  "$(status -X POST "$BASE/api/documents/$SEEDED/extract")" 401

printf '\n\033[1mpassed %d, failed %d\033[0m\n\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
