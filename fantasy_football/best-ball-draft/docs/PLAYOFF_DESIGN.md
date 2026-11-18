# Playoff best ball — design

Status: **steps 1-2 done 2026-11-17.** Step 1, the bracket, is in `projections`
(`pipeline/bracket.py`, `cli.py playoff-bracket`). Step 2, player week scores, is the
`projections` export (`tools/export_playoff_players.py`) plus the simulator
`static/playoff-sim.js`, checked by `node tools/playoff-sim-check.js`. Steps 3-4 are
not started. A playoff mode inside this app for
DraftKings NFL playoff best ball. Decided with the user: it lives here, not in a new
project, because the DK draft capture, live board and queue push are reusable and only
the valuation is new. The contest format is **settings chosen per draft**, not a default
baked in, because the user has not picked a contest and public write-ups disagree.

## 1. The format, and what is not known

What sources agree on (checked 2026-11-17, re-check in the lobby):

- 6-person snake drafts ("pods"), DK classic scoring (full PPR, 100-yd / 300-yd bonuses).
- Rounds are scored **one playoff week at a time, knockout**: the top team in each pod
  advances, survivors are regrouped into new pods, and the Super Bowl week is a final.
- Only the 14 playoff teams are in the pool. The two 1-seeds have a bye: **their players
  score zero in round 1**.

What disagrees, so it is a setting:

| setting | RotoWire (Playoff Millionaire) | Stokastic |
|---|---|---|
| draft rounds | 12 | 20 |
| lineup | QB, RB, 2 WR, TE, FLEX | QB, 2 RB, 3 WR, TE, FLEX |
| final size | 816 | 81 |

```
format = { rounds, lineup:{QB,RB,WR,TE,FLEX}, pod_size: 6, advance_per_pod: 1,
           final_size, payouts: [...] }
```

Timing matters more than anything else here: the pool exists only once seeds are set
(week 18 ends early January), and drafts run in the days before wild-card weekend. The
tool has to be finished and tested **before** the lobby opens; there is no week to fix
it live.

## 2. Why the regular-season recommender cannot be reused

V2 scores a player by season-long marginal points over a lineup bar. In playoff best
ball the quantity that matters is different in three ways:

1. **A player's value is mostly whether his team is still playing.** A WR1 on a team with
   a 25% chance to reach the Super Bowl has expected weeks of ~2.0, not 4.
2. **Each round is its own contest.** You must top your pod in round 1 with whoever is
   playing that week, then again in a new pod. Total points do not matter; surviving
   each week does, and the final pays top-heavy.
3. **Correlation is about the bracket, not the game script.** Two teams that meet in the
   divisional round cannot both reach the Super Bowl; an AFC + NFC pair can, and that
   pairing is what wins the final.

So the playoff recommender is a **simulation**, not a scoring formula with terms. That
also avoids this project's most repeated bug ([unusable players]): a player whose team
is eliminated or on bye simply scores 0 in the simulated week, so there is no term
that can pay him for something he cannot do.

## 3. The model

Per candidate pick, Monte Carlo over N simulated postseasons (N ≈ 2,000, shared draws
across candidates so comparisons are paired):

1. **Bracket.** Seeds → wild-card games → re-seeded divisional → conference → Super
   Bowl. Each game's win probability comes from a team rating. Ratings are **fitted to
   the market**: wild-card moneylines directly, plus conference and Super Bowl futures,
   so that the simulator's championship odds reproduce the book's (vig removed).
2. **Player week scores.** Mean from the weekly props export for the week in hand
   (`projections` already produces DK-prop expected values per player); later weeks use
   the player's season per-game rate scaled by his team's implied total. Spread by
   position, drawn with a shared team-game factor so teammates move together and a QB
   with his pass-catchers more.
3. **My roster's week score** = best legal lineup from players whose team plays that week.
4. **The field.** The other five seats are completed by drafting to DK ADP with noise
   (the same ADP-bot field the regular-season harness uses). Survivors of later rounds
   are drawn from simulated advancing rosters, so each round's bar rises.
