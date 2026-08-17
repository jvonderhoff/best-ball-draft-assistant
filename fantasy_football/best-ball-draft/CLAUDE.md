# CLAUDE.md

DraftKings Best Ball draft assistant. Flask + vanilla JS + Postgres, deployed on Render.

`docs/PROJECTIONS_SPLIT.md` is a design note, not a plan of record: moving analysis and
projections into their own app to keep this one lite. Read it before adding anything new
to `app/analysis.py` — the contract it documents (V2 consumes six fields; V1 consumes
`adp` alone) is worth knowing whether or not the split ever happens.

**Read `docs/V2_DESIGN.md` before changing the recommender.** It documents the model, the
evidence behind every constant, and — most importantly — §4, the dead ends. This file
covers only the operational things that live nowhere else.

## Running it

```bash
./run.sh                      # port 8000, --no-reload
```

**Flask runs with `--no-reload`. Restart the server after editing a template**, or you
will test the old page and believe your change did nothing. The browser caches it too —
if a restart isn't enough, load with a cache-busting query string.

`asset()` cache-busts static files by mtime. Never hand-maintain `?v=N`; doing so once
had browsers running scoring code from before several fixes, silently.

No test suite. Verification is by running the thing: the harness for model changes, the
app in a browser for UI changes.

**Doing both in one session silently invalidates the harness numbers.** `loadData()`
reads `app/data/player_cache.json` off disk, and the *app* rewrites it — `GET
/api/players` trips a 6h TTL and refreshes the DK pool in a background thread. So the
browser check you run to verify a UI change can re-baseline the simulator underneath
results you already have. Measured 2026-08-16: a rerun at an identical seed on identical
code moved V1's EV $76.17 → $68.09, because the pool had gone 420 → 427 players between
them. **The player count on line 1 of the harness output is the only tell** — record it
with any number you plan to compare later, and run every arm of a comparison inside one
script so a refresh cannot land mid-experiment. Full note in §5.4b.

## Deployment

Render, auto-deploys from `master`, usually live in 45–120s.

**The filesystem is ephemeral.** SQLite is wiped on every deploy and on idle spin-down.
Anything that must survive lives in Postgres (`DATABASE_URL`): `rankings_store`,
`drafts_store`, `projections_store`, `kv_store_external`.

**`/api/stores/status` is the only endpoint that reads Postgres directly.** Every other
endpoint reports the local SQLite, so a warm instance looks healthy whether persistence
is working or not. Check it after any deploy that touches storage.

**A 200 does not mean your deploy landed.** The old instance keeps serving the whole
time the new one builds, and it answers every health check perfectly — because it *is*
healthy, it is just the previous code. Polling `until curl … 200` therefore returns
instantly and proves nothing, which is a way to "verify" a deploy that has not started.
Poll for something only the NEW build serves: a string added to a template
(`curl -s $HOST/analysis | grep -q col-groups`), or a field only the new code emits.
Same lesson as `rankings_hydrated` — check that the thing happened, do not infer it
from a signal that looks the same either way.

**Read `rankings_hydrated` there, not just the counts.** Counts were not enough and that
is exactly how a two-month-old board went unnoticed: a boot that fails to reach Postgres
leaves `rankings_seed.json` — a *committed* bootstrap file — serving as the live board,
at `V2_CUSTOM_RANK_WEIGHT` 0.55 of every valuation. By the time anyone calls the status
endpoint the database has woken up and reports a healthy count, so both columns look
fine. `rankings_hydrated: false` means the live board is the seed file; saving rankings
is then blocked (409), because the frontend posts the whole board and unranked players
go up as deletes — one Save from an unhydrated cache would have destroyed 69 real
rankings. A `rankings_warning` also appears whenever local and durable drift apart
after a good boot.

**`projections_hydrated` is the same check for V2's inputs**, per dataset
(`{"espn": …, "props": …}`), with `projections_warning` listing anything wrong. `false`
means the local table is whatever survived the filesystem wipe — on Render, nothing — so
V2 silently runs on Sleeper alone: 356 players drop from two projection sources to one
and the ECR blend doubles from 0.15 to 0.30. Every score shifts, nothing errors. There is
no seed file behind these tables, so the tell is a local count of 0, which reads
identically to "not fetched yet"; that ambiguity is why the flag is also on
`/api/projections/meta`, the endpoint you actually hit when the numbers look off. Unlike
rankings it does **not** block writes — `save_espn`/`save_props` are pure upserts with no
delete path, and pushing props is the obvious recovery from a failed hydrate.

**The lesson generalises past rankings.** Three bugs this session were silent in the same
way: plausible numbers, no errors, nothing logged. Prefer failing loudly and recording
whether a thing actually happened over inferring it from a count that looks right.

