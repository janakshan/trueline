#!/usr/bin/env bash
# shoot.sh — screenshot a page with headless Chrome.
#
#   ./scripts/shoot.sh <path> <out.png> [width] [height]
#
# Uses the system Chrome rather than pulling in Playwright (~150 MB) for what
# is a screenshot.
#
# The cookie bootstrap has to be served from the app's own origin — a cookie
# set from a file:// page does not apply to localhost — so this writes a
# throwaway page into public/ and removes it afterwards.

set -euo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BASE="${BASE:-http://localhost:3111}"
TARGET="${1:-/documents}"
OUT="${2:-/tmp/shot.png}"
W="${3:-1440}"
H="${4:-1000}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOOTSTRAP="$ROOT/public/__shot.html"
# Reused across runs so Chrome's first-run cost is paid once.
PROFILE="${SHOT_PROFILE:-/tmp/trueline-chrome-profile}"
mkdir -p "$PROFILE" "$ROOT/public"

cleanup() { rm -f "$BOOTSTRAP"; }
trap cleanup EXIT

JAR=$(mktemp)
curl -s -c "$JAR" -X POST "$BASE/api/auth/demo" > /dev/null
TOKEN=$(grep trueline_session "$JAR" | awk '{print $7}')
rm -f "$JAR"

if [[ -z "$TOKEN" ]]; then
  echo "could not sign in — is the dev server running on $BASE?" >&2
  exit 1
fi

cat > "$BOOTSTRAP" <<HTML
<!doctype html><meta charset="utf-8">
<script>
document.cookie = "trueline_session=$TOKEN; path=/; SameSite=Lax";
location.replace("$TARGET");
</script>
HTML

"$CHROME" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --hide-scrollbars \
  --force-device-scale-factor=1 \
  --user-data-dir="$PROFILE" \
  --window-size="$W,$H" \
  --virtual-time-budget=5000 \
  --screenshot="$OUT" \
  "$BASE/__shot.html" 2>/dev/null || true

if [[ -f "$OUT" ]]; then
  echo "$OUT ($(du -h "$OUT" | cut -f1))"
else
  echo "screenshot failed" >&2
  exit 1
fi
