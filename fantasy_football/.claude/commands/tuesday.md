---
description: Tuesday-night routine, before waivers process — recapture LateRound (weekly + rest-of-season) and the week's waiver columns, refresh the market and the field, then read start/sit, what each roster needs, every FAAB league's waiver board, the roster-shape view across all four leagues, and the redraft trade board.
argument-hint: ""
---

The Tuesday-night question is not "what do I start Sunday" — it is "what is
each of my rosters short of, and is there a free agent who fills it before
waivers clear." It starts from the ROSTER, not the wire: on 2026-10-20 the
report ranked free agents player-against-player, proposed Calvin Ridley in two
leagues as the top "gain" (a preseason number; he was scoring 2.6 a game), and
found Justice League's empty DEF slot by luck. The user's verdict: "not that
helpful. It needs to look at my roster and see what I need." So Step 2b reads
the needs first, and every claim in the report names the need it fills.

Answering that needs both
LateRound pages, not one: the **weekly** page for this-week start/sit, the
**rest-of-season** page as a second opinion on the waiver board's own VOR
column. Running only one and skipping the other silently answers half the
question.

Six steps: recapture LateRound, refresh the market and the columns, read what
each roster needs, read every waiver board, read the roster-shape view, then
read the redraft trade board. The needs view says what to look for; the waiver
board says what it costs; the trade board is what to do about a need the wire
cannot fill.

The report at the end has a fixed shape — see **The report** at the bottom.
Needs and the claims that fill them come first, because they are the reason
this routine exists.

## Step 1 — recapture LateRound

Both captures are member-only pages that 302 for a scripted fetch, so both are
taken in a signed-in browser and only parsed in Python — same architecture,
different scripts:

| page | script | output |
|---|---|---|
| `lateround.com/rankings-tiers/weekly-rankings/` | `projections/tools/lateround-capture.js` | 4 CSVs |
| `lateround.com/rankings-tiers/rest-of-season-rankings/` | `projections/tools/lateround-ros-capture.js` | 1 CSV |

The weekly script's four downloads are staggered ~500ms apart, but **that does
not reliably fix Chrome's download-blocker** — verified by re-testing live on
2026-09-16 and still only 1 of 4 files landed. DevTools console execution
carries no page-level user gesture, so every download past the first reads as
unsolicited no matter the spacing. **The working fallback, proven twice:**
read each table's rows with a small `document.querySelectorAll('table')`
snippet per call and write the CSV directly from the returned text, instead of
clicking through the download. Write the CSV headers the script writes, and
map **by the page's header labels, not by column position**: the kicker table's
fourth column has been **Tier** since 2026-09-23, so it goes under `tier` in
`rank,kicker,team,opponent,projection,tier` (leave `projection` blank). The
week-5 capture put it under `projection` and Reichard reached startsit at 1.0
points; `export_lateround.py` now refuses that board. The single-file ROS capture has no
multi-download problem — its one download lands every time.

Move the captured CSVs into `projections/data/`, then:

```bash
cd projections && .venv/bin/python tools/export_lateround.py --week <current week>
cd projections && .venv/bin/python tools/export_lateround_ros.py
```

Each prints a coverage line (`N ranked, M unmatched`, by-position counts). Read
it before moving on — 0 unmatched and ~150 ranked is a clean capture; anything
short of that, redo the browser step rather than trusting a partial one.

## Step 1b — the week's waiver columns (automatic)

The wire's best add is routinely a player with no stat line and no LateRound
rank, so he is invisible to both of the columns above — he shows up in the
board's coverage line as one of the ~400 who "carry no number at all". Three
outside signals cover him: Sleeper's trending adds, the news RSS, and the
week's waiver columns. Since 2026-10-07 `tools/weekly.sh` (step 2) fetches all
three; the columns come from FantasyPros, SI, DynastyNerds, CBS and Yahoo via
`projections/tools/capture_waiver_columns.py`.

