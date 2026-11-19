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

What disagreed on 2026-11-17, and how it was settled on 2026-11-19:

| setting | RotoWire (Playoff Millionaire) | Stokastic |
|---|---|---|
| draft rounds | 12 | 20 |
| lineup | QB, RB, 2 WR, TE, FLEX | QB, 2 RB, 3 WR, TE, FLEX |
| final size | 816 | 81 |

**Settled by DK itself (2026-11-19).** The rules page (help/rules/nfl/playoff-best-ball)
and the lobby's game type both say **12 players**: QB, RB, WR, WR, TE, FLEX and 6 bench,
30-second fast drafts. The 20-round column was one write-up's error and its preset is
gone. Rules the recommender must respect, from the same page:
- **At least 1 QB, 1 RB, 2 WR, 1 TE, or the entry is invalid and scores nothing**; at
  most 3 QB and 3 TE. `canTake` in `recommender-playoff.js` never offers a pick that
  breaks either with the picks left.
- To be eligible for prizes you must edit DK's rankings, queue a player or pick by hand;
  6 missed manual picks in a row in a fast draft turn auto-draft on.
- Eliminated teams' players are disabled (red) as teams are eliminated, but can still be
  drafted by hand.
- Unfilled pods are topped up with wild cards (best non-advancing scores).

The 2026-27 tournaments (the user's lobby screenshot, 2026-11-19; DK leaves best-ball
tournaments out of the public lobby JSON, so this cannot be fetched):

| contest | fee | field | rake | max | final if 1 of 6 x3 |
|---|---|---|---|---|---|
| $5M Playoff Millionaire | $25 | 235.2K | 15.0% | ? | 1,089 |
| $1M Field General | $444 | 2,496 | 9.8% | ? | not whole: advances differently |
| $400K Play-Action | $3 | 158.3K | 15.8% | 20 | 733 |
| $100K Nickel | $5 | 23.7K | 15.6% | 10 | 110 |
| $50K Spy | $100 | 540 | 7.4% | 1 | not whole: advances differently |
| $50K Fair Catch | $12 | 4,752 | 12.3% | 1 | 22 |

The four whose field divides by 216 are presets on `/playoff`. Field General and Spy are
not, until their rounds tab is read. Playoff Sit & Gos (3 or 6 players, $1-$10,600, rake
10% up to $50 and 5.7% from $530) score the whole postseason cumulatively, which the
recommender does not model.

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

## 8. Drafting before the field is set (added 2026-11-17)

**DK's playoff drafts open in November, not after week 18.** Steps 1-4 assumed the
field was known; mid-season that meant treating "if the season ended today" as
certain: 14 teams in at fixed seeds, the other 18 teams' players not exported at all,
byes fixed. The writers who play these contests call the uncertainty the edge ("most
of the edge is before the field is set", RotoGrinders' expert survey, Dec 2025): strong
teams are cheap while their odds are unsettled.

**The model** (`../projections/pipeline/season_sim.py`), per simulated season:
1. every team's market rating takes a random walk to the wild card, SD **1.30 points**
   in total, measured on 2006-15 as the January fit minus the mid-November fit (1.42 on
   2016-25, not used to fit). A team that gets in has, on average, drifted up, so making
   the playoffs and winning in them are correlated;
2. every unplayed game is played, at the de-vigged moneyline where one is posted;
3. the NFL tiebreak procedure seeds the result, through strength of schedule. Checked
   on every real bracket 2002-25 from its real results: **300/300 teams and 300/300
   seeds**. A first version that stopped at conference record missed 10 teams and 28
   seeds, every miss a tie decided by common games, strength of victory or the sweep rule.

2,000 such seasons are written to the bracket file; the JS simulator plays world *w*'s
postseason on season *w*, so every player's value already includes P(his team is in)
and P(it has a bye). All 32 teams' players are exported.

**Availability by January** (`../projections/tools/measure_playoff_avail.py`, 2016-25,
players at 6+ DK points a game on teams that made it): **87.3%** of players playing now
played their team's first playoff game, flat across positions; **49%** of players out
now (n = 89) did. `avail` is that probability, drawn once per world; a backup QB stays 0.
Not modelled: a backup who becomes the starter, and a mid-season trade.

**Evidence, playoff odds** (`../projections/tools/backtest_season_sim.py`, 2,000
seasons per replay, from the point 8 weeks remain; lower is better):

| arm | make: log loss | make: Brier | bye: Brier | rounds: log loss |
|---|---|---|---|---|
| model, held out 2016-25 | 0.376 | 0.125 | 0.039 | **1.345** |
| no drift | 0.376 | 0.125 | 0.039 | 1.352 |
| every team average (standings only) | 0.380 | 0.123 | 0.041 | 1.407 |
| today's seeds as certain (what `/playoff` did) | 0.799 | 0.192 | 0.069 | 2.929 |

Today's-seeds is scored with probabilities clipped to 2-98% (its log loss is otherwise
infinite). Read it plainly: **ratings earn their place on who goes deep, not on who
gets in** (the standings alone predict making it as well, Brier 0.123 vs 0.125), and
the drift is a small gain (better in 8 of 10 held-out seasons on the rounds).

