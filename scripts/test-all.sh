#!/usr/bin/env bash
# Runs every suite. Needs Postgres and the dev server up:
#   npm run db:seed && npm run dev -- --port 3111
set -uo pipefail
FAILED=()
run() {
  local label="$1"; shift          # capture before shift — was reporting "npx"
  printf '\n\033[1m━━━ %s ━━━\033[0m\n' "$label"
  "$@" || FAILED+=("$label")
}
run "typecheck"          npx tsc --noEmit
run "parser + pipeline"  npx tsx --env-file-if-exists=.env.local scripts/test-extraction.ts
run "auth coverage"      npx tsx --env-file-if-exists=.env.local scripts/test-auth.ts
run "api smoke"          ./scripts/smoke-test.sh
run "integration"        npx tsx --env-file-if-exists=.env.local scripts/test-integration.ts
printf '\n\033[1m━━━ summary ━━━\033[0m\n'
if [ ${#FAILED[@]} -eq 0 ]; then printf '\033[32mall suites passed\033[0m\n'; else
  printf '\033[31mfailed: %s\033[0m\n' "${FAILED[*]}"; exit 1; fi
