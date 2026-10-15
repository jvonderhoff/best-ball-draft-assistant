# Decisions behind the umbrella rules

The umbrella `CLAUDE.md` states the rules that hold across all four projects. This
file holds the stories behind them: what was tried, what it cost, and how the rule
was found. Moved out of `CLAUDE.md` on 2026-10-15 so that every session stops
paying to load history it rarely needs. Nothing here is a rule on its own; when
this file and `CLAUDE.md` disagree, `CLAUDE.md` wins.

Read this before proposing a new seam, a deletion, a shared module, or a change to
how players are matched.

## Name matching: how the copies were removed

The rule (`CLAUDE.md`, Identity): `names.py` lives in two places, byte-identical,
and nowhere else.

A *weaker* rule used to exist in `dynasty-rankings/sources/normalize.py`; that
app was deleted 2026-09-08 and the rule went with it rather than spreading.
`dfs/props.py` held a third such rule and was fixed the same way on 2026-09-12 -
by deleting the need for it, not by adding a copy. It still folds punctuation,
which is mechanical and cannot silently disagree; anything that RENAMES a player
belongs where `names.py` lives.
Its replacement is the better answer: the dynasty export joins KTC to
FantasyCalc on `mfl_id` and reads `sleeper_id` off FantasyCalc, so it does no
name matching at all.

## The seam was drawn wrong once, the same day (2026-08-31)

**Corrected the same day, and worth keeping as a lesson.** The first version of
this split redraft and dynasty into separate apps — the wrong seam. Format does
not change how a lineup is picked; start/sit and waiver mechanics are identical
across them. It changes only how a player is VALUED. So they are one app with a
`horizon` (`ros` | `dynasty`) derived from Sleeper's `settings.type`, and the axis
to split on is **platform mechanics vs valuation horizon**, never league format.
The tell was measurable: the only format-specific line in the whole repo was one
filter. When a proposed split leaves the shared modules untouched, it is not a
split.

## Platform AND product, not data

**The axis is platform AND product mechanics, never data.** DK best ball and DK
daily are the same operator and different products — one drafts twenty players
and holds them, the other fills a salary cap weekly — so they are separate. An
application never lives in `projections/`: a lineup optimiser sat in
`projections/tools/` for a day, importing across the seam, and was moved out.

## A scoring rule does not move positional value; the lineup does

**A scoring rule that lifts a whole position lifts its replacement just as fast.**
Measured 2026-08-31: six-point passing TDs raise QB1's season total by 52.6 points
and his value over replacement by 0.7. What moves positional value is how many of
a position must be STARTED — superflex takes QB1 from ~80 VOR to 130. Check the
lineup before the scoring when a league "feels" like it favours a position.

## Two deletions, and what a correct one looks like (2026-09-08)

**`dynasty-rankings/` was removed 2026-09-08**, and this is the shape of a
correct deletion. It was the only thing producing a rest-of-career valuation, so
it was not simply dropped: its two market sources moved to
`projections/pipeline/sources/{ktc,fantasycalc}.py`, behind the crosswalk, and
`tools/export_dynasty_values.py` writes the seam that `sleeper/cli.py dynasty`
reads. What died was the standalone Flask app and its weaker `normalize.py` —
what it *knew* moved to where sources live. Its git history is intact at
`github.com/jvonderhoff/dynasty-rankings`.

The two dynasty sources join on `mfl_id` and FantasyCalc carries `sleeper_id` on
every row, so the whole dynasty export resolves **without one name comparison** —
the strongest version of the identity rule above, and the reason the deletion
improved matters rather than merely tidying.

**`best-ball-extension/` was removed 2026-09-08** — a Chrome overlay for the DK
draft room, dormant since June. It is in git history if it is ever wanted back. Three
things went with it, and the reasons are worth keeping: a `pre-commit` hook that
copied the extension's `recommender.js` over the served one (the two had diverged by
15KB and six commits, so the next commit to the extension would have silently reverted
the live recommender), the `/api/rankings/export` endpoint and its button, and a
`players.js` fallback in `/api/players`. The extension directory was never inside
`render.yaml`'s `rootDir`, so every one of those paths was already dead in production.
