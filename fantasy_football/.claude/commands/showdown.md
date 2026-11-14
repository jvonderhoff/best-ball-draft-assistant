---
description: A showdown night (Thursday, Sunday night, Monday) — build the lineups for the contests being entered, keep the night under the two-per-player cap, and put the builds on the Fantasy HQ DFS tab.
argument-hint: "<$1 contest id> [two:<$2-5 contest id>] [<double-up id>]"
---

One game, one question per contest: which captain and five, for THIS ladder.
The ladder sets mean or ceiling, so the only inputs are the contests and how
many lineups each.

**Arguments: `$ARGUMENTS`.** DraftKings contest ids, from the lobby URL.

**The default is five game-script lineups at $1 (Step 1b)** -- the user's call
on 2026-11-09, for upside; scorecard row `sd-five-dollar` is now that rule. A
$1 tournament id, bare or written `scripts:<id>`, gets the five scripts. Build
two ordinary lineups at $2-5 (Step 1) only when the user asks for them by name
(`two:<id>`, or says so); a $2-5 tournament id given bare is a question -- ask
whether tonight is two at $2-5 instead of the scripts, never both. A double-up
is a different ladder and always takes Step 1.

If no ids are given, find the game's draft group with `cli.py slates`, list
candidates with `cli.py --draftgroup <dg> contests` (the flag is global: it goes
BEFORE the subcommand, and after it argparse refuses it), suggest $1 contests
for the scripts, and ask which, rather than guessing. **Lean single entry and
fields of 2k-50k** (Daily Dollar, Singleback, Quarter Jukebox, Dime Package)
over the 100k+ mini-MAX and First Down when there is a choice: on 23 games the
scripts' top-1% rate was ~6% in every size, but per $1 single entry paid +60%
(+10% without its best two games) and 50k+ fields +12% (-14%) (dfs
docs/STATUS.md, 2026-11-09). A lean, not a rule: say which way it points and
let the user pick. Five lineups in one contest and one each in five are the
same bet (the five never shared a top 1%), so a single-entry suggestion is up
to five different contests, and the count follows the budget, not field size.

## Step 1 — ordinary builds: a double-up, or two at $2-5 when asked

```bash
cd dfs && .venv/bin/python cli.py showdown --contest <id> -n 2 \
    --ledger data/<date>-<game>.csv --json data/dashboard/showdown-day.json
```

Repeat per contest with the SAME `--ledger` and `--json`. The ledger is what
holds the night to two lineups per player, DST included, across every build
(memory: small-portfolio exposure); the day file is what the dashboard reads.
**Two lineups a $2-5 tournament when that is the night** — scorecard row
`sd-entries`: lineups 1-2 cash well above chance, 4+ at chance. A rebuild of the same contest replaces its
entry in the day file but APPENDS to the ledger, so delete that contest's old
rows from the ledger before rebuilding.

## Step 1b — game scripts, the default tournament plan

**Five scripts at $1 REPLACE the two at $2-5; never both on one game** (the
user's call, 2026-10-13; the default since 2026-11-09). Five at $1 is $5, the
same money as two at $2-5, so it is not a raise in stakes. Why the default: on
15-18 games with the cheap shade the scripts took top 1% on 5 of 18 nights and
returned +41% at $1, while two at $2-5's lead on ROI was two nights (DEN @ KC,
DAL @ GB; -19% without them), and 10-20 lineups -- more scripts or ordinary
fill -- only diluted it (dfs docs/STATUS.md, 2026-11-09). Row `sd-five-dollar`
flags if the scripts stop out-shooting two at $2-5 at the top. A double-up
beside the scripts is fine -- a different ladder -- and it still takes Step 1
and the ledger.

Script builds record to `data/<date>-<game>-scripts.csv`, apart from the
ordinary `-built.csv`, so a script night's real entries can be told from an
ordinary night's when the season is judged. Say in the summary that tonight
is a script night.

```bash
cd dfs && .venv/bin/python cli.py showdown --contest <id> --scripts \
    --json data/dashboard/showdown-day.json --csv data/<date>-<game>-<id>.csv
```

`--csv` is the upload file; without it the lineups only print. Rebuilding to add
it APPENDS another five to `-scripts.csv`, so delete those rows first
(2026-11-01 PHI @ WAS was rebuilt for exactly that).

