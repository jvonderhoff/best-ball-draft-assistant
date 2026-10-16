# /tuesday eval

`grade.py` grades the waivers report against the board it was built from; its docstring
lists every check and the promises it does not check. `test_grade.py` holds the control.

## The missing seam: `cli.py waivers --json`

`waivers`, `gaps` and `trades` print and write nothing structured, so a real run's input
JSON is rebuilt from the printed boards (see `runs/<date>/build_json.py`). The smallest
fix, mirroring `startsit --json` (`sleeper/cli.py` `_row_json`): `waivers --json PATH`
writes, per league, what `cmd_waivers` already holds in hand:

- `faab_left` (`faab_remaining`), the window's next run (`wsettings`), and the most-bid
  line (`faab.contested_history(...)[-4:]`, wins in order)
- `slots` (`profile.starting_slots`, flex excluded)
- `roster`: every rostered player with pos, `slot` (active / ir / taxi, from
  `waivers.droppable`'s `benched`) and injury status
- `free_agents`: the printed rows (ranked table + "THE FIELD IS ADDING") with status and
  the CONTESTED flag

plus top-level `finished_at`, the unmatched lists from each export's coverage line, and
the dynasty board's age (from `trades`). Not built yet: `sleeper/cli.py` has another
session's uncommitted edits in it.
