# Playoff best ball: draft week

What to run, in order, to draft DraftKings playoff best ball with `/playoff`. Why it
works the way it does is `PLAYOFF_DESIGN.md`. What has been measured is `STATUS.md`
(2026-11-17 entries).

## The calendar (2026 season)

**DK's playoff drafts are open now, mid-November** (the user, 2026-11-17), not only
after week 18 as this runbook first assumed. They are fast drafts: 30 seconds a pick.

| when | what happens | what you do |
|---|---|---|
| **now to Jan 10** | drafts open; the field is not set | §2a every Tuesday (results + next week's lines), and after a big injury; §3, §4 |
| **Sun Jan 10** | week 18 is played (all 16 games that day); seeds become final that night | §2 that night or Monday morning |
| Jan 10-11 | wild-card lines post | §2 again |
| Jan 11-16 | drafts with the field set | §4 for each draft; repeat §2 when lines or injuries move (§6) |
| ~Jan 16-18 | wild-card weekend; drafts close at the first kickoff | nothing |

Dates are from the 2026 schedule in `projections/data/nflverse/games.csv`. The
wild-card dates are not in the file yet; check the lobby for the draft deadline.

**Mid-season the bracket file is a simulation of the rest of the season**
(`mode: season_sim`, projections `pipeline/season_sim.py`): 2,000 finishes, each with
its own seeds, byes and rating drift, every one of the 32 teams' players exported, and
`avail` = the measured chance a player is still playing by January (87% for players
playing now, 49% for players out now). `cli.py playoff-bracket` switches to it on its
own while any regular-season game is unplayed, and back to the real bracket once
none is. Evidence: `PLAYOFF_DESIGN.md` §8.

## 1. Once, before draft week: deploy

The `/playoff` page exists only locally until it is pushed.

- Push `master`, which deploys to Render.
- Check that the new build is live: `curl -s https://<host>/playoff | grep -q "Playoff Draft"`.
  A 200 alone proves nothing (CLAUDE.md, *A 200 does not mean your deploy landed*).
- Optionally publish the provisional inputs (§2 steps 1-3) to see the page on your
  phone. They are marked PROVISIONAL everywhere and preflight FAILs on them.

## 2a. Mid-season (every Tuesday until Jan 10)

The same four commands as §2 below, with two differences in what to read:

- `playoff-bracket` prints `SEASON SIM: N regular-season games left`. That is
  correct now; there is no PROVISIONAL line to clear. Read the `make` and `bye`
  columns: they are the point.
- The export prints `SEASON SIM: all 32 teams exported`. Still no WARNING line for
  "not exactly one starting QB".
- Preflight's seeds line says `simulated`. Push age WARNs past 3 days and FAILs past 8:
  a week of results the page does not know about.

Tuesday, because Monday night's game is then in the file and next week's lines are
posted. `--refresh` on both commands fetches them.

## 2. When seeds are final (Sunday Jan 10 night, or Monday)

From `fantasy_football/projections`:

```bash
.venv/bin/python cli.py --season 2026 playoff-bracket --refresh
```

- **The PROVISIONAL line must be gone.** If it is still there, nflverse has not
  posted the final results yet. Wait, or pass the real bracket by hand:
  `--seeds "AFC=T1,T2,...,T7;NFC=T1,...,T7"`, seed order, team codes as in `games.csv`.
- **Compare the seeds with the NFL's announced bracket.** One wrong seed simulates a
  bracket that will not happen.
- `--season 2026` is required: the CLI default is 2025, a finished season.

```bash
.venv/bin/python tools/export_playoff_players.py --season 2026 --refresh
```

- **No WARNING line**, in particular none for "not exactly one starting QB". A
  starting QB listed as a backup scores nothing for the whole postseason.
- **Injury file age is 0-24h.** `--refresh` refetches Sleeper's file only when it is
  over 24h old, Sleeper's own limit. For Friday injury reports, run it after Friday.
- Re-run this after every bracket rebuild. Publishing refuses a pair that does not match.

```bash
.venv/bin/python cli.py playoff-publish --target https://<host>
DRAFT_APP_URL=https://<host> zsh -ic '.venv/bin/python cli.py playoff-publish --no-dry-run'
```

- The first command is a dry run. The second needs `BBA_API_KEY`, which exists only
  in `zsh -ic`.
- A `durable: false` in the answer means Postgres did not take it, and the next cold
  start loses it. Publish again.

From `fantasy_football/best-ball-draft`:

```bash
python3 tools/preflight.py --playoff
```

- The four playoff lines should be OK: seeds final, push age, `postgres` as the
  source, injury age.

## 3. When the lobby opens

- **Read the contest rules in the lobby**: rounds, lineup, final size and the prize
  ladder. The two presets on the page come from write-ups that disagree with each other.
  - If one matches, pick it and type the prizes into *Payouts* (`1:100000, 2:31000,
    3-5:5000`). The page then ranks by EV.
  - If neither matches, add a preset to `PRESETS` in `static/recommender-playoff.js`:
    `rounds`, `lineup`, `finalSize`, `payouts`. Push, then run
    `node tools/playoff-rec-check.js --preset <new> --drafts 0` before drafting on it.
- **Load DK's pool and ADP.** Type the draft group id into *Draft group* and press
  *Load DK pool*.
  - The id is the number at the end of DK's rankings page URL for the playoff contest
    (`draftkings.com/draft/rankings/NFL/<id>`).
  - Or start following a draft (§4) and the page fills it in.
  - The bar should say `ADP DK draft group <id>`. If it says `DK players not in the
    export`, read who:
    - A real player missing is a name the matcher could not join. Fix it in
      `app/data/names.py`, never on one side only (CLAUDE.md, *Don't fix a mismatch
      by special-casing one side*).
    - Kickers and defences are expected: the simulator has no model for them.
- **A 502 on the pool**: DK refuses this server's own requests (Akamai 403, since
  2026-09-22; STATUS 2026-11-18). Click the BBA bookmark on a DK draft tab instead: it
  sends the pool with the board and the page loads it by itself.

