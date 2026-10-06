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
3. **A project's home.** A raised shelf of reef rock on the project's hex cells. Its rim takes
   the colour of the loudest thing its threads are doing — colour goes on state, not on project,
   since a project is already told apart by where it is — and an older project's shelf is more
   overgrown. The colony's ship cell is a sunken wreck: fish arrive out of it and archived
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
| Errored | Lies on its side on the sand by its coral, colour drained, red eyes, `!` |
| Working now | Darts round its coral with a pebble, sand puffs |
| Shipped | Loops over its coral, bright flash, green `✓` |
| **Waiting on you** | **Rises above the reef and faces the camera; gold light column; `?`** |
| Dormant for days | Settles on the sand once and stays put |
| Anything else | Potters about its shelf in short legs, pausing to look around |

Gold is reserved for waiting: no coral or fish palette uses it, and a shelf rim only turns gold
because a fish on it is waiting. Running threads light their coral's tips; nothing else glows on
purpose except the wreck's lamp after dark.

## Keys

`N` the fish that has waited longest, then the next · `/` find a shelf or thread · `G` down to
ground level and back · `P` photo mode (`Shift+P` saves a picture) · `O` orbit · `H` the whole
reef · `Esc` back out of whatever is open · `WASD`/arrows pan · `Q`/`E` turn · `+`/`-` zoom ·
`,` settings. Click a shelf name to list its threads; click the minimap to fly there.

`?demo` on the URL runs on invented threads and never saves. `?check` runs the check suite —
every instruction in the skill that applies here, measured — and prints the results on the page.
[reef-checklist.md](reef-checklist.md) is the full list, with where each one lives in the code.
