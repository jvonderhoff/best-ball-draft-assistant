#!/bin/bash
# Run tools/playoff-backtest.js for every season in parallel, then summarise.
#   tools/playoff-backtest.sh dk-12 6           # preset, drafts per season
#   tools/playoff-backtest.sh dk-12 12 --from 6 --method redraft --completions 2   # new seeds, old method
#   PLAYOFF_BT_OUT=tools/.playoff-backtest/mid-dk-12 tools/playoff-backtest.sh dk-12 6 --data ../projections/data/playoff_backtest_mid
# Results land in tools/.playoff-backtest/<preset>/ (gitignored, regenerable).
set -euo pipefail
cd "$(dirname "$0")/.."
PRESET=${1:-dk-12}; DRAFTS=${2:-6}; shift 2 || true
OUT=${PLAYOFF_BT_OUT:-tools/.playoff-backtest/$PRESET}   # env override keeps runs apart
mkdir -p "$OUT"
for s in 2016 2017 2018 2019 2020 2021 2022 2023 2024 2025; do
  node tools/playoff-backtest.js --season $s --preset "$PRESET" --drafts "$DRAFTS" --out "$OUT/$s.json" "$@" &
done
wait
node -e '
const fs=require("fs"),dir=process.argv[1];
const rs=fs.readdirSync(dir).filter(f=>f.endsWith(".json")).map(f=>JSON.parse(fs.readFileSync(dir+"/"+f))).sort((a,b)=>a.season-b.season);
const m=(k,f)=>rs.reduce((a,r)=>a+r[k][f],0)/rs.length;
console.log(`\n${rs.length} seasons, ${rs[0].drafts} drafts each, preset ${rs[0].preset}`);
console.log(`  recommender  P(R1) ${m("rec","pR1").toFixed(3)}  P(R2) ${m("rec","pR2").toFixed(4)}  P(final) ${m("rec","pFinal").toFixed(5)}`);
console.log(`  ADP seats    P(R1) ${m("bot","pR1").toFixed(3)}  P(R2) ${m("bot","pR2").toFixed(4)}  P(final) ${m("bot","pFinal").toFixed(5)}`);
console.log(`  ratio P(final) ${(m("rec","pFinal")/m("bot","pFinal")).toFixed(2)}x; seasons where rec > ADP: ${rs.filter(r=>r.rec.pFinal>r.bot.pFinal).length}/${rs.length}`);
' "$OUT"
