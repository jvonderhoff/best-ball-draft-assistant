---
description: Refresh the market and the baselines, then read this week's start/sit and say what the script cannot decide.
---

Run the weekly routine and do the parts it deliberately does not: judge whether the
lineup is actually a WEEKLY one, and which players it is wrong about.

```bash
cd sleeper && tools/weekly.sh
```

That refreshes the baselines, scrapes the per-game props once, syncs the rosters and
prints a lineup per league. **Run it once.** It makes a live scrape of the DK
sportsbook, which is the footprint `projections/tools/nightly.sh` runs only twice a week
to limit — and coverage grows toward kickoff, so later is better and the props expire at
24h by design. `tools/weekly.sh --no-refresh` re-reads what is on disk without fetching.

## First: is this a weekly lineup at all?

Read the `N/M priced by the market` on each START header before anything else. The
number that matters is how many STARTERS took a market price:

| priced | read |
|---|---|
| most of them | a real weekly lineup |
| a scattered few | thin coverage — normal early in the week, worth re-running later |
| **zero, in every league** | the seam is broken. The script exits 2 and says `NOT A WEEKLY LINEUP` |

That last row is not hypothetical. On 2026-09-08 the first run against real DK prices
scored **0/36 starters** from the market under a header saying 349 players were keyed:
the props file is keyed on `name_key` and the consumer was looking up `sleeper_id`, so
every lookup missed silently and every row fell back to a season average. Nothing about
the output looked wrong. If you see a full slate of `(season baseline)`, do not
interpret the lineup — find out why.

## Then: who is in it who should not be

**This is the most repeated bug in this codebase — value paid to players who cannot
play** — and start/sit is where it costs a week rather than a pick.

The tool now enforces what it can KNOW: Sleeper's own `status` and `injury_status` (IR,
PUP, NFI, Out, Suspended, DNR), plus the dated assertions in
`sleeper/data/unavailable.json`. Anyone it catches appears under **OUT** with the reason
and what he would have been worth. Read that block — and read the expired-assertion
warning above it, because an override nobody deletes keeps a healthy player benched.

Your job is the case it cannot know. The tell: **a player with NO market at all, whose
game IS priced.** DK prices ~26 players a game; a nominal starter the book will not take
action on is usually a player who is not playing, and Sleeper's feed can be days behind
or have no vocabulary for it at all — the commissioner exempt list reads back as
`Active` / `NA`. Measured on Week 1, seven rostered skill players fit that description
and they were not all the same thing:

- **Josh Jacobs** — GB depth chart **4**, groin, ADP down 58.7 with 23.5k drops. Real:
  he turned out to be on the commissioner exempt list, which Sleeper cannot express. He
  is in `unavailable.json` until 2026-09-15 — **extend or delete that entry** rather
  than letting it lapse silently.
- **Chig Okonkwo** — depth **1**, no injury. Not absent: DK writes *Chigoziem* Okonkwo
  and the crosswalk says *Chig*, so he is UNMATCHED, not unpriced. Check the export's
  `unmatched` list before calling anyone out.
- **Tank Dell, Ricky Pearsall** — IR, and now caught by Sleeper's own status.
- three genuine deep-bench players DK simply does not price.

So the discriminator is `depth_chart_order` plus `injury_body_part`, cross-checked
against the unmatched list. Run it each week to find the next Jacobs; when you confirm
one, add him to `sleeper/data/unavailable.json` with an `until` and a why:

```bash
cd sleeper && .venv/bin/python - <<'PY'
import sys; sys.path.insert(0,'.')
from leagues import config, sleeper, weekly
from leagues.store import Store
props = weekly.load_props(None); idx = props["by_sleeper_id"]
dump = sleeper.players(config.PLAYERS_CACHE)
store = Store(config.STORE_PATH); cfg = config.load(); uid = cfg.require_user()
unmatched = {n.lower() for n in props.get("unmatched", [])}
seen = set()
for lid in cfg.league_ids:
    r = store.roster_for_owner(lid, uid)
    for sid in (r or {}).get("players", []):
        if sid in seen: continue
        seen.add(sid)
        i = dump.get(str(sid)) or {}
        if i.get("position") not in ("QB","RB","WR","TE"): continue
        if str(sid) in idx or i.get("team") not in props["defenses"]: continue
        near = [u for u in unmatched if (i.get("last_name") or "~").lower() in u]
        print(f"{i.get('full_name'):<22} {i.get('position')} {i.get('team'):<4} "
              f"depth={i.get('depth_chart_order')} {i.get('injury_status')} "
              f"{i.get('injury_body_part') or ''} "
              f"{'UNMATCHED: ' + near[0] if near else ''}")
store.close()
PY
```

Cross-check anyone it names against the beat feed before benching them:

```bash
grep -i "<surname>" projections/data/nightly-latest.txt
```

## Then: which CLOSE calls are really close

The `CLOSE` list is inside 2.0 points, and two of those points are not equally solid.

**A propped touchdown number is an upper bound, not a calibrated projection.** Measured
against 2024+2025 play-by-play, `-ln(1-p)` is accurate to ~1% up to p=0.45 and then runs
away — **+5.6%** over 0.45-0.60 and **+20.5%** above 0.60 — and on top of that
`export_props.py` de-vigs its ladders 6% but does not de-vig the anytime-TD market at
all (Week 1's raw probabilities imply 25.7% more scorers than the slate's own implied
totals do). Neither is fixed.

So: when a CLOSE call is decided by a player with a **high anytime-TD price and little
else** — a goal-line back, a red-zone tight end — his number is inflated relative to a
receiver carrying real yardage markets. Say so on that row rather than reading the
lineup out as though every point were the same point. When both sides carry yardage
markets, the comparison is clean and the gap means what it says.

Comparing a market row against a `(season baseline)` row is also not clean, for the same
reason in the other direction — the market side reads high. The tool already labels
every row; use the label.

`(DST model)` is the third kind of row and the least like a price: no book prices a
defence, so that number is a regression on the opponent's implied total, corrected from
DK's scoring toward this league's where the rate could be measured. It is counted
separately in the START header for that reason. Two defences inside 2 points of each
other is not a decision worth agonising over.

## Finally

Give the actual calls, per league, shortest form that is still honest: what to start,
what to change from what is set on Sleeper now, and which decisions you are not
confident about and why. **The lineup itself is a maximum-weight matching, not a sort**
(`sleeper/leagues/lineup.py`) — so do not "correct" it by moving the highest-scoring
player into the first slot that fits. Measured over 4,000 random cases, that greedy
answer was wrong 334 times and the matching 0.

End by naming what you would want re-run closer to kickoff.
