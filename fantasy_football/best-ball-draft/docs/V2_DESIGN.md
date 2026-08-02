# V2 recommender — design, evidence, and dead ends

Written so this can be picked up cold. The code says *what*; this says *why*, and —
more importantly — **what was already tried and failed**, so it isn't retried.

Format throughout: **DraftKings Best Ball, 20 rounds, 12 teams, full PPR.**
Contests played: $20M Millionaire and $1M Play Action. Both use the same
advancement structure (weeks 1-14 top 2 of 12 → wk15 top 1 → wk16 top 1 → wk17
final); they differ only in final field size.

---

## 1. The core model

Everything is denominated in **points per week**, so a number means the same thing
in round 2 as in round 18. V1's `1000/adp` curve is hyperbolic, which made every
multiplier's real-world aggression depend on where the player was going — a ×1.55
stack bonus moved a player 7 picks at ADP 20 and 71 picks at ADP 200.

Best ball counts the max of your roster at each slot each week, so a player's value
is how much he raises your weekly optimum:

```
gain = E[max(X − Y, 0)]      X = candidate, Y = current slot-holder
```

`Y` is a **random variable** — simulated (240 draws) as the k-th best weekly score
among players you already own at that position, each possibly absent for a bye or
injury. Modelling `Y` as random rather than fixed is what produces correct
diminishing returns, and is what replaced V1's position caps, roster targets and QB
emergency boost.

Lineup slots `QB 1.0 · RB 2.3 · WR 3.6 · TE 1.1` — fractions are each position's
share of the single FLEX spot.

Two phases scored separately: **accumulation 0.40 / spike 0.60**. Spike mode raises
the *bar* by 1 SD rather than inflating the player, which avoids double-counting
variance (an early bug — see §4).

Baseline is **65% VOR** (vs the last startable player, `slots × 12`) **+ 35% VONA**
(vs who survives to your next pick).

---

## 2. Constants, and the evidence for each

| Constant | Value | Basis |
|---|---|---|
| `V2_MARKET_PULL` | **5.0** | Swept. 0.25→−143 pts, 2.5→−41, 4.0→+22, 5.0→+30, 8.0→+36. Set mid-range, not at the sampled max, to avoid fitting the simulator. **The single most important constant.** |
| `V2_CUSTOM_RANK_WEIGHT` | **0.55** | Judgement, not measured. Board comes from a best-ball specialist; Sleeper/ESPN publish generic redraft projections that know nothing about spike weeks or playoff schedule. Effective shares: board ~52%, projections ~41%, ECR ~6%. |
| `V2_TIMING_WEIGHT` | 0.35 | VONA as a tilt on VOR. Pure VONA stockpiles whichever position degrades fastest. |
| `V2_W_ACCUMULATION / PLAYOFF` | 0.40 / 0.60 | Swept 100/0 → 40/60; roster shape barely moved (RB 4.06–4.14 throughout), so this is *not* the allocation lever it looks like. |
| `V2_CORRELATION_WEIGHT` | 0.35 | Swept; higher loses badly in the harness. **But see §5 — the harness cannot judge this.** |
| `V2_BACKFIELD_DISCOUNT` | 0.80 | Judgement. Retained spike value: backup behind a R1 workhorse 38%, two mid-round committee backs 73%. |
| `V2_VALUE_FIT_REF / FLOOR` | 0.50 / 0.20 | Roster-fit scaling, applied in three places (§3). |
| `V2_BREAKOUT_SD_GAIN` | **0.0 (off)** | Fully plumbed, doesn't earn its place. See §4. |
| `V2_OVER_TARGET_COST` | **0.0 (off)** | Roster-shape forcing. See §4. |

All are overridable via env (`V2_MKT`, `V2_RANKW`, `V2_CORR`, `V2_BREAKOUT`,
`V2_OVERCOST`, `V2_TIMING`, `V2_W_ACC`, `V2_W_PO`) for sweeping.

---

## 3. One idea appearing in three places: roster fit

**Value only counts if the player can actually reach your lineup.** Each of these
was found separately, as a bug, before the pattern was obvious:

1. **Falling ADP value** — a 3rd TE behind an elite one scored +0.93 for sliding 14
   picks, 43% of his total, enough to rank him #1. Reaching stays *unscaled* (over-
   paying is overpaying regardless of fit, and it's what anchors the model to ADP).
2. **Same-backfield spikes** — two backs from one team essentially never spike in
   the same week. Discounts the *spike* term only; accumulation genuinely benefits,
   since over 14 weeks the backup covers absences.
