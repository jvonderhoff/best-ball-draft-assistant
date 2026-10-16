# /tuesday eval

`grade.py` grades the waivers report against the board it was built from; its docstring
lists every check and the promises it does not check. `test_grade.py` holds the control.

## The input: `cli.py waivers --json`

Built 2026-10-16 (sleeper `89aa144`). `waivers --json PATH` writes, per league, what
`cmd_waivers` already holds: `faab_left`, `waiver_run`, the most-bid line
(`most_bid_wins`), `slots` (flex excluded), the `roster` with active / ir / taxi and
injury status, the `free_agents` shown (ranked table and "THE FIELD IS ADDING") with
their claim and CONTESTED state, and defence `aliases`; plus top-level `finished_at` and
each input's `unmatched` list (None when a file kept none).

**`waiver_run` is measured, not derived.** It is the claims DEADLINE, so it comes from
when the league's past claims were processed (Sleeper's `status_updated`, kept since
this change), over the last 28 days. The settings-derived hour is a late upper bound,
right for "is he free yet" and wrong for a deadline: it said 06:00 for Justice League,
whose claims processed at 02:11. Measuring it also found that Haters Club moved its run
from ~09:06 to 02:16 on Sep 23, which the map still said a month later.

Not in the CLI, because only the task knows: `lateround_recaptured`. Not in `waivers`:
the dynasty board's age (that comes from `trades`). Runs before 2026-10-16 were rebuilt
from the printed boards (`runs/<date>/build_json.py`).
