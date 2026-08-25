---
description: Refresh every manual source, republish the payload to prod, and verify what production is actually serving.
---

Refresh the projection sources and get the result into production, then confirm it
landed. The mechanical steps live in `../projections/tools/refresh-sources.sh`; your
job is the parts a script cannot do — reading the output and deciding whether it is
safe to publish.

## Run it

```bash
cd ~/Development/projects/fantasy_football/projections && \
  export DRAFT_APP_URL=https://best-ball-draft-assistant.onrender.com && \
  tools/refresh-sources.sh
```

That fetches DK and Underdog props, fetches FFToday, rebuilds the crosswalk, runs
`doctor`, then builds the payload and stops at a **dry run**. Nothing is sent.

It must be run from an interactive shell. `BBA_API_KEY` lives in `~/.zshrc`, so it is
absent from `zsh -lc` and from most non-interactive contexts; the script checks and
refuses rather than letting the publish 401 halfway through.

## Before publishing, read three things

1. **`would POST to` names the Render host**, not localhost. `DRAFT_APP_URL` controls
   both what the build reads and where the publish goes, so getting it wrong sends a
   payload built against the wrong pool to the wrong place, and reports success.
2. **`sd_invariant_ok: true`** and `null_fields` showing zeros for `ppg`, `sd`,
   `sources` and `avail`. `rec_share` nulls are normal (Sleeper has no components for
   some players); the rest are not.
3. **The player count is in the expected range** — 420-445 for a 2026 pool. A sharp
   drop means a source failed in a way that did not raise.

`doctor` warning that FFToday matches 100% by NAME is expected and long-standing, not
a new problem.

Then publish:

```bash
tools/refresh-sources.sh --publish
```

## Afterwards, verify — do not assume

```bash
cd ~/Development/projects/fantasy_football/best-ball-draft && python3 tools/preflight.py
```

Expect `PASS — 0 failing`. Interpreting what you get:

- **`seed comparison` WARN at ~100%** right after a deploy is correct: the filesystem
  is ephemeral, so the players table reseeds from the committed cache and clears on
  the next `/api/players` call once the 6h TTL trips.
- **`DK pool / ADP` FAIL** — note that preflight's own `/api/players` call triggers the
  refresh, so re-run after ~30s. If it persists, the DK fetch itself is failing.
- **A stale source** is now labelled by role. `identity` and `display` at 30 days are
  unremarkable; a stale `projection` or `market` source is the real thing.

Also confirm `/api/freshness` shows `pushed by projections-app @ <sha>`. If it says
`version unknown`, something published from code that predates the version stamp —
almost always a long-running `analysis-serve`.

## Two traps worth restating

**`analysis-serve` does not reload code.** It runs with `use_reloader=False`, so a
server left running across a change keeps publishing the version it started with,
indefinitely, and looks entirely normal doing it. Restart it after any edit, and
prefer publishing from this script over the page's button.

**Props cannot be fetched from Render.** DK blocks datacenter IPs. That is the whole
reason this pipeline is local, so a props failure here cannot be worked around by
deploying something.

## What this does not refresh

- **Sleeper** — refetched live by every build, so it is always current.
- **ESPN** — a button on the Analysis page, and it moves rarely. Check its age in
  `/api/freshness`; a week is worth a manual refresh.
- **The DK pool and your rankings board** — the pool refreshes itself on a 6h TTL, and
  the board is your opinion and changes when you change it.