## 4. Each draft

1. **Once:** drag the *BBA → DK* link on `/playoff` to your bookmarks bar.
   - DK refuses this server's own requests (STATUS 2026-11-18), so the page cannot read
     the draft by itself. The bookmark reads it in your browser, signed in on DK.
2. **Each draft:** on the DK draft tab, click the bookmark. A badge, bottom right of the
   DK page, says `sending: N of M picks, seat S, ADP sent`. Red means it is not sending
   and says why.
   - **Test it on the first draft before the clock matters.** Not yet verified on DK
     itself: whether DK's page lets it post here, and whether `/mycontests` lists a
     draft that has not started ("looking for your entry" that never clears).
   - Keep the DK tab in its own window, visible. A background tab's timers are slowed,
     and the bar's "DK read N s ago" then goes red.
3. On `/playoff`, leave the draft id empty and press *Follow live draft*: it follows the
   draft the bookmark is sending. Your seat comes from DK; check it against the board.
4. The first load builds the field: about 10 seconds, once per draft. After that,
   each recommendation takes about 2.5 seconds on a Mac (574 players mid-season;
   untested on a phone) against DK's 30-second clock. Picks refresh every 3 seconds
   when your pick is on the clock or at most two away, every 6 seconds otherwise; the
   bar says `DK read N s ago`, so a stalled feed shows. The draft id is not remembered
   across a reload: press *Follow live draft* again.
5. Read the bar before trusting a row:
   - **seeds** must be final
   - **ADP** must be DK, not SYNTHETIC
   - **picks not matched** must be empty. An unmatched pick is a player gone from the
     room that the page still thinks is available.
6. **The page opens in the simple view** (since 2026-11-24): the picks, your roster and
   Available, with only the columns a pick needs. **Details ▾** (next to Format) shows the
   rest: payouts, the draft group and *Load DK pool*, Avoid teams, the bookmark link, My
   entries, the Teams table and the In / G / Rd 1 / Rd 2 / EV columns. The browser
   remembers which view you left open. On a phone, My roster comes right after the picks.
7. How to read a row (simple view):
   - The **top row is the pick**. **≈** marks rows within 25% of the top's value: the
     simulator cannot tell them apart (PLAYOFF_DESIGN §10), so any of them is a fair
     pick. **◆ vary** marks the tied row your finished entries use least; take it to
     keep entries from looking alike.
   - **Team chips** are coloured by conference (AFC red, NFC blue), and filled, with a
     count, for teams already on your roster. A stack, or a second team in one
     conference, shows in every list.
   - **The table settles.** It shows after 3 simulated drafts and keeps adding one at a
     time to 24 (*Settling: 9 of 24…* above the table, then *Settled on 24*), about 13 s
     at pick 1 on the Mac, longer on a phone. At 3 the top rows' order is mostly noise:
     on an empty board the 3-draft #1 (Parker Washington) was 11th at 48. On a live
     clock you may pick before it settles; the ≈ rows are fair either way.
   - **Wk1** is his chance to play wild-card week (his team makes the playoffs without a
     bye, and he is playing). **Bye** (under Details) is his team's chance of a round-1 bye.
   - **Next** is his chance to still be there at your next pick if you pass on him now
     (ADP bots make the picks in between). Low means take him now or lose him; at the
     turn (12 then 13) everyone shows 100%. It is only as good as the ADP: on SYNTHETIC
     ADP it is a room drafting by expected points.
   - **Final** is P(reach the final). It is thin: on past postseasons the edge to the
     final came mostly from one or two seasons. Under Details, **Rd 1** (win your
     round-1 pod) is the number with real evidence behind it: about 24% for the
     recommender vs 15% for ADP drafters, across ten past postseasons.
   - Pick the contest under **Format** first (Millionaire, Fair Catch, Play-Action,
     Nickel). They differ only in final size, which matters for 1st-place odds and EV,
     not for the ranking by P(final). DK's playoff format is 12 players (PLAYOFF_DESIGN §1).
   - The recommender never offers a pick that would leave your roster short of 1 QB,
     1 RB, 2 WR and 1 TE with the picks left, or over 3 QB / 3 TE. DK voids such a
     roster: zero points all postseason.
