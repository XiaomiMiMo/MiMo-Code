#!/usr/bin/env bash
# Usage: run_case.sh <candidate.py> <case_basename>
# Prints: score=<0.0-1.0> time=<seconds> status=<done|error>
set -uo pipefail
CANDIDATE="$1"
CASE="$2"
IN="$(dirname "$0")/cases/${CASE}.in"
GOLD="$(dirname "$0")/cases/${CASE}.gold"

START=$(python3 -c 'import time; print(time.time())')
OUT=$(python3 "$CANDIDATE" < "$IN" 2>/dev/null)
RC=$?
END=$(python3 -c 'import time; print(time.time())')
ELAPSED=$(python3 -c "print(${END} - ${START})")

if [ "$RC" -ne 0 ]; then
  printf "score=0.0 time=%.4f status=error\n" "$ELAPSED"
  exit 0
fi

# similarity = 1.0 if exact match on stripped text, else 0.0 (toy metric)
GOLD_TEXT=$(cat "$GOLD")
if [ "$OUT" = "$GOLD_TEXT" ]; then
  printf "score=1.0 time=%.4f status=done\n" "$ELAPSED"
else
  printf "score=0.0 time=%.4f status=done\n" "$ELAPSED"
fi
