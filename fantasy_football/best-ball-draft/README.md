# Best Ball Draft Assistant

DraftKings best ball: draft twenty players and never touch them again. This app answers
*who do I take next?* — a live pick recommender (V1 and V2 side by side), your own
rankings board, draft history, and in-season standings for every entry.

Flask + vanilla JS + Postgres, deployed on Render from `master`.

**Read `CLAUDE.md` first** (operations, and the traps that have already cost time), then
**`docs/STATUS.md`** (what is live, what is open). For how this app fits with the other
fantasy projects, open `../docs/architecture.html`.

> Rewritten 2026-09-14. The previous README was a 2024 template describing a solo draft
> simulator, a `players.py` data file and Python 3.7 — none of it how the app works now.

## Run it

```bash
./run.sh                          # http://localhost:8000
```

Flask runs with `--no-reload`: **restart after editing a template**, or you will test
the old page. Production is `https://best-ball-draft-assistant.onrender.com` and
auto-deploys on every push to `master` — so pushing is a production change; ask first.

## Pages

| page | what it is for |
|---|---|
| `/recommend` | live pick advice. V1 is the primary column, V2 sits beside it. A stale-data bar appears only when something is stale. |
| `/rankings` | your board. The ★ in the header is **per browser and off by default**. |
| `/history` | past drafts and player exposure |
| `/season` | every entry's pod standing, on one phone-readable page. All scores are DraftKings'. |
| `/news` | the feed captured on the Mac; "Price moved" is the view worth reading |
| `/setup` | DraftKings sign-in, and the data freshness panel |
| `/sandbox` | replay and test drafts |

`/analysis` returns 410: the Analysis page moved to `../projections` on 2026-08-16.

## Where the data comes from

| data | how it gets here |
|---|---|
| DK player pool + ADP | fetched by this app, 6h TTL, refreshed in a background thread |
| FantasyPros ECR | enriches the pool, here |
| your rankings board | you, at `/rankings` |
| the six-field V2 payload | pushed from `../projections` (`cli.py analysis-publish --no-dry-run`) |
| news bundle | pushed from the Mac every 3h (`com.bba.newspush`) |
| weekly standings | captured on the Mac from DK, pushed Tuesdays (`tools/capture-standings.sh`) |

**Render's filesystem is wiped on every deploy and every idle spin-down.** Anything that
must survive lives in Postgres (`DATABASE_URL`): the `*_store.py` modules in `app/`.
`app/data/player_cache.json` is committed on purpose — it seeds a cold database.

## The recommender

- **V1** — `static/recommender.js`. ADP and roster fit.
- **V2** — `static/recommender-v2.js`. Points: `ppg`, `sd`, `ceiling = ppg + 1.28·sd`,
  plus a survival model calibrated on real DK boards.
  **`docs/V2_DESIGN.md` holds every constant's evidence and, in §4, the dead ends.**

Before shipping any change to a scoring constant, run `node tools/check-model-change.js`
— it lists exactly who moved, in both models, on real boards. The hook in
`.claude/settings.json` runs it on every edit to a scoring file.

## Layout

```
app/
  app.py              every page and API route
  *_store.py          Postgres copies: rankings, drafts, projections, news, season, kv
  projections.py      V2's inputs: the pushed payload, or the local fallback
  analysis.py         FROZEN fallback — edit ../projections instead
  season.py news.py   /season and /news
  dk_import.py        pull finished drafts from DK
  data/names.py       name matching; byte-identical twin of ../projections' copy
static/               recommender.js, recommender-v2.js, dk-auth.js, theme.js
templates/            one template per page above
tools/                preflight, harness, calibration, auto-queue, standings — see below
docs/                 STATUS, V2_DESIGN, PROJECTIONS_SPLIT, guide.html
render.yaml           the Render service
```

## Checks and tools

| question | command |
|---|---|
| is production serving real, current data? | `python3 tools/preflight.py` — before a draft, after a deploy |
| how old is anything? | `GET /api/freshness`, surfaced on `/setup` |
| is persistence working? | `GET /api/stores/status` — read `rankings_hydrated`, not just counts |
| is V2 on the published payload? | `GET /api/projections-v2` — `source: pushed`, never `local` |
| refresh the committed pool seed | `python3 tools/refresh-seed.py` |
| V1 vs V2 through simulated drafts | `node tools/compare-models.js` — read deltas, never levels |
| grow the real-draft set, re-score survival | `tools/import-new-drafts.sh` |

There is no test suite for the app, deliberately: the harness verifies the model and the
browser verifies the UI. `CLAUDE.md` explains the two exceptions.
