#!/bin/bash
#
# Does changing V1's BASE_TARGETS pay?
#
# `BASE_TARGETS` feeds `capitalAllocationInfo`, which multiplies every V1 candidate
# score — so it is a model constant, not a display one, and CLAUDE.md's rule applies:
# sweep it before shipping, do not reason a value into place.
#
# ── Why this design ──────────────────────────────────────────────────────────
#
# **V2 is the control, and it is free.** V2 never reads BASE_TARGETS, so its EV must
# come out IDENTICAL across every arm at a given seed. If it moves, something other
# than the constant changed — a pool refresh landing mid-sweep is the obvious
# candidate (§5.4b) — and the whole comparison is void. Check that column first;
# §5.4b was found exactly this way, by a control failing.
#
# **Every arm runs inside this one script**, back to back, so a background DK refresh
# cannot land between them. Do not run the app while this is going.
#
# **Two seeds.** The noise floor on a paired difference is ±$2 and absolute EV swings
# 3.5x on the seed alone, so a single-seed result is not a result. Anything that does
# not survive both seeds is noise.
#
# ── The arms ─────────────────────────────────────────────────────────────────
#
# baseline   what ships today: QB2 RB6 WR8 TE2
# candidate  the composite move toward the measured-free build
# te-only    TE 2->3 alone   — §5.4: TE<=2 measured -4.79 ±0.53pp
# rb-only    RB 6->5 alone   — §5.4: RB>=6 measured -4.77 ±1.83pp
#
# te-only and rb-only exist because §4 found that reaching several "free" counts at
# ONCE cost ~$30/entry while each was free alone. If the composite loses and the
# singles win, that is the same effect again and worth knowing rather than averaging
# away.
#
# Usage:  bash tools/v1-targets-sweep.sh [drafts] [seasons]

set -u
cd "$(dirname "$0")/.."

DRAFTS=${1:-150}
SEASONS=${2:-150}
PODS=300

# Override with SEEDS="a b c". Two is the minimum this codebase accepts; the first
# run at two seeds put te-only at +$52 and +$3, which is why there are now six.
SEEDS="${SEEDS:-20260730 20260817}"
ARMS="baseline:  candidate:QB:2,RB:5,WR:9,TE:3 te-only:QB:2,RB:6,WR:8,TE:3 rb-only:QB:2,RB:5,WR:8,TE:2"

echo "V1 BASE_TARGETS sweep — ${DRAFTS} drafts x ${SEASONS} seasons, field-pods ${PODS}"
echo "Started $(date '+%H:%M:%S')"
echo

for seed in $SEEDS; do
  echo "=================================================================="
  echo "SEED $seed"
  echo "=================================================================="
  printf "%-11s %-22s %10s %10s %8s   %s\n" "arm" "targets" "V1 EV" "V2 ctrl" "pool" "V1 build (QB-RB-WR-TE)"
  for entry in $ARMS; do
    name="${entry%%:*}"
    spec="${entry#*:}"
    out=$(V1_TARGETS="$spec" node tools/compare-models.js \
            --drafts "$DRAFTS" --seasons "$SEASONS" --truth market \
            --field-pods "$PODS" --seed "$seed" 2>&1)

    pool=$(echo "$out" | sed -n '1s/Loaded \([0-9]*\) players.*/\1/p')
    # The jackpot-capped row is the one to read: first place is 1-in-1089 and pays
    # 5,000x the min cash, so the uncapped total is dominated by whether a lottery
    # ticket happened to hit in this sample.
    v1=$(echo "$out" | awk '/TOTAL \(jackpot capped\)/ {print $4}')
    v2=$(echo "$out" | awk '/TOTAL \(jackpot capped\)/ {print $5}')
    build=$(echo "$out" | awk '
      /^Roster shape/       {inb=1; next}
      inb && /^  QB /       {qb=$2}
      inb && /^  RB /       {rb=$2}
      inb && /^  WR /       {wr=$2}
      inb && /^  TE /       {te=$2; print qb"-"rb"-"wr"-"te; inb=0}')
    printf "%-11s %-22s %10s %10s %8s   %s\n" \
      "$name" "${spec:-QB:2,RB:6,WR:8,TE:2}" "$v1" "$v2" "$pool" "$build"
  done
  echo
done

echo "Finished $(date '+%H:%M:%S')"
echo
echo "READ THIS FIRST: the V2 ctrl column must be identical within each seed block."
echo "If it is not, the pool moved mid-sweep and every V1 delta above is void."
