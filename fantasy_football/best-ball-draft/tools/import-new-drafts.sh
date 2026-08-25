#!/usr/bin/env bash
#
# Import every saved DK draft that has finished since the last run, then re-score the
# survival model against the larger set.
#
# Slow drafts finish over days, so the useful dataset grows on its own — but only if
# somebody re-runs the import. This is that somebody. Already-imported drafts are
# skipped, and drafts still in progress are reported and left alone; run it whenever
# and it does the right thing.
#
# --include-opponents is REQUIRED here and must stay OFF for normal imports. The
# calibration needs whole boards: "was this player still available at pick 84" cannot
# be answered from your own 20 picks. Exposure, the History page and the extension
# export all mean "my roster" by picks, and they filter on the `mine` column, so the
# extra seats are invisible to them.
#
#   tools/import-new-drafts.sh
#
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
PY=.venv/bin/python

IDS=$(SAVED=.saved_drafts.json $PY - <<'PYEOF'
import json, os, sqlite3
saved = json.load(open(os.environ['SAVED']))
conn = sqlite3.connect('drafts.db')
have = {str(r[0]) for r in conn.execute(
    'SELECT dk_draft_id FROM drafts WHERE dk_draft_id IS NOT NULL')}
missing = sorted(set(map(str, saved)) - have)
print('\n'.join(missing))
PYEOF
)

if [[ -z "$IDS" ]]; then
  echo "nothing new — every saved draft is already imported."
else
  COUNT=$(wc -l <<<"$IDS" | tr -d ' ')
  echo "$COUNT saved draft(s) not yet imported; completed ones will come in."
  echo
  xargs $PY import_dk_history.py --include-opponents --ids <<<"$IDS" | tail -40
fi

echo
echo "── boards now available ──────────────────────────────────"
$PY - <<'PYEOF'
import sqlite3
c = sqlite3.connect('drafts.db')
n = c.execute('SELECT COUNT(*) FROM drafts').fetchone()[0]
full = c.execute(
    'SELECT COUNT(*) FROM (SELECT draft_id FROM draft_picks '
    'GROUP BY draft_id HAVING COUNT(*) > 200)').fetchone()[0]
print(f'  {n} drafts, {full} with full opponent boards (usable for calibration)')
PYEOF

echo
echo "── re-scoring the survival model ─────────────────────────"
python3 tools/calibrate-survival.py | tail -16
echo
echo "The live constants are V2_ADP_SIGMA_RATIO and the conditional form in"
echo "static/recommender-v2.js. If the fitted optimum has moved away from 0.10 on a"
echo "materially larger sample, that is worth acting on — see V2_DESIGN 2.2. A drift"
echo "in the third decimal on a handful of new boards is not."