3. **Correlation** — a stack with a player who never starts isn't a stack. One TE
   was scoring 1.93 from game stacks against 0.50 of his own value.

---

## 4. Dead ends — do not retry without new evidence

**Forcing roster shape (3 attempts, all worse).**
The harness reports advance rate by construction, and V2's TE:4 builds do
underperform. But:
- Hard cap `MAX_ROSTER.TE = 3` → worse.
- Cross-positional flex bar (TE must beat your best spare RB/WR, not your 2nd TE —
  theoretically the right model) → advance +35.3% vs +38.7%, TE:4 share went *up*
  to 97.9%. Reverted, dead code removed.
- Soft `V2_OVER_TARGET_COST` → moved shape toward 3-6-8-3 exactly as intended while
  advance fell monotonically (0.0→+31.0%, 0.25→+24.4%, 0.50→+17.6%).

**The construction table is correlation, not causation.** V2 ends with 4 TEs when a
draft has *already* gone badly and the board is barren — the 4th TE is a symptom.
Forcing the shape just makes a worse pick at that moment.

**Breakout modelling from expert disagreement.** `rank_std` (FantasyPros, ~74
experts) is plumbed end to end and normalised by rank. Widens the spike term only.
Swept against the *upgraded* simulator (which does model role change): 0.0→+25.4%,
0.5→+18.2%, 0.8→+17.9%, 1.3→+20.5%. Disagreement does raise breakout odds, but not
enough to pay for the projection quality given up. Left off, behind `V2_BREAKOUT`.

**Need-scaled replacement horizon.** Scaling the VONA horizon by bodies still needed
silently handed WR (largest target) the lowest replacement level and highest VONA at
every pick. Slot attribution showed +71 pts at WR against −82 at RB and −28 at QB.
Replaced with one-step VONA, which is the correct pairwise-swap criterion.

---

## 5. Harness limitations — read before trusting any number

`tools/compare-models.js`. Two truth scenarios; **always read `market` (neutral)** —
`proj` grades V2 against its own answer key and is an upper bound only.

- **Week 17 is scored top-1-of-12, not against a 1,089-team final.** Winning a real
  final needs a far more extreme score, and correlation is what buys extreme
  outcomes. **The harness therefore cannot evaluate stacking**, and its verdict that
  higher `V2_CORRELATION_WEIGHT` hurts should not be trusted. This is the single
  biggest known gap.
- **The 11 opponents draft to noisy ADP**, not real strategies. No field-leverage or
  uniqueness modelling.
- **The truth model now includes role change** (breakouts/busts, `SIM_BREAKOUT` /
  `SIM_BUST`, ~2.3% for picks 1-60 rising to ~7.6% past 180). Adding it cut V2's
  measured edge from ~+47% to ~+24% — **every number quoted before that was
  flattered.** V1 falls further than V2 when roles change, which favours V2.
- **Jackpot EV needs thousands of finalists.** At a few hundred, one simulated $1M
  season is worth ~$116/entry and dominates everything. An early version reported
  "+882% EV" — that was one lucky team. Read the **jackpot-capped** row unless
  finalists number in the thousands.

### Current standing (500 drafts × 1200 seasons, 600k team-seasons, neutral truth)

| Metric | V1 | V2 | Δ |
|---|---|---|---|
| Top-2, weeks 1-14 | 23.30% | 28.82% | +23.7% |
| Reach the final | 0.97% | 1.28% | +31.4% |
| **EV per entry** | $23.69 | **$40.61** | **+71.4%** |
| EV (jackpot capped) | $19.45 | $27.87 | +43.3% |

Finalists sampled: V1 5,827 / V2 7,657. Jackpot hits: 3 / 9.

**Where the edge comes from** (per-slot points, `tools/slot-diagnostic.js`):
WR2 +26.7, WR3 +25.8, TE +24.3, WR1 +22.6, FLEX +11.7; QB −3.7, RB1 −3.5, RB2 −7.3.
Nearly all of it is receiver **depth** (9.0 WR vs 8.2), not better stars.

---

## 6. Data pipeline

