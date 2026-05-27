#!/bin/bash
# Wave 16.4 stress + eval — 36 scenari su /api/internal/extract-constraint
# Tracks: count by result, correctness, latency, cost estimate
#
# Extends Wave 16.2 baseline (30 scenari) with 6 new operator_unavailability
# scenarios introduced by Wave 16.4 D1 (deterministic pattern v1/v2):
#   - 3 HIT (canonical, alias, num-only)
#   - 2 GRAY (missing slot, missing date)
#   - 1 MISS (no constraint signal)

SECRET="cbb6e8dd627a5c2ccd306251f605bea1571fcd8100407053600c4a4c94c3c86d"
ENDPOINT="http://localhost:8001/api/internal/extract-constraint"

# Context realistico (5 macchine, 20 ordini, 3 shifts, time_config)
# Wave 16.4: extended with operators list so the operator_unavailability
# pattern has aliases to resolve against. OP-1..OP-3 map to "operatore 1..3"
# in the alias table.
CTX='{
  "machines":["M-1","M-2","M-3","M-4","M-5"],
  "machine_aliases":{"linea 1":"M-1","linea 2":"M-2","linea 3":"M-3","linea 4":"M-4","linea 5":"M-5"},
  "orders":["COM-001","COM-002","COM-003","COM-004","COM-005","COM-006","COM-007","COM-008","COM-009","COM-010"],
  "operators":["OP-1","OP-2","OP-3"],
  "operator_aliases":{"operatore 1":"OP-1","operatore 2":"OP-2","operatore 3":"OP-3"},
  "shifts":["mattino","sera","notte"],
  "time_config":{"day_length_min":1440,"start_date":"2026-04-01"},
  "shift_types":{"mattino":{"start":360,"end":840},"sera":{"start":840,"end":1320},"notte":{"start":1320,"end":1800}},
  "order_deadlines":{"COM-001":7200,"COM-002":14400,"COM-003":1,"COM-007":28800}
}'

# 36 test cases con expected result
declare -a TESTS=(
  # HIT expected (≥0.85) — 12 casi
  "HIT|Alza priorità COM-001|order_priority"
  "HIT|Posso fermare la linea 2 dalle 14 alle 18|machine_unavail"
  "HIT|Anticipa COM-001 al 15/06/2026|deadline_change"
  "HIT|Anticipa COM-002 di 3 giorni|deadline_change"
  "HIT|Aumenta priorità COM-005|order_priority"
  "HIT|Ferma la linea 1 dalle 10 alle 12|machine_unavail"
  "HIT|Sposta turno mattino di 30 minuti|shift_window"
  "HIT|Anticipa turno sera di 1 ora|shift_window"
  "HIT|Aggiungi 2 operatori al turno notte|capacity_add"
  "HIT|Aggiungi un operatore al turno mattino|capacity_add"
  "HIT|COM-007 è urgente|order_priority"
  "HIT|Posso fermare M-3 dalle 09 alle 11|machine_unavail"

  # GRAY_ZONE expected (0.5-0.85) — 10 casi
  "GRAY|Ferma la linea 2 stamattina|machine_unavail"
  "GRAY|Anticipa COM-001|deadline_change"
  "GRAY|Aggiungi operatori|capacity_add"
  "GRAY|Cambia il turno mattino|shift_window"
  "GRAY|Anticipa COM-003 di 5 giorni|deadline_change"
  "GRAY|Sposta COM-099 al 20/07/2026|deadline_change"
  "GRAY|Sposta il turno sera|shift_window"
  "GRAY|Ferma la linea 99 dalle 14 alle 18|machine_unavail"
  "GRAY|COM-999 è urgente|order_priority"
  "GRAY|Aggiungi operatori al turno|capacity_add"

  # MISS expected (<0.5) — 8 casi
  "MISS|Se compro un robot in più che succede?|unsupported"
  "MISS|Posso ridurre il setup di M-1?|unsupported"
  "MISS|Quanti ordini sono in ritardo?|unsupported"
  "MISS|Vorrei lavorare meno|unsupported"
  "MISS|Aggiungi una macchina nuova|unsupported"
  "MISS|Stop|unsupported"
  "MISS|Voglio vedere il piano|unsupported"
  "MISS|Anticipa priorità setup COM ferma|unsupported"

  # Wave 16.4 D1 operator_unavailability — 6 nuovi casi
  # HIT — canonical (id esplicito + data + slot)
  "HIT|operatore OP-2 il 01/04 dalle 14 alle 18 è in ferie|operator_unavail"
  # HIT — num-only id + reason variant
  "HIT|operatore 2 il 02/04 dalle 09 alle 13 dal dottore|operator_unavail"
  # HIT — alias + relative date
  "HIT|OP-3 domani dalle 14 alle 18|operator_unavail"
  # GRAY — id+stato ma manca lo slot temporale
  "GRAY|operatore 2 malato oggi|operator_unavail"
  # GRAY — id senza data né slot
  "GRAY|OP-1 non disponibile|operator_unavail"
  # MISS — nessun segnale di vincolo (è un commento positivo, non un'assenza)
  "MISS|operatore felice|unsupported"
)