**The stores' `_conn()` must never raise, and this is load-bearing.** Every `load_*`
documents "None when unreachable", but until 2026-08-14 `psycopg2.connect` sat outside
the try, so that contract held only for the cheap cases (no `DATABASE_URL`, no psycopg2)
— a real outage *raised*. Two safety nets were dead as a result, both measured rather
than argued: the 4-attempt retry in `_hydrate_external_rankings` ran **0 of 4** loads
against an unreachable store (`init_external` raised first and unwound past the loop),
and that retry exists precisely for the Neon cold start after a deploy, where connect
times out; and `/api/stores/status` **500'd** instead of reporting `UNREACHABLE`, so the
one instrument for "did persistence work" broke exactly when persistence was broken.

`app/data/player_cache.json` is committed **on purpose** — `_seed_players_if_empty` needs
it to populate a cold database. It looks like a build artifact. It isn't. Don't gitignore
it.

## Data pipeline

| Source | Refresh |
|---|---|
| DK player pool / ADP | automatic, 6h TTL, background thread on `GET /api/players` |
| Sleeper + ESPN + FantasyPros ECR | automatic, 6h TTL, rebuilt on request |
| DK / Underdog props | **manual** — `python3 tools/push-props.py` |
| Custom rankings board | manual, and correctly so — it's the user's opinion |

**The board is OFF by default and the flag is per-browser.** `useCustomRankings` reads
`localStorage['bba_use_custom_ranks'] === 'true'`, so a new browser, a cleared profile,
incognito, or simply the other device all default to market ADP — and the rankings are
not even fetched until it is on (`customRankMap` is empty, not merely unused). The only
indicator is the header button: **★ filled blue = on, ☆ hollow grey = off.** Check it
before concluding anything about why a player is or is not being recommended; on
2026-08-15 an entire analysis was written against the wrong mode because the flag was
read from an automated browser rather than the user's.