5. **Objective** = P(top of pod in R1) × P(R2 | R1) × P(R3 | R2) × E[payout | final],
   with `payouts` from the format. A small-field setting weights the survival terms; a
   large final weights the final-round ceiling. One formula, the format decides.

The pick shown is the candidate that raises the objective most, with the reasons that
make the number readable: P(alive) by round for that player, round-1 bye flag, which
of my teams he stacks with, and a warning when he is on the bracket path of a team I
already hold heavily (they must meet before the final).

## 4. How it fits the app

| piece | reuse or new |
|---|---|
| DK draft capture, live board, queue push | **reuse** — the draft group id identifies a playoff draft |
| player pool | **new table, keyed by draft group** — never mixed with the season pool |
| rankings | **new list** — formats never share rankings (umbrella rule) |
| bracket + ratings | **new**, fitted in `projections` (it already reaches the DK sportsbook from the Mac) and pushed as a payload, the same local-compute-then-push seam V2 uses |
| recommender | **new** `static/recommender-playoff.js`, loaded only in playoff mode |
| scoring rules | DK classic — the `dfs` repo has them; copy the table, no shared code |

## 5. How it will be checked before it is trusted

The measurement rules in STATUS/V2_DESIGN apply: paired comparisons, a control that must
not move, and seeds replicated before believing a small difference.

- **Bracket:** simulated title odds must reproduce the input futures (it is fitted to
  them, so a miss is a bug). Held-out check on the 2025-26 postseason: wild-card lines
  in, compare simulated reach-probabilities against what happened (one season is a
  sanity check, not a calibration).
- **Recommender:** inside the simulator, against an ADP-only drafter as the control —
  the same V1-as-control discipline. Report P(final) and EV by format, at several seeds.
- **No real-draft calibration is possible this season** — there are no past DK playoff
  boards in `drafts.db`. Say so wherever a number is quoted.

## 6. Build order

1. **Done 2026-11-17.** Bracket simulator + market-fitted ratings, backtested held out on
   2015-2025 (numbers in `projections/README.md`, *Playoff bracket*). Ratings come from
   season spreads rather than futures: they exist for every past season, so they could be
   backtested, and futures could not. Futures stay a check for draft week. The contest
   format settings moved to step 3, where they are first read -- a setting with no
   reader yet is bug class 6.
2. **Done 2026-11-17.** Player week scores, lineups and the field. Measured in
   `projections/tools/backtest_playoff_scores.py`, choices made on 2016-21 and checked
   on 2022-25, and recorded in `projections/pipeline/playoff_scores.py`:
   - **mean** = season DK points per game × playoff discount (RB 0.92) × the square root
     of (game implied total / season implied total). Held-out average error 4.78 → 4.70
     points.
   - **spread** = a + b·mean per position. The **shape is normal**: it matched the
     upper tail, where a lognormal ran about 25% short.
   - **correlation**: each player loads on a game factor, plus a within-team matrix.
     QB-WR +0.31, receiver-receiver ~0, QB vs the opposing QB +0.23. These apply only
     to players averaging 6+ points.

   Three things the check script caught that would otherwise have been silent:
   - **Correlations on whole depth charts.** Applied to every player, they made the
     matrix invalid, so it was shrunk and QB-WR came out at 0.20.
   - **The Sleeper join.** Sleeper keeps duplicate records for some players. Taking
     the last one read turned 8 teams' starting QBs into backups and hid 15 IR players.
   - **Survivor sampling.** Round-1 survivors taken from random rosters instead of
     real boards put round-3 survival 15% too high.

   Backup QBs (not first on the depth chart) score nothing. Their per-game numbers are
   real, from the games they started, which is exactly why they would otherwise be
   overvalued.
3. Format settings, `recommender-playoff.js` (re-simulates from the bracket file's
   `ratings` + `fixed`, so its draws join to player scores) and the playoff mode on
   `/recommend`; pool table by draft group.
   Step 3 also replaces the SYNTHETIC ADP (expected postseason points) that the field uses
   until a real DK playoff pool exists.
4. Dry run on a mock board before the lobby opens; then capture the real pool the day
   it appears, set the format from the lobby, and re-run the checks.

[unusable players]: ../../CLAUDE.md