CORRECT=0
WRONG=0
HIT_COUNT=0
GRAY_COUNT=0
MISS_COUNT=0
TOTAL_LATENCY_MS=0
ERRORS=0

echo "=== STRESS EVAL: 36 scenari (Wave 16.2 base + Wave 16.4 operator_unavail) ==="
echo ""

for tc in "${TESTS[@]}"; do
  IFS='|' read -r EXPECTED INSTR EXPECTED_INTENT <<< "$tc"

  START=$(date +%s%N)
  BODY=$(printf '{"instruction":"%s","solution_context":%s}' "$INSTR" "$CTX")
  RESPONSE=$(curl -s -m 5 -X POST "$ENDPOINT" \
    -H "X-Internal-Secret: $SECRET" \
    -H "content-type: application/json" \
    -d "$BODY")
  END=$(date +%s%N)
  LATENCY_MS=$(( (END - START) / 1000000 ))
  TOTAL_LATENCY_MS=$(( TOTAL_LATENCY_MS + LATENCY_MS ))

  if [ -z "$RESPONSE" ]; then
    ERRORS=$(( ERRORS + 1 ))
    echo "  ❌ ERR: $INSTR (no response)"
    continue
  fi

  RESULT=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result','UNK').upper())" 2>/dev/null || echo "PARSE_ERR")
  CONF=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('confidence','?'))" 2>/dev/null || echo "?")
  PID=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('pattern_id','-') or '-')" 2>/dev/null || echo "-")

  case "$RESULT" in
    HIT) HIT_COUNT=$(( HIT_COUNT + 1 ));;
    GRAY_ZONE) GRAY_COUNT=$(( GRAY_COUNT + 1 )); RESULT="GRAY";;
    MISS) MISS_COUNT=$(( MISS_COUNT + 1 ));;
  esac

  if [ "$RESULT" = "$EXPECTED" ]; then
    CORRECT=$(( CORRECT + 1 ))
    MARK="✓"
  else
    WRONG=$(( WRONG + 1 ))
    MARK="✗ (exp $EXPECTED)"
  fi

  printf "%s [%4s c=%4s %dms] %-25s | %s\n" "$MARK" "$RESULT" "$CONF" "$LATENCY_MS" "$PID" "$INSTR"
done

echo ""
echo "=== SUMMARY ==="
# Wave 16.4 expanded distribution: 15 HIT (12 base + 3 operator) /
# 12 GRAY (10 base + 2 operator) / 9 MISS (8 base + 1 operator) = 36 total.
echo "  Correct:    $CORRECT/36"
echo "  Wrong:      $WRONG/36"
echo "  Errors:     $ERRORS"
echo "  HIT count:  $HIT_COUNT (expected 15)"
echo "  GRAY count: $GRAY_COUNT (expected 12)"
echo "  MISS count: $MISS_COUNT (expected 9)"
echo "  Avg latency: $(( TOTAL_LATENCY_MS / 36 ))ms"
echo ""

# Cost estimate (a HIT/GRAY/MISS extractor call costa ~$0.0001 — solo compute backend, no LLM)
# Vs Opus 4.7 fallback alternative ($0.45 per chiamata)
# HIT skip Opus, GRAY presenta confirmation, MISS triggers Opus
EXTRACTOR_COST=$(echo "0.0001 * 36" | bc -l)
OPUS_FALLBACK_COST=$(echo "0.45 * $MISS_COUNT" | bc -l)
SAVINGS=$(echo "0.45 * ($HIT_COUNT + $GRAY_COUNT)" | bc -l)
echo "=== COST TRACKING ==="
echo "  Extractor calls (compute only): \$${EXTRACTOR_COST}"
echo "  Estimated Opus fallback (MISS): \$${OPUS_FALLBACK_COST}"
echo "  HIT+GRAY savings vs Opus-all:   \$${SAVINGS}"
echo "  Total wave-16.4 cost:           \$$(echo "$EXTRACTOR_COST + $OPUS_FALLBACK_COST" | bc -l)"
echo "  vs Wave 16.1 Opus-all baseline: \$$(echo "0.45 * 36" | bc -l)"