| Source | Role | Notes |
|---|---|---|
| DraftKings | player pool, ADP | `fetch_players(force_refresh=True)`. **Blocks Render datacenter IPs for props** — verified 131 players locally, 403 from prod within the same minute. |
| Sleeper | projections (`pts_ppr`) | full PPR |
| ESPN | projections (`leaguedefaults/3`) | full PPR. **Only free source projecting receptions.** |
| FantasyPros ECR | rank blend + `rank_std` | Partners API. **Season projections are paywalled** to a 10-per-position teaser — the old scraper returned 40 players and never errored. |
| DK / Underdog props | component-level market correction | **Not a projection source** — neither book posts season receptions, so prop-implied totals understate pass-catchers by ~25-35% while RB/QB are near-complete. Corrections are applied per component; missing markets contribute exactly zero. |
| Your rankings | 0.55 weight | `tools/sync-ranks.py` pulls from prod. |

**DK scoring caveat (known, unfixed):** DK scores interceptions and fumbles at −1;
the sources use standard PPR's −2. Makes QBs ~0.9 ppg understated. Uniform across
QBs so relative order barely moves — judged not worth fixing.

**Name matching:** `app/data/names.py` canonicalises nicknames. DK says "Nick
Singleton"/"Kenneth Gainwell"; all three projection sources say
"Nicholas"/"Kenny". Unmatched players fall through to an ADP-implied estimate and
are scored as generic bodies — Gainwell was a round-8 pick valued on nothing.

---

## 7. Deployment

Render's filesystem is **ephemeral** — SQLite is wiped on every deploy and idle
spin-down. Anything that must survive lives in Postgres (`DATABASE_URL`):
`rankings_store`, `drafts_store`, `projections_store` (ESPN + props),
`kv_store_external` (Yahoo OAuth tokens).

Check `/api/stores/status` — it reads Postgres directly, unlike every other
endpoint. A warm instance looks healthy whether persistence works or not.

- Props for DK must be **uploaded** from a residential connection:
  `python3 tools/push-props.py` → `POST /api/props/upload` (BBA_API_KEY).
- `asset()` cache-busts static files by mtime. Hand-maintained `?v=N` caused
  browsers to run scoring code from before several fixes, silently.
- Flask runs `--no-reload`, so **restart the server after editing a template**.

**Recurring failure class:** bugs whose only execution path is a cold start
(`_seed_players_if_empty`, external-store creation). They cannot fail locally
because a dev DB always has rows. Test by pointing `DB_PATH` at a throwaway file
and running `init_db()` from scratch.

---

## 8. Board reading (2026 season)

From `tools/` analysis of the current board — usable supply by pick:

| Position | Usable players left after pick… | Market's median ADP (top 36) |
|---|---|---|
| **RB** (≥8 ppg) | 12 @ 72 · 5 @ 96 · **0 @ 144** | 44 |
| **QB** (≥14 ppg) | 18 @ 72 · 5 @ 120 · **1 @ 144** | 116 |
| **WR** (≥8 ppg) | 21 @ 72 · 6 @ 120 · **0 @ 168** | 37 |
| **TE** (≥7 ppg) | 23 @ 72 · **15 @ 120** · 5 @ 168 | 149 |

Supply exhausts **RB → QB → WR → TE**, roughly the inverse of how the market prices
them. QB is nearly flat QB2→QB24 (18.5→14.8 ppg) then falls off a cliff to 9.6 by
QB30 — so waiting on QB is right, but not past ~pick 130.

`v2PositionalRun` reads *this specific room* against ADP and shifts survival
accordingly (clamped 0.70–1.45). Improved advance rate +31.0% → +35.4%.

---

## 9. Open questions, highest value first

1. **Make the final field size real.** Score finalists against a simulated
   ~1,089-team field instead of their 12-team pod. This is the only way to settle
   whether `V2_CORRELATION_WEIGHT = 0.35` is too conservative — V2 carries 2.5
   stacked pass-catchers against V1's 4.4, and every best-ball source argues that's
   backwards for a top-heavy tournament. **Best guess at where money is being left.**
2. **Yahoo** — blocked on app registration at developer.yahoo.com needing Fantasy
   Sports read permission. Error is `"This application is not authorized to perform
   this action"`, which is app-level. Code side (scope, token persistence, Python
   3.9 compat) is done.
3. **Flex modelling** — TE gets a fixed 10% flex share against a 2nd-best-TE bar
   rather than a true cross-positional contest. Known approximation; the obvious fix
   measured *worse* (§4).
4. **V2 is not the default.** `/recommend` shows V1 and V2 side by side; V1 still
   drives nothing-changed behaviour. Swapping outright is premature — three real
   errors in V2 were caught by eye in its first day (stale FA team, name mismatch,
   inflated stack).