When it *is* on, `applyCustomRanks` **substitutes** the rank into `adp` and moves the
market value to `realAdp`. That is a bigger behavioural change than the 0.55 blend
weight suggests, because everything downstream reading `adp` is then reading the user's
opinion. Anything asking "will he last?" or "did the room let him slide?" must read
`realAdp` — V1 got this wrong in the value-steal term until 2026-08-16 and charged one
opinion twice (rank 164 → 120 doubled a player's score, 8.3 → 16.7).

**`/api/dk-draft-state/<id>` returns HTTP 200 with zero picks when its cache is cold.**
It is fed by the BBA Live bookmarklet and expires; the payload then carries
`needs_bookmarklet` and an `error` string. Check `picks.length` before trusting it —
scoring an empty board silently produces a confident, completely wrong answer rather
than an error.

**DK blocks Render's datacenter IPs for props only.** The player pool fetches fine from
prod (verified). Props must be pushed from a residential connection.

`/api/projections/refresh` calls the FantasyPros *season* scraper, which is dead —
paywalled to a 10-per-position teaser. It is not the path that feeds the model.

Name matching lives in `app/data/names.py`. DK says "Nick Singleton" where every
projection source says "Nicholas". Unmatched players fall through to an ADP-implied
estimate and get scored as generic bodies — check this first when a player's valuation
looks absurd.

**Don't fix a mismatch by special-casing one side.** `normalize_name` runs on *both*
sides of every lookup, and that symmetry is load-bearing rather than tidy. The
2026-08-12 pool refresh had DK change "Kenneth Gainwell" to "Kenny Gainwell" — the
exact spelling the alias was written to translate *away* from, on a round-8 back —
and nothing broke, because both spellings normalise to the same key either way. The
same refresh brought "A.J. Dillon" → "AJ Dillon" and "Ted Hurst" → "Ted Hurst III",
also absorbed. A one-directional fix would have silently un-matched all three.

## The harness

`tools/compare-models.js` — V1 vs V2 through complete simulated drafts and seasons.

- **Always read `--truth market`.** `proj` grades V2 against its own answer key.
- **Absolute numbers are meaningless.** Opponents are ADP bots and so is the 1,089-team
  final field, so EV levels are wildly inflated. Read model-vs-model deltas only. Never
  quote an EV figure as a real-world result.
- `tools/rb-depth.js --pos {QB|RB|WR|TE}` — paired counterfactuals for roster counts.
  Paired on seed *and* weather, which is what makes it able to resolve effects the
  construction table cannot.
- `tools/sitngo-ev.js` — the winner-take-all Sit & Go contests, a different game.

**The noise floor is ±$2 on a paired difference. Replicate anything smaller with
`--seed` before believing it.** Absolute EV swings 3.5x on the seed alone ($49 / $27 /
$14 for the same comparison), which is why the rule above says never to quote a level.
Paired differences are far tighter, but not infinitely so — see §5 of the design doc.
Two results this session survived only because they were re-run at a second seed, and
one confident write-up had to be retracted.

**Real opponent rosters (the §9.2 field) live only on this machine.** Deliberately:
Render has no use for opponent seats and DK blocks its IPs anyway. The chain is

```bash
xargs python3 import_dk_history.py --include-opponents --ids < ids.txt
python3 tools/export-real-rosters.py     # -> tools/.field-cache/ (gitignored)
```

where `ids.txt` is one DK draft id per line, from `.saved_drafts.json`. Both the
database and the export are gitignored and regenerable, so losing them costs a re-run
and nothing else. `compare-models.js` picks the export up automatically;
`--no-real-field` reproduces a bots-only run. Re-run as slow drafts finish — only
*completed* boards import, and this needs to be in the low hundreds before it can
measure anything (21 today, ~2% of the candidate pool).

**`--include-opponents` is off by default and must stay that way for normal imports.**
Exposure, the History page and the extension export all mean "my roster" by "picks".
A full board is kept apart from your own picks by the `mine` column, which every one
of those paths filters on.

## Working agreements

**V1 stays the primary column in `/recommend`; V2 shows alongside.** Do not swap the
default. §9 records why: three real V2 errors were caught by eye in its first day
(stale FA team, name mismatch, inflated stack), and the side-by-side is what catches
them. V2 is the model under development, not yet the model in charge.

**Commit freely; ask before pushing.** Local commits need no permission. Pushing to
`master` auto-deploys to production, so that needs a yes — including when a change
feels routine.

**`git push` hangs from an agent session unless the keychain helper is bypassed.**
`credential.helper` is `osxkeychain`, which wants a GUI prompt that never appears in a
sandboxed process, so the push sits there until it is killed — no error, no output.
Reads are unaffected (`git ls-remote` returns instantly), which makes it look like a
network problem rather than an auth one. Use `gh`'s helper instead:

```bash
GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin master
```

**The empty `-c credential.helper=` is the part that matters.** `-c` APPENDS to the
helper list rather than replacing it, so passing only the `gh` helper leaves osxkeychain
ahead of it in the chain and the push hangs exactly as before. Clearing the list first is
what makes the override take. Diagnose with `GIT_TRACE=1`: the tell is a `401` from
GitHub followed by `run_command: git credential-osxkeychain get` and then silence.

**Tune advice for large-field tournaments and mid-size single-entry contests.** The
Millionaire and Play-Action (~1,089 and ~458-team finals) are where V2's build is worth
the most. Bubble Screen and Huddle (18–41 team finals) are the lowest-rake, structurally
softest field, because single entry means nobody is running twenty correlated rosters
against you — **and as of 2026-08-16 that is where the user actually plays.**
Sit & Gos and satellite qualifiers are not the target; don't optimise for them.

**"V2 only matters in big fields" was wrong — do not repeat it.** This file used to say
V2 beat V1 by "+4–9% at small ones", from a §5.2 table that had gone stale by most of §2
and §3 of V2's development. Re-measured 2026-08-16 at five seeds on one pool: **+42.7%
mean at an 18-team final, +48.8% at 45, positive at 5/5 seeds.** The edge does still grow
with field size, but V2 is strongly ahead at every size, and the old number was steering
the user away from the model that helps them most. Corrected in §5.2; read the columns
there by event count, not by size.

**Yahoo is still wanted.** Blocked on app registration at developer.yahoo.com needing
Fantasy Sports read permission — the error is app-level, not code. Scope, token
persistence and Python 3.9 compatibility are all done. Keep it in §9.

## How this codebase decides things

This matters more than any individual convention.

**Constants are swept before they ship, not reasoned into place.** Every value in §2 of
the design doc carries its evidence. Where a constant is judgement rather than
measurement, it says so.

**§4 exists so failed ideas are not retried.** Three separate mechanisms for forcing
roster shape have now measured worse. The instinct to "improve" the model by adding a
heuristic is usually wrong here, and there is a written record of why.

**Features whose benefit the harness cannot measure ship off or flagged.** Portfolio
diversification and supply-exhaustion urgency are both plumbed behind env vars because
the simulator has no way to price them. Prefer that over shipping on theory.

**When a measurement contradicts intuition, the doc records the contradiction** rather
than the flattering reading. Several entries exist specifically to correct earlier
conclusions that turned out to be noise.

Comments explain *why*, at length, especially for anything non-obvious or previously
wrong. Match that density — this codebase is written to be picked up cold.