**Evidence, drafts** (`tools/playoff-backtest.sh` with `--data
../projections/data/playoff_backtest_mid`, real postseasons, one recommender seat and
five ADP bots on synthetic ADP; the files from `build_playoff_backtest.py --mid`):

| format | recommender P(R1) / P(final) | ADP seats P(R1) / P(final) | ratio | without best season | seasons better on P(final) |
|---|---|---|---|---|---|
| 12 rounds, 60 drafts | 26.7% / 0.82% | 14.7% / 0.26% | 3.1x | 1.8x (no 2024) | 4 of 10 |
| 20 rounds, 30 drafts | 16.7% / 0.08% | 16.7% / 0.49% | **0.17x** | 0.00x (no 2017) | **1 of 10** |

12 rounds: round 1 is again the solid number, better in 5 seasons, worse in 1, level
in 4; P(final) rests on a few seasons. **20 rounds: no edge in round 1 (better 5, worse
5) and worse at reaching the final in 9 of 10 seasons.** Thirty drafts is noisy, but this
is not noise around an edge. The 20-round preset was already "mixed evidence" after
week 18 (0.99x in-model); mid-season it should not be followed. **Investigated 2026-11-19, and moot:** DK's playoff format is 12 players only (§1), so
the preset was removed. What was found on the way: (1) the payout ladder was not the
cause (ranking by P(final) instead of EV was also worse, 0.56x vs 0.37x at 60 drafts);
(2) the redraft valuation is noisy (two completion seeds on one board: rank correlation
-0.2 to 0.5, top pick changed about half the time); (3) a paired 'swap' valuation fixed
the noise but not the result, in 20 rounds (round 1 15% vs ADP 17%) or in 12, where it
lost to redraft over 180 drafts (round 1 25.9% vs 28.9%, P(final) 1.76x vs 4.44x on the
120-draft batch). Redraft stays the default; swap is kept behind `method: 'swap'` and
recorded in the recommender's header as a dead end. `avail`'s rates were measured on these same seasons; they are
base rates applied to every drafter alike, so they do not favour the recommender seat.

**What the strategy write-ups say, against what the model does.** None showed data on
winning rosters; these are their authors' reasoning (Stokastic Aug 2026, RotoWire Jan
2026, PlayerProfiler Dec 2025, Spike Week Nov 2025, Establish The Run Nov 2025,
RotoGrinders Dec 2025):

- *Build for the Super Bowl* (one stack per conference, at most two teams per
  conference, ~5 players from the two finalists): the recommender's target is P(final)
  and EV, and it scores every lineup on the simulated finals, so this is its objective,
  not a rule it needs.
- *Cap bye-team players; cover the wild card*: byes are per world, and round 1 is scored
  as a pod you must win. Mid-season a bye is itself uncertain (the team tag shows it).
- *Don't stack teams that meet early*: the same-conference line under *My roster*, with
  P(they meet), from the same worlds.
- *Bubble teams*: the write-ups split (avoid them vs. take them cheap at ~40%). The
  model prices them by P(make) x what they do if in; it takes a side only through ADP.
- *DK rooms are soft and break stacks*: an edge the synthetic-ADP bots cannot show. The
  real test is real DK ADP (§6 step 4's to-do).

**Fast drafts.** DK's playoff drafts are 30 seconds a pick. The page polls the live board
every 3 s when your pick is on the clock or at most two away, 6 s otherwise, one request
at a time, and shows `updated N s ago`. The clock counts every pick DK has made: it had
counted only matched picks, so one unmatched pick would have put the wrong seat on the
clock.

[unusable players]: ../../CLAUDE.md
