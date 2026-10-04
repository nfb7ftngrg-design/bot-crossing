# The Reef

A second world over the same threads. Open `/reef.html` beside the colony (or instead of it):
every thread is a fish, every repo is a shelf of reef, and what a thread is doing decides what its
fish is doing. Nothing about the reader, the state function or the saved layout is new — the reef
is a different costume over the same frame, and a repo keeps the same hexes in both worlds.

## The concept

1. **What lives here?** One reef fish per thread, two-tone and patterned from its thread id.
2. **The setting.** The floor of a sunlit lagoon: rippled sand, rock shelves, kelp, caustics
   dancing across everything. Night is deep blue, and the reef lights itself — coral tips, eyes
   and drifting plankton bioluminesce.
3. **A project's home.** A raised shelf of reef rock on the project's hex cells, rimmed in the
   project's colour. The colony's ship cell is a sunken wreck: fish arrive out of it and archived
   fish swim back into it.
4. **What working looks like.** Darting tight circuits round its own coral with a pebble in its
   mouth, kicking up sand where it touches down.

## The mapping

| The reef | The sessions |
| --- | --- |
| A shelf of reef rock | One project or repo — same cells as its colony plot |
| A fish | One thread |
| How many branches its coral has grown | Transcript size, on the colony's log scale |
| A fish risen out of the reef, facing you, under a gold light column | The thread needs a reply |
| Swimming out of the wreck | A thread just appeared |
| Swimming back into the wreck | Archived |

## States

Decided by `statusFor` in `src/game/status.js` — the function the colony uses, so the two worlds
cannot disagree. First match wins.

| Thread state | Fish |
| --- | --- |
| Errored | Lists on its side by its coral, colour drained, red `!` |
| Working now | Darts round its coral with a pebble, sand puffs |
| Shipped | Loops over its coral, bright flash, green `✓` |
| **Waiting on you** | **Rises above the reef and faces the camera; gold light column; `?`** |
| Dormant for days | Rests on the sand, barely moving |
| Anything else | Mills about its shelf |

Gold is reserved for waiting: no coral, rim or fish palette uses it.

## Keys

`N` next waiting fish · `O` orbit · `H` home · `Esc` deselect · `WASD`/arrows pan ·
`Q`/`E` turn · `+`/`-` zoom · `,` settings. `?demo` on the URL runs on invented threads and
never saves.
