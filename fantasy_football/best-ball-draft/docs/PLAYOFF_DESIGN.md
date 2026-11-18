# Playoff best ball — design

Status: **steps 1-3 done and step 4's backtest run, 2026-11-17.** Left: the draft-week
runbook (§7) and the dry run once the lobby opens. Step 1, the bracket, is in `projections`
(`pipeline/bracket.py`, `cli.py playoff-bracket`). Step 2, player week scores, is the
`projections` export (`tools/export_playoff_players.py`) plus the simulator
`static/playoff-sim.js`, checked by `node tools/playoff-sim-check.js`. Step 3 is the
`/playoff` page, `static/recommender-playoff.js` and `cli.py playoff-publish`, checked
by `node tools/playoff-rec-check.js`. A playoff mode inside this app for
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
(week 18 is Sunday 2027-01-10 in the 2026 schedule), and drafts run in the days before
wild-card weekend (~Jan 16-18). The
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
3. **Done 2026-11-17.** The `/playoff` page, a separate page rather than a mode on
   `/recommend`, so the regular-season V1/V2 page is untouched.
   - **Formats** are two presets from the write-ups, which disagree: 12 rounds with a
     final of 816, and 20 rounds with a final of 81. Payouts are typed per draft; only
     prizes a source printed are prefilled.
   - **Ranking:** by EV when payouts are entered, otherwise by P(reach the final).
   - **Each candidate:** take him now, let ADP bots finish the board (my seat
     included), then score every roster on the same 2,000 postseasons. The later
     rounds are computed exactly from that world's survivor scores, not sampled.
   - **Pool and picks:** `/api/playoff/pool?dg=` joins DK's playoff pool and ADP to the
     export, and `/api/playoff/board/<id>` maps live picks. Both joins run in Python
     through `names.py`. Unmatched players are listed, not dropped.
   - **Inputs** arrive via `cli.py playoff-publish` and `/api/playoff/upload`, which
     fails closed without `BBA_API_KEY`. `/api/playoff/data` says the source and age.

   **Measured** with `tools/playoff-rec-check.js`. One seat drafts by the recommender,
   five by ADP. Every roster is then scored on fresh postseasons against a fresh field.
   The ADP seats are the control: they must come out at about 1/216.
   - **12 rounds: 4.6× the ADP seats' P(final). 20 rounds: 0.99×, no better.** Both
     come from 12 drafts and are in STATUS (2026-11-17). **The scoring model is the recommender's
     own**, and the ADP is synthetic: bots draft on expected points and ignore byes in
     round 1. So this shows the recommender uses its model well against such a room. It
     is not a real-world edge. Step 4's backtest on past postseasons is the real test.

   **What the check found:** the survivor pools let one roster appear twice in a pod,
   which made pods weaker. An average roster's round-3 survival read 15-24% above
   1/216. The pools are now tournaments over distinct boards; the sampled path reads
   exactly 1/216. The computed path reads up to ~10% high in the 20-round format. That
   level is the same for every candidate, so it does not change the ranking.
4. **Backtest done 2026-11-17** (STATUS has the table). On real 2016-25 postseasons
   the recommender's seat won round 1 about 24% of the time against 15% for the ADP
   seats. P(final) came out 2.1x (12 rounds) and 3.4x (20 rounds), but carried by one or
   two seasons each, and better in only 5-6 of 10. The round-1 edge is the measured
   one, and it is against bots blind to byes. Still to do:
   - ~~The draft-week runbook~~: done, `PLAYOFF_RUNBOOK.md`.
   - **A dry run on a mock board** once DK's playoff pool and real ADP exist.
   - **A re-run of this backtest with real ADP** once it can be captured, since the
     bots' blindness to byes is the main doubt.

[unusable players]: ../../CLAUDE.md