**Read its five lines.** Each source prints its row count and publish date, or
`SKIPPED —` and why: no column for this week on the index yet, a page dated
outside this week (it refuses last season's article), or a short parse (a
layout change). A skip early in the week is usually just a column not posted
yet. If a source you want is missing, point it at the article directly:

```bash
cd projections && .venv/bin/python tools/capture_waiver_columns.py --week <n> --url SI=https://...
```

A column the tool does not know (Rotoballer, a podcast's list) can still be
added by hand to `projections/data/waiver-articles.json`, one row per
(player, source); re-runs keep hand-added sources for the same week.

**Every article row must match** — the buzz export's `articles:` line says
`N of N rows`. An unmatched row is a spelling this repo cannot resolve, and it
is reported rather than dropped; fix it before reading the boards.

## Step 2 — refresh everything else, read start/sit

```bash
cd sleeper && tools/weekly.sh
```

Read the output exactly as `/startsit` says to: check `N/M priced by the
market` before trusting a lineup, catch the player with no market at all whose
game hasn't kicked off, weigh a CLOSE call against the source it came from. Do
not re-derive those rules here — follow `/startsit`'s own judgment calls.

**The one thing that's different on a Tuesday: thin market coverage is
EXPECTED, not a red flag.** DK's board fills in toward kickoff, so a Tuesday
run of `weekly.sh` will show far fewer starters priced by the market than a
Thursday run of the same command would. The point of running this on Tuesday
is narrow — catch a start-worthy free agent before you lose the waiver
priority to claim him, not finalize Sunday's lineup. Re-run `/startsit` on its
own later in the week for that.

## Step 2b — what each roster needs

```bash
cd sleeper && .venv/bin/python cli.py needs
```

No `--league` runs all four. Per league: the best legal lineup on LateRound's
rest-of-season list (healthy players only, with actual points a game beside
each), the depth line, then **NEEDS**, numbered, each tagged with its kind:

- **`this_week`** — a slot nobody ranked who plays can fill this week: a bye
  (JAX DEF, 2026-10-20) or an Out starter with no ranked backup. It names the
  unranked bench players who DO play; often the answer is "start Bourne", not
  a claim.
- **`short`** — a position below its floor (slots + depth, the trade board's
  rule): IR, PUP, a suspension or an `unavailable.json` assertion is gone for
  the season; a one-week Out is not.
- **`empty`** — a slot nobody ranked can fill at all.
- **`upgrade`** — a starter that a free player beats by a WHOLE LateRound tier.
  Inside one tier it is noise and is not listed.
- **`bye`** — the same as `this_week`, for the next two weeks: claim ahead of it,
  or plan to stream.

Then `surplus` (positions above their floor, where a cut costs nothing) and
**TARGETS**: free players at a needed position only, each with the drop that
leaves every position at its floor (in dynasty, the lowest KTC). Each target
prints the signal it rests on, under it:

- **the field** — the columns that named him with their FAAB range, and his
  trending adds (`CBS, Yahoo [3-5%] · 552k adds`);
- **next up** — off Sleeper's depth chart: `next up for X (IR)`, or `starting
  while X (Out) is hurt`;
- **ranked** — LateRound's rank and tier, with actual points a game.

They are ordered field and next-up first (by adds), ranked-only last, because
the man who inherited a job on Sunday has neither a rank nor a rate. Added
2026-10-20 after the user asked "It's all based on PPG? What about waiver
articles. Injuries happen and need the next guy up": the first version offered
Kimani Vidal (RB53, no columns) for Justice League's RB hole and never showed
Tyrone Tracy (two columns, 553k adds, NYG's RB2 with Skattebo benched).

`start X — no claim needed` under a this-week or bye need means an unranked
bench player who plays fills it; that player is never offered as the drop.
`nothing free fills it` is a finding: a season need goes to the trade board, a
week's need to Wednesday's free agents.

**Every claim in the report must fill one of these needs, or say why it is
worth a roster spot anyway.** A big-buzz add that fills no need (the week's hot
handcuff, a dynasty stash) can still be right, but it has to say so; the
waiver board's top VOR row is not a reason on its own. At a needed position, a
target with a field or next-up signal beats one with points a game alone; pick
the points over the signal only with a reason in `Why` (Gesicki's 13.0 a game
over Mayer's three columns, say). Where the waiver board's
`ROS` for a target is marked `p` (preseason) or disagrees with the actual
points a game this view prints, believe the actual points.

## Step 3 — read every FAAB league's waiver board

```bash
cd sleeper && .venv/bin/python cli.py leagues
```

confirms which leagues currently carry a FAAB budget (`cli.py leagues`'s own
output says so per league — do not hardcode league ids here, they drift as
leagues get re-synced). For each one:

```bash
cd sleeper && .venv/bin/python cli.py waivers --league <league id>
```

Three columns now carry independent second opinions, and none of them are
summed into VOR or into each other:

- **`LR`** — LateRound's rest-of-season rank and tier, the human second
  opinion on the exact question the `ROS`/`VOR` columns already answer from a
  stat line. `--` means LateRound doesn't rank that player at all, which is
  common outside their top ~150 and is not itself a signal.
- **`BUZZ`** — what the rest of the world is doing: Sleeper trending adds
  (`310k`) and how many waiver columns named him (`2★`). Popularity, never
  points — it is not summed into anything and cannot be compared with a VOR.
- **`KTC`/`DYN#`** — the dynasty trade market, dynasty leagues only.
- **`BID`** — a suggested FAAB dollar amount, printed with its own honesty
  line (`n`, MAE vs. the naive baseline) every time. Read it as a range, never
  as the number to type into Sleeper — see `leagues/faab.py`'s header for why.

**Read the section under each board — `THE FIELD IS ADDING THESE, and the
table above did not`.** On a Tuesday this is often where the real claim is: the
ranked table can only rank players it has a number for, and the man who
inherited a job on Sunday has neither a stat line nor a LateRound rank. Each
row carries our own number where one exists (`ros 0.6`) or `no number` where it
genuinely does not, plus the add count, which columns named him, the FAAB range
they suggested, and one line of why. A big add count next to a low `ros` is not
a contradiction — it is the crowd pricing a job change that the season rate has
not caught up with yet, which is exactly the disagreement worth reading.

A league whose FAAB board prints "only N winning FAAB bid(s) synced" below the
15-bid minimum is not broken; it just doesn't have enough history yet for a
bid suggestion, and the VOR/LR columns are still worth reading on their own.

## Step 4 — read the roster-shape view, every league

```bash
cd sleeper && .venv/bin/python cli.py gaps
```

No `--league` runs all four. Where `waivers` asks "who should I add", this asks
"does my roster still make sense", and it covers the leagues the waiver board
has nothing to say about. Three sections per league:

- **`UNRANKED, on your roster`** — who you carry that LateRound's 150 does not
  reach, with his slot and depth-chart spot. Not a verdict: the list runs out
  at roughly a startable WR5, and a player can be unranked and still be the
  week's biggest add (Tre Tucker, 990k adds, unranked, 2026-09-22).
- **`RANKED and free`** — their ranked players nobody rosters, each marked
  `free` or `ON WAIVERS until <day>`. Every running back (here and in the
  unranked list) also says whose job he is one injury from: `RB2 behind J.
  Taylor (RB4)`, `lead back while S. Barkley (RB16, Questionable) is hurt`, or
  `NEXT UP` when every back ahead is out. That is the case for a backup a
  low rank cannot make on its own — read it before calling RB50 vs RB56 noise.
- **`OUTRANKED by someone free`** — the row worth acting on, and the one the
  other two miss. A ranked player of yours with better free players above him
  never appears in the unranked list at all: on 2026-09-22 that was Dallas
  Goedert, TE19, with three free tight ends rated over him.

**Zero ranked free agents is a finding, not an empty screen.** Both dynasty
leagues print it, because in 12-team superflex with 12- and 15-man benches
every ranked player is owned. That says trade, not claim, and no amount of
staring at the waiver board will say it.

K and DEF are skipped throughout and the command says so — the ROS page ranks
QB/RB/WR/TE only, so an unranked kicker reports the source's scope rather than
anything about him.

## Step 5 — read the redraft trade board

```bash
cd projections && .venv/bin/python tools/export_fantasypros_ros.py \
  && .venv/bin/python tools/export_redraft_values.py
cd ../sleeper && .venv/bin/python cli.py trades
```

Run AFTER step 1: it measures LateRound's rest-of-season list against the
FantasyPros consensus, so a stale capture is a stale disagreement. Both
exports are public fetches (no login) and refuse a partial board.

The dynasty leagues run through the same command against LateRound's DYNASTY
board and the KTC/FantasyCalc market (see `sleeper/README.md`). That board is
captured separately (`tools/lateround-dynasty-capture.js`) and changes rarely —
**read its `PAGE UPDATED` line first**. Past three weeks the command warns, and
the BUY list is mostly the market having moved on games the list predates;
lean on the `now` column and the `COSTS NOW` / `STARTER` flags, which read
this week's data.

- **`BUY`** — players on other rosters LateRound puts a whole tier (its own
  tier breaks) above where the consensus does. `OUTSIDE-ALL-EXPERTS` means
  LateRound's spot is beyond every expert's in the consensus — the strongest
  flag, and they sort first.
- **`SELL`** — yours, the other way round: the consensus (roughly what the
  other managers are reading) rates him higher than LateRound does.
- **`1-for-1 PAIRS`** — LateRound prefers what comes in, FantasyCalc prices
  the two within ±15%, and at least one side is a disagreement. Each pair
  carries `roster` (your side, with `THINS` / `WEAKER ROSTER`) and, under it,
  `their fit`: +1 if the other manager is short at what he gets, +1 if he is
  deep at what he gives, -1 for the reverse of each, measured against the
  league's median at that position. A negative fit is an offer he has a reason
  to refuse, and it sorts below the rest. Lead with the pair's edge, then say
  why HE would take it -- the fit line is that sentence.
- **`NOT PAIRED`** — injured or asserted out. A buy-low there is a bet on a
  return date, which none of the three lists knows.

The consensus is **6 of 30 experts** — the free page's set — and the header
says so. Trade deadlines print per league.

## Step 6 — the quarterback projection check (one line)

```bash
cd projections && .venv/bin/python tools/backtest_qb_parts.py
```

Reads the box scores the 08:00 launchd job fetched; fetches nothing. Report the
newest week's line only: its passing-yards bias and total Spearman. Weeks 1-4
ran ~32 yards LOW from a ladder-integration bug fixed 2026-10-08, so week 5 on
should read near zero. If the newest week is still 20+ yards low, say so in
Inputs as a regression to look at; anything else is one quiet line.

## The report

The routine started as "should I put a FAAB bid or a waiver claim on anyone",
and the report answers that before anything else. Five sections, always in
this order, and nothing from the steps above is pasted in raw:

**1. Needs and claims** — first, one bullet per league (same order as the
table) saying what that roster needs, off Step 2b: every `this_week`, `short`
and `empty` need by position, plus a `bye` in the next two weeks if it changes
a claim. "No needs" is a valid line. Then one table, every league, ordered by
when its waivers run (earliest first), with the league's FAAB left in the
header:

```
- **Justice League**: DEF this week (JAX bye); RB short for the season (3 of 4).
- **NNCC**: QB this week (Daniels bye); TE short (1 of 2).
- **Haters Club**: TE short (1 of 2); nothing ranked is free — trade.

| League (FAAB left, runs) | Need | Claim | Bid | Drop | Why |
|---|---|---|---|---|---|
| Justice League ($79, Wed 02:11) | RB short | Will Shipley RB PHI | $40–60 (most-bid line) | Kenny Gainwell | Barkley + Bigsby hurt; 3 columns, 866k adds |
| NNCC (no FAAB, Wed 11:04) | QB this week | Kyler Murray QB ARI | free add | Mike Washington | Daniels on bye; Murray QB17 is free now, Stroud costs the claim |
| Haters Club ($85, Wed 02:16) | TE short | — no claim | | | no ranked TE free; trade (section 4) |
```

- Every league gets a row, including the ones with no claim — say why in
  `Why` ("wire empty", "nothing beats your bench").
- `Need` names the Step 2b need the claim fills (`RB short`, `DEF this week`,
  `TE upgrade`). A claim that fills none says `none —` and why it is worth the
  spot anyway (a contested handcuff, a dynasty stash); expect few of those.
- A need the wire cannot fill is not dropped from the report: a season need
  goes to **Trades**, a this-week need to **lineup flags** (start the unranked
  bench player Step 2b named, or a Wednesday free agent).
- `Bid` is a dollar RANGE drawn from the columns' FAAB % and the board's own
  `BID` (state which), or `priority claim` in a non-FAAB league. Never one
  number to type in.
- A row the board tags **CONTESTED** (named by nearly every column, still a
  claim) is priced off the board's `the most-bid add each week here went for`
  line, NOT the columns' %. Week 5: the columns said 9-12% for Shipley and he
  went for $55 and $100; the user bid $10 and $16 and lost both. Say plainly
  what it will likely take, and let the user decide if he is worth it.
- `Drop` is a real player. Never an IR/taxi slot (it frees nothing), and
  never a position's only healthy starter, whatever `gaps` suggests.
- `Why` is one line: the job change or injury, plus how strong the signal is
  (columns naming him, adds).

Under the table, a short **Don't** list for things the boards suggest that
would be wrong: a drop candidate who is this week's hot add, a top-VOR row
whose player is out for the season, a "drop" that is your only QB.

**2. Decisions only you can make** — numbered, each one a yes/no question:
an `unavailable.json` assertion expiring, a bid range to choose, a claim that
depends on Wednesday news. Leave it out if there are none.

**3. This week's lineup flags** — only what changes a start because of a
claim or an injury (e.g. "start Shipley over Pollard if Barkley is ruled
out"). Not the full start/sit; that is `/startsit`'s job later in the week.

**4. Trades** — at most three lines per league: the SELL worth acting on and
the one pair that fits a roster need — a Step 2b season need the wire could not
fill comes first, and the pair should spend a `surplus` position on it. Name
the dynasty board's age if it is past three weeks.

Judge "roster need" on the REST-OF-SEASON roster, not this week's. The trade
board's depth line used to count only healthy players, so a starter who was
Out for a week read as a hole; since 2026-10-06 it counts him back in and
says so (`WR 4/4 (1 out wk)`). A bye still never shows there -- check it. On 2026-10-06 that turned
DeVonta Smith (Out, hamstring) and McMillan (bye) into a "WR shortage", and
the report recommended selling Hampton for a WR, leaving Justice League thin
at RB for the season to fix a one-week problem. Count short-term absences
back in; only IR / season-ending absences are real holes. Prefer the pair at
the same position (Hampton -> Tuten) when the SELL is a starter.

**5. Inputs** — last and compact, one line each: LateRound weekly and ROS
(ranked / unmatched, captured), waiver columns (rows matched, sources and
dates, flag any written before the weekend's games), market coverage, and Step 6's
QB line (newest week's passing-yards bias). Anything unmatched is named here, not
buried.

## If something looks wrong

`cli.py doctor` reports whether each FAAB league's transaction history was
ever synced at all (distinct from genuinely having zero bids so far), and
whether the player dump or crosswalk have gone stale. Run it if a waiver board
looks thinner than last week's for no reason you can see.

It also ages the three buzz legs separately — trending is a 24-hour
measurement, the article capture is a Tuesday snapshot — and flags any article
row that matched no player.
