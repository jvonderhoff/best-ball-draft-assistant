---
description: Refresh the market and the baselines, then read this week's start/sit and say what the script cannot decide.
argument-hint: "[lateround]"
---

Run the weekly routine and do the parts it deliberately does not: judge whether the
lineup is actually a WEEKLY one, and which players it is wrong about.

**Arguments: `$ARGUMENTS`.** Empty is the normal run. If it contains `lateround`,
the reader wants the lineup ordered by LateRound's ranks INSTEAD of the market —
add `--source lateround` to the `startsit` call below, and read the "Ordered by
LateRound" section at the end of this file instead of the market-specific
guidance. Anything else in `$ARGUMENTS` that looks like a league name means
restrict to that league with `--league`.

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

## Finally: one section per league, lineup as a table

The analysis above is for YOU to do, not to narrate. The reader wants the lineup.
An earlier run reported all of it as prose and the feedback was "too much info to
digest" — so the default output is a table per league and nothing else, with the
reasoning collapsed to the few rows where a human still has to choose.

Per league, in this shape:

```
### <league>  —  <points> proj, <n>/<m> market

| Slot | Player | Pts | LR | |
|---|---|--:|---|---|
| RB | Kenneth Walker III | 19.6 | RB13 t4 | |
| FLEX | Rico Dowdle | 13.9 | RB27 t7 | **IN** |
| TE | Chig Okonkwo | 7.1 | TE20 t7 | baseline |
| K | *nobody eligible* | — | | **empty** |

**Bench:** <who comes out>
```

`LR` is LateRound's rank and tier. The last column is for flags only, at most one
word: **IN** for a change from what is currently set on Sleeper, `baseline` /
`model` / `LR` where the number is not a market price, **empty** for an unfilled
slot. The lineup diff against what is actually set is the point — get it from
`roster_for_owner(...)["starters"]`, because "start Dowdle" is useful and a
lineup the reader already has set is not.

Then, and only then, at most **three short lines under the tables**:

- the calls you would OVERRULE, with the one reason;
- any unfilled slot, which is a guaranteed zero and beats every close call;
- what to re-run and when.

Everything else — coverage counts, calibration state, tier arithmetic, which
sources agreed — stays out unless it changed a decision. If it did change one,
it belongs in the overrule line, in a clause. **The lineup itself is a
maximum-weight matching, not a sort** (`sleeper/leagues/lineup.py`), so never
"fix" it by moving the top scorer into the first slot that fits: measured over
4,000 random cases that greedy answer was wrong 334 times and the matching 0.


## Ordered by LateRound (`$ARGUMENTS` contains `lateround`)

```bash
cd sleeper && .venv/bin/python cli.py startsit --source lateround
```

A different question: not what the roster is worth, but **who LateRound would
start**. Ordering is the one thing a rank can honestly answer.

Everything above about the market — coverage counts, calibration, `(season
baseline)` labels — is irrelevant here and must not be repeated. **There is no
projected total, and you must not compute one.** The right-hand column of the
output is the market's number printed for contrast; it did not build this lineup,
so do not add it up or present it as the lineup's value.

Report the same table per league, with `Pts` replaced by `LR` (their rank and
tier) and a `flex` column where one exists. Then, in at most two lines:

- **where this lineup differs from the market's**, which is the entire reason to
  run it — name the swap and both views, e.g. "market starts Dowdle (flex55),
  LateRound starts Washington (flex50)". Run the default `startsit` too if you
  need the comparison.
- **the two limits, only if they bit**: someone ranked at his position but
  outside the FLEX 100 was placed below everyone inside it, or a SUPER_FLEX slot
  was filled by the best remaining QB, which is a rule rather than their view.
  Both print as `note:` lines; pass them through, do not re-explain them.
