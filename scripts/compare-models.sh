#!/usr/bin/env bash
# compare-models.sh — run the same documents through several models and compare
# accuracy against cost.
#
#   ./scripts/compare-models.sh
#
# ⚠️ This spends real money. It prints an estimate first and waits for
# confirmation. With a small prepaid balance, run it once and keep the results —
# do not re-run it casually.

set -uo pipefail

MODELS=("${MODELS_OVERRIDE:-claude-opus-5 claude-sonnet-5 claude-haiku-4-5}")
read -ra MODEL_LIST <<< "${MODELS[0]}"
DOCS=(
  "samples/sample-01-clean-invoice.pdf"
  "samples/sample-02-mismatch-invoice.pdf"
  "samples/sample-03-receipt.pdf"
)

CALLS=$(( ${#MODEL_LIST[@]} * ${#DOCS[@]} ))
printf '\033[1mModel comparison\033[0m\n'
printf '  models    : %s\n' "${MODEL_LIST[*]}"
printf '  documents : %d\n' "${#DOCS[@]}"
printf '  API calls : %d\n' "$CALLS"
printf '  estimate  : ~$%.2f (small single-page PDFs)\n' "$(echo "$CALLS * 0.012" | bc -l)"
printf '\n  Press ENTER to proceed, Ctrl-C to abort. '
read -r _

TOTAL=0
for model in "${MODEL_LIST[@]}"; do
  printf '\n\033[1m=== %s ===\033[0m\n' "$model"
  for doc in "${DOCS[@]}"; do
    # Strip ANSI codes: without this the flag grep never matches the coloured
    # "conflict" label and every document reports zero flags.
    out=$(EXTRACTION_MODEL="$model" npx tsx --env-file-if-exists=.env.local \
            scripts/check-claude.ts "$doc" 2>&1 | sed -E $'s/\033\[[0-9;]*m//g')

    name=$(basename "$doc" .pdf | sed 's/sample-0[0-9]-//')
    if grep -q "✓ Live extraction works" <<< "$out"; then
      secs=$(grep -oE 'OK in [0-9.]+s' <<< "$out" | grep -oE '[0-9.]+' | head -1)
      cost=$(grep -oE 'cost +~\$[0-9.]+' <<< "$out" | grep -oE '[0-9.]+' | head -1)
      subtotal=$(grep -oE '^  subtotal +[0-9.]+' <<< "$out" | awk '{print $2}')
      total=$(grep -oE '^  total +[0-9.]+' <<< "$out" | awk '{print $2}')
      items=$(grep -oE '^  line items +[0-9]+' <<< "$out" | awk '{print $3}')
      flags=$(grep -cE '^  (conflict|check )' <<< "$out")
      printf '  %-18s %5ss  $%-7s  subtotal=%-9s total=%-9s items=%-3s flags=%s\n' \
        "$name" "${secs:-?}" "${cost:-?}" "${subtotal:-—}" "${total:-—}" "${items:-—}" "$flags"
      TOTAL=$(echo "$TOTAL + ${cost:-0}" | bc -l)
    else
      reason=$(grep -oE 'code +[A-Z_]+' <<< "$out" | head -1 | awk '{print $2}')
      printf '  %-18s \033[31mFAILED\033[0m  %s\n' "$name" "${reason:-see output}"
      grep -E '  (message|detail) ' <<< "$out" | head -2 | sed 's/^/      /'
    fi
  done
done

printf '\n\033[1mTotal spent this run: ~$%.4f\033[0m\n' "$TOTAL"