Five lineups, each a bet on one game script: 3 heavy on the favourite, 2 on the
underdog, stars repeated on purpose (`showdown.game_scripts`; on 12 games they
took 1.25 top-1% finishes per game against 0.50 for any blend, and they are
tracked as `5x$1 scripts` on the scorecard row `sd-five-dollar`). They go in
$1 tournaments, one lineup per entry. **No `--ledger`**: script lineups are
outside the night's two-per-player cap, which keeps applying to any ordinary
build (a double-up); build that FIRST so the cap is spent on it. A tournament ladder only
-- the command refuses a cash contest. Each lineup prints its script
(`LA script`); say which side each backs and whose captain it took.

## Step 2 — read the output, and say what the script cannot

- **The `props:` age line and the market count.** Under 12 of the pool priced
  by the market means the board is thin; re-export closer to lock.
- **Captain ownership (`cpt~`) beside each captain.** Prefer the lower-owned
  captain when its ceiling is within about 3 points of the chalk one (the
  user's call on 2026-10-08, Pickens over Dak). Say both numbers.
- **`~N copies`** on a tournament lineup: a floor on how many others hold it.
- **The punts line.** A cheap backup whose starter is OUT tonight is the
  `--lock` the rule cannot see; `cli.py winners` shows a punt cut has blocked
  top lineups before.
- **Questionable players**, by name, before lock.
- **To see how tonight's five might play out** (asked for, never needed to
  enter): `cd dfs && .venv/bin/python cli.py sim --draftgroup <dg> --entered
  data/<date>-<game>-<id>-names.csv --json data/dashboard/gamesim.json`, then
  `.venv/bin/python tools/gamesim_page.py data/dashboard/gamesim.json
  data/gamesim.html` and republish data/gamesim.html (Artifact
  https://claude.ai/artifact/JkbAXua78QcNqd9QgLBYJf). It watches lineups and
  never changes one; its top-1% chances ran slightly low on 24 games and its
  script lean is a coin flip, so say both.
- **A player OUT after the lineups were entered: `cli.py swap`, never a
  rebuild.** `cd dfs && .venv/bin/python cli.py swap --draftgroup <dg> --entered
  data/<date>-<game>-<id>-names.csv [--out "<name>"]` keeps each entered lineup
  and refills only the OUT slot (a captain out is replaced from his own side);
  its `OUT x -> IN y` lines are the DK edits. DK's OUT/IR are read by itself;
  `--out` is for news DK has not marked yet. A from-scratch rebuild for Skyler
  Bell (BUF @ MIN, 2026-11-09) also traded away the Bills DST the Cook-captain
  script was built on; the winner was Cook captain with the Bills DST.

## Step 3 — the dashboard

```bash
cd dfs && .venv/bin/python tools/dashboard_showdown.py data/dashboard/showdown-day.json data/dashboard
```

Then refresh the DFS tab of Fantasy HQ (https://claude.ai/artifact/V29D8kzo8Qenzr8U7nnAvq):
read the six dataset documents (`datasets/sd_run`, `sd_builds`, `sd_lineups`,
`sd_slots`, `sd_pool`, `sd_exposure`) for their current `source.url` and
`version`; upload each `data/dashboard/sd_*.json` with the Artifact tool
(`asset: true`, one call per file); one ArtifactData `batch` of six `update`s
pinned with `if_version`, setting `source` to the new `/_blob/` url and name and
`updated` to now; then delete the six old assets. Never touch `files/index.html`
or another tab's datasets. If the exposure table shows anyone over the cap in
the KEPT column, say so first.

The morning after, once the ownership job has run -- 09:00 Monday AND Tuesday,
so a Thursday or Sunday-night game is graded Monday and Monday night's on
Tuesday (a Monday-morning postmortem of MNF finds no field yet and says so):
`cli.py postmortem --draftgroup <dg>` grades the night. It finds our lineups itself (DK's imported entries first,
else this night's record files), places them in the field they were really
entered in -- the DAL @ PHI five were built for the Singleback and uploaded to
the First Down, and only DK's history knew -- and names what sank each one and
which of the winners' levers we held. Read its first two lines before the
rest: a `PROXY` field, or DK's points disagreeing with ours, means the grade
rests on something other than the real contest. `cli.py winners --draftgroup
<dg>` is the field's side of the same night.
