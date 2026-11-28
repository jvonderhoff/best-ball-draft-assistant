# Playoff strategy lab — the ledger

Every idea for how `/playoff` should pick, whether it has been tested, and what
happened. **Read this before testing anything**: half the obvious ideas are already
here as losses, and the point of the ledger is that nobody runs them twice.

The engine is `tools/playoff-lab.js`; strategies ("arms") live in
`tools/playoff-lab-arms.js`. The page itself ranks by P(reach the final) and nothing in
the lab reaches it. A theory ships only after the user says yes, and only after it
has also held up on real postseasons (`tools/playoff-backtest.sh`).

## How a test is run

```bash
cd best-ball-draft
DATA=../projections/data ADP=tools/.playoff-adp/<dg>-<day>.json     # newest saved pool
seq 500 509 | xargs -n 1 -P 10 -I{} node tools/playoff-lab.js --data $DATA --adp $ADP \
  --preset play-action --arms control,<arm>:<param> --from {} --drafts 1 --out lab.jsonl
node tools/playoff-lab.js --summary lab.jsonl
```

1. **Screen**: 10 drafts, the arm against `control`. Drop it if reach-final is worse by
   more than 2 se, or if nothing moves by more than 1 se.
2. **Confirm**: 40+ drafts on NEW seeds (never the screening seeds). Only a confirmed
   result goes in the table as WON.
3. **Real postseasons**: before anything reaches the page, the same rule through
   `tools/playoff-backtest.sh` on 2016-25. Simulated postseasons share the model's
   assumptions; real ones do not.

## The rules, and the failure behind each

- **Paired, always.** Every arm drafts from the same seat against the same bot
  randomness; read the paired difference and its se, never two levels.
- **Fresh worlds.** Score on seed 999 / field 555 (default 10,000 worlds), never on the
  recommender's own seed-1 worlds, which flatter whichever arm agrees with it.
- **One data stamp per comparison.** `--summary` refuses rows drafted on different
  data. A data push mid-experiment moved V1's EV 12% on identical code (CLAUDE.md).
- **A correlation is a theory, not a result.** The 100 replays showed 5-stacks winning
  the final 5x as often; forcing the stack did nothing (below). Test the cause.
- **Win-the-final is rare.** At 2,000 worlds it was the noisiest number in every test;
  read reach-final and win-group alongside it, and distrust a pWin gain that costs
  reach-final.
- **Levels are not real-world rates.** Opponents are ADP bots (or `--room-share`
  stackers). Compare arms with each other only.
- **Forcing roster shape has lost every time** (V2_DESIGN §4, PLAYOFF_DESIGN §9, and
  the stack bonus here). A new shape rule needs a reason it is different.

## The ledger

| # | Theory | Arm / tool | Result | Date |
|---|---|---|---|---|
| 1 | Wait on a top player sure to last; take a ≈ row now | automock `wait` | **LOST**: final −0.10 pts (se 0.09), 5 better / 8 worse of 20 | 2026-11-25 |
| 2 | Never a 2nd QB | backtest `--rule qb1` | **LOST** on real postseasons: round 2 −2.2 pts (se 1.4), P(final) ~halved | 2026-11-25 |
| 3 | Always 2 QBs | backtest `--rule qb2` | **NO EFFECT** | 2026-11-25 |
| 4 | ≤7 players per conference | backtest `--rule conf` | **LOST**: round 1 −1.7 pts (se 4.4), P(final) 4.44x → 1.44x ADP | 2026-11-19 |
| 5 | On course for ≥7 wild-card-week players | backtest `--rule wc` | **LOST**: round 1 −5.0 pts (se 4.7), P(final) 0.37x ADP | 2026-11-19 |
| 6 | Force a week-1 lineup | page re-rank | **LOST** (STATUS 2026-11-19); the check warns, never re-ranks | 2026-11-19 |
| 7 | Assume 40% of the room stacks | automock `--model-share 0.4` | **UNRESOLVED**: sim +0.30 pts final (se 0.13); real postseasons 5/10 | 2026-11-25 |
| 8 | Rank by expected winnings (top-heavy table) | automock `--payouts` | **LOST**: final 2.83% → 1.15%, win final 0.22% → 0.12%, 15 of 20 worse | 2026-11-27 |
| 9 | Stack bonus: pFinal × (1 + b × teammates) | `stack:0.1`, `stack:0.25` | **LOST**: final −0.40 (se 0.12) / −0.72 (se 0.13); win final flat (−0.015 se 0.033) | 2026-11-27 |
| 10 | Lean toward winning: pFinal^(1−a) × pWin^a | `win:0.25` | untested | |
| 11 | From round 10, rank by win-final | `latewin:10` | untested | |
| 12 | More compute per pick: 48 simulated drafts | `compute:48` | untested | |
| 13 | QB cap 1 on DK's real ADP (only tested on synthetic) | `qbcap:1` | untested | |
| 14 | Room stacks for real: does the tool's edge hold? | `--room-share 0.4`, control | untested | |
| 15 | Leverage: favour teams the room is under-drafting | (arm to write) | untested | |
| 16 | Bring-back: favour the likely Super Bowl opponent of my main stack | (arm to write) | untested | |
| 17 | Commit early: a main team by round 3, Build-around from then | (arm to write) | untested | |

Add a row when a theory is proposed, even before it runs. When it runs, record the
command's stamp, seeds, n, and the paired numbers — enough that the result can be
reproduced and nobody has to rerun it to know.
