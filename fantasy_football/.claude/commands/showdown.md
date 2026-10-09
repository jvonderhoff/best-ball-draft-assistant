---
description: A showdown night (Thursday, Sunday night, Monday) — build the lineups for the contests being entered, keep the night under the two-per-player cap, and put the builds on the Fantasy HQ DFS tab.
argument-hint: "<contest id> [<contest id> ...]"
---

One game, one question per contest: which captain and five, for THIS ladder.
The ladder sets mean or ceiling, so the only inputs are the contests and how
many lineups each.

**Arguments: `$ARGUMENTS`.** DraftKings contest ids, from the lobby URL. If none
are given, find the game's draft group with `cli.py slates`, list candidates with
`cli.py contests --draftgroup <dg>`, and ask which, rather than guessing.

## Step 1 — build every contest into one ledger and one day file

```bash
cd dfs && .venv/bin/python cli.py showdown --contest <id> -n 2 \
    --ledger data/<date>-<game>.csv --json data/dashboard/showdown-day.json
```

Repeat per contest with the SAME `--ledger` and `--json`. The ledger is what
holds the night to two lineups per player, DST included, across every build
(memory: small-portfolio exposure); the day file is what the dashboard reads.
**Two lineups a contest by default** — the scorecard's decided row: lineups 1-2
cash well above chance, 4+ at chance. A rebuild of the same contest replaces its
entry in the day file but APPENDS to the ledger, so delete that contest's old
rows from the ledger before rebuilding.

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

Monday, once the ownership job has run: `cli.py winners --draftgroup <dg>` reads
how the top of the field won, and whether these builds could have made it.