8. **My roster** is split AFC | NFC, then by team, each with its playoff and bye odds.
   A *same conference* line names two of your teams that must meet before the Super
   Bowl, with the chance they do; only one of them can reach the final.
9. **Week 1 lineup** (under My roster) has one chip per lineup slot (QB RB WR WR TE
   FLEX): green when a roster player who plays wild-card week fills it in 90%+ of
   simulated postseasons, orange below that, red when it is empty in 30%+. Bye teams
   score zero that week, so a bye-heavy roster shows red here. When the red slots come
   close to the picks you have left, an orange **Week 1** warning appears above the
   picks and rows that would fill a red slot get a **wk1** mark. It warns, it does not
   re-rank: forcing wild-card coverage as a rule measured far worse on past postseasons
   (P(final) 0.37x ADP vs 4.4x without it, STATUS 2026-11-19), because the recommender
   already counts a bye team's round-1 zero in every simulated postseason. Expect the
   top row to be a bye-team player sometimes even with the warning up; the warning is
   for your judgement.
10. **Build around** (below the seat row): the teams to stack in THIS entry, typed or
   clicked from the chips beside it. The chips are teams with 40%+ playoff odds, the ones
   your finished entries use least first (with how many entries use each), so a portfolio
   spreads across stacks. Each team's best 3 available players are scored however deep
   they sit, in a **Build around** table under the picks: **vs top** is his value as a
   share of the top pick's (100% costs nothing; under 60% is orange), and **Next** says
   whether waiting loses him. Reach when Next is low and you want the stack; wait when
   it is high. It changes what is shown, never the ranking (a forced roster rule cost
   P(final) when measured). Kept per browser tab, like Avoid teams.
11. **Keeping entries apart** (under Details): **My entries** counts teams and players
   across your finished live drafts in this browser. Click a team there, or type it in
   **Avoid teams**, to build this entry around a different core. The recommender gives
   the same answer from the same seat on the same data, so without this your entries
   converge.

## 5. Practising before the lobby

Without a DK draft id the page is a mock board:
- *Bots to my turn* fills the other seats by ADP.
- Clicking a recommendation or an available player drafts him for the seat on the clock.
- *Reset board* starts over.

The page loads the newest DK pool a bookmark run has saved, so after your first real
draft the mock bots draft like the real room (the ADP line in the bar says `saved` and
the day). Before any bookmark run the ADP is synthetic (expected postseason points):
bots then ignore byes in round 1, which makes the recommender look better than it will
against real drafters.

To check the saved ADP on the Mac and run the recommender check against it:

```bash
node tools/playoff-adp.js --list
node tools/playoff-adp.js                  # newest: saves tools/.playoff-adp/<dg>-<day>.json, compares to synthetic
node tools/playoff-rec-check.js --adp tools/.playoff-adp/<dg>-<day>.json --drafts 30
```

## 6. During draft week: when to refresh

Re-run §2 (bracket, export, publish, preflight) before drafting again when:

- **The wild-card moneylines are posted.** The bracket takes them as fixed game
  odds; the build line says how many games are priced.
- **An injury report changes a starter**, especially a QB. Friday's reports matter
  most. The export only knows what Sleeper's file said when it was fetched.
- **More than 24 hours have passed.** Preflight WARNs past 12h and FAILs past 48h.

After publishing, **reload `/playoff`**: the page simulates once per load.

## 7. After the drafts

- **Keep every draft id** (the page does not store them). With real DK ADP and real
  outcomes, they are the first evidence about real drafters, and the backtest
  (`tools/playoff-backtest.sh`) can only use synthetic ADP until then.
- **Write what happened into `STATUS.md`**: pod results by round, and which
  recommendations you took or overrode.

## When something looks wrong

| symptom | likely cause | check |
|---|---|---|
| "No playoff inputs" | nothing published to this server | §2 publish, `--target` correct |
| Pushed age keeps growing | publishing stopped | `/api/playoff/data` → `age_hours`, `source` |
| `source: disk` | Postgres was unreachable at the push | publish again; `/api/stores/status` |
| A starter ranked absurdly low | flagged backup QB or season-over | export's WARNING line; his `role`, `injury_status` |
| A backup ranked high | depth chart stale | injury file age; re-export after Sleeper updates |
| Players on two teams all show a low Rd 1 | those teams have byes | expected: the 1-seeds do not play the wild card ("bye" tag) |
| A star ranked low mid-season | his team's P(make) is low, or he is "out now" | the team tag's % and `out now 49%` on his row |
| `no picks yet: click the BBA bookmark` | the bookmark is not running on the DK tab | click it there; its badge says what it sees |
| badge: `could not reach BBA` | DK's page blocks posting to another host | not seen yet; tell Claude, a relay window is the fallback |
| badge: `looking for your entry` that never clears | `/mycontests` does not list the draft yet | reload the DK tab and click again once the draft starts |
| `DK read N s ago` in red | the DK tab is hidden, closed or erroring | bring the DK window forward; read its badge |
| Recommendations identical after news | page not reloaded, or §2 not re-run | push age; reload |
