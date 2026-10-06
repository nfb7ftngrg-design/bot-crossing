# The Reef against the skill

Every instruction in `.claude/skills/agent-session-world` (the skill and its four references) that applies to the reef, where it lives in the code, and what the check suite measured. Run `/reef.html?check` to reproduce this table; the numbers below are from the last full run in a headless Chromium with a software renderer (SwiftShader), so the millisecond timings are an emulated GPU's, not a real one's.

**64 of 64 checks pass.** The suite was run 16 times while this was built (nine while fixing, six repeats including phone width, and this final run); every failure it found is listed at the end with what was wrong and what changed.

## Mapping

| Check | What the skill asks | Where it lives | Measured |
| --- | --- | --- | --- |
| MAP-1 | One inhabitant per thread | `School.setRoster` — src/reef/fish.js | **pass** — 29 threads, 29 fish, 0 missing, 0 extra (after 30s for the demo's fish to swim home) |
| MAP-2 | One territory per project — every fish lives on its own project’s shelf | `Reef.setThreads`, `_slotPosition` — src/reef/reef.js | **pass** — 29/29 corals on their own shelf |
| MAP-3 | Idle fish stay on their own ground | idle branch of `School._behave` — src/reef/fish.js | **pass** — 100.0% of 220 idle samples over their own shelf |

## States

| Check | What the skill asks | Where it lives | Measured |
| --- | --- | --- | --- |
| STATE-1 | State is decided once, in one ordered function, and everything reads it | `statusFor` — src/game/status.js (shared with the colony) | **pass** — 0 fish disagree with statusFor; counts in the corner match |
| STATE-2 | All six states are on the reef | `statusFor` — src/game/status.js | **pass** — {"blocked":2,"waiting":3,"working":7,"celebrating":2,"idle":11,"sleeping":4} |
| STATE-3 | Waiting reads as asking for you: risen out of the reef, facing the camera | waiting branch of `_behave`; facing in `School.update` | **pass** — 3/3 risen ≥1.5 above their coral and within 20° of facing the camera |
| STATE-4 | Errored reads at a distance: on its side, colour drained, down by its coral | blocked branch, `_restingSpot`; roll and drain in `School.update` | **pass** — roll 1.25 drain 1.00 0.30 off the floor; roll 1.25 drain 1.00 0.38 off the floor |
| STATE-5 | Working is busy and purposeful, and carries a prop | working branch of `_behave`; pebble instanced mesh `School.props` | **pass** — 7/7 at least twice idle's 0.40 u/s (1.97, 1.77, 2.03, 1.65, 1.55, 1.88, 1.97); 7/7 carry a pebble; 0 pebbles on fish that are not working |
| STATE-6 | Finished well is good news: loops over its coral and flashes | celebrating branch of `_behave`; `_drawAttention` | **pass** — 4 flashes from 2 fish in 6s; 100% of the time above its coral |
| STATE-7 | Dormant stays put — settles once and does not get up again | sleeping branch, `_restingSpot`, `_settleAt` — src/reef/fish.js | **pass** — 4 dormant fish; furthest moved in 30s: 0.023; heights off the floor 0.29, 0.30, 0.52, 0.22 |
| STATE-8 | Idle potters: short legs, pausing between, pace varying per fish | idle branch (`pause`, `pace`, `linger` from `fishLook`) | **pass** — 9/11 paused at least once in 20s; 190 legs started; 10 distinct paces |
| STATE-9 | Locomotion comes from distance covered, not intended velocity | speed from distance moved, in `School.update` | **pass** — wanting 4 u/s but held: speed 0.16, tail 0.29; released: measured 2.93 for 2.93 actually moved |
| STATE-10 | Only signal what wants attention — badges on waiting, errored and shipped only | `BADGE_FOR` — src/reef/reef.js; `Badges` — src/reef/effects.js | **pass** — 7 badges for 7 fish that want something; 15 quiet fish carry none |

## Signal

| Check | What the skill asks | Where it lives | Measured |
| --- | --- | --- | --- |
| SIG-1 | Something visible from anywhere over every fish waiting on a reply | `Beacons` — src/reef/effects.js | **pass** — 3 light columns for 3 waiting fish; drawn through geometry: true |
| SIG-2 | The beacon colour is used nowhere else | palettes in src/reef/fish.js and src/reef/coral.js | **pass** — 58 coral and fish colours checked; 0 within reach of the waiting gold |
| SIG-3 | A key flies to the next one waiting, in the order they started waiting | `waitingOrder` — src/reef/signals.js; `nextWaiting` — src/reef/main.js | **pass** — visited 3 in longest-waiting order: true |
| SIG-4 | Colour by state, not by project — each shelf rim shows its loudest state | `shelfSignal` — src/reef/signals.js; `Seabed.setSignals` — src/reef/seabed.js | **pass** — harbour-api: blocked, ml-tides: blocked, web-kiosk: waiting, old-batch: working, docs-reef: working |

## Territories

| Check | What the skill asks | Where it lives | Measured |
| --- | --- | --- | --- |
| LAND-1 | Territories stay put when a different project gains threads | `allocateCells` — src/world/layout.js (shared); rising ground in `Seabed.setLayout` | **pass** — 0 other shelves moved; docs-reef grew and kept its cells: true; new ground rose rather than appeared: true; shrank back to its first shape: true |
| LAND-2 | The layout is persisted and comes back from the saved file | `layoutForSave` / `restoreLayout` — src/reef/reef.js; `state.plots` | **pass** — state.plots matches the live layout (12 shelves) |

## Structures

| Check | What the skill asks | Where it lives | Measured |
| --- | --- | --- | --- |
| GROW-1 | How developed a structure looks tracks how much work its thread has done | `coralGrowth`, `coralSize` — src/reef/coral.js | **pass** — growth rises with transcript size: true; drawn scale is growth alone, no random part: true |
| GROW-2 | Growth is a shader offset, mirrored in the shadow pass | coral vertex unfold + `customDepthMaterial` — src/reef/coral.js, src/reef/shading.js | **pass** — 5/5 coral forms unfold in the vertex shader and in their depth material; fish swim in theirs too |
| GROW-3 | Open shells drawn double-sided and shadowed from their back faces | tube sponges in `Corals._makeKind`; hull in `createWreck` | **pass** — tube sponges and hull: double-sided, back-face shadows; 2 closed boxes single-sided |

## Crowd

| Check | What the skill asks | Where it lives | Measured |
| --- | --- | --- | --- |
| CROWD-1 | One instanced draw for the whole crowd | `School.mesh` (one InstancedMesh, swim in the vertex shader) | **pass** — 41 fish: 22 draws · 181 fish: 22 draws (the school is one InstancedMesh) |
| CROWD-2 | Crowds, not piles — spaced by the widest part of the body | `BODY` spacing, soft separation, `School._separate` | **pass** — 169 fish for 30s: 0 pairs closer than half a body (0.68); closest 1.05; spacing 1.37, arrival 1.57 |
| CROWD-3 | Nothing crosses anything solid — coral or floor | hard constraints in `School.update`; `_clearOfCorals`; `_route` | **pass** — 27 touches under 1 cm; 157144 fish-frames: 0 coral penetrations, 0 floor hits; 2776 legs swum |
| CROWD-4 | Arrival distance is larger than spacing; a fish that cannot get closer gives up | `ARRIVE`, `_checkProgress` — src/reef/fish.js | **pass** — occupied spot: stopped 1.43 from the fish lying there (spacing 1.37), at rest; unreachable spot: gave up true, adopted its own ground true |

## Camera

| Check | What the skill asks | Where it lives | Measured |
| --- | --- | --- | --- |
| CAM-1 | Dragging grabs the ground — the point under the cursor stays under it | `rig.groundPoint` override (level plane through the grab) — src/reef/main.js | **pass** — dragged 152px; the grabbed point drifted at most 0.000 units from under the cursor |
| CAM-2 | Scrolling zooms at the cursor, not the screen centre | same, for the wheel anchor | **pass** — zoomed 62.0 → 38.2; the point under the cursor moved at most 0.015 |
| CAM-3 | Right-drag tilts and rotates | `CameraRig` — src/core/camera.js (shared) | **pass** — heading 45.0° → 24.4°, tilt 56.0° → 64.6° |
| CAM-4 | A slow orbit that yields the instant the camera is touched and eases back after | `CameraRig.setOrbit` — src/core/camera.js | **pass** — sweep 0.99 → touched 0.17 → 1s after 0.01 → 6s after 0.99 |
| CAM-5 | Ground level in one gesture — among the fish, never inside the rock | `toggleGround`, camera clearance in `step` — src/reef/main.js | **pass** — G: tilt 80°, 9.0 units out; lowest the camera came to the floor in a full turn: 1.50; G again: back to 56° |
| CAM-6 | Keyboard movement | `driveKeys` — src/reef/main.js | **pass** — half a second of D moved the view 15.31 units |

## Day and night

| Check | What the skill asks | Where it lives | Measured |
| --- | --- | --- | --- |
| LIGHT-1 | The sky itself is the environment map | `Water` dome + `envScene` — src/reef/water.js | **pass** — scene.environment bound; env dome shares the visible dome's material and uniforms: true |
| LIGHT-2 | The environment is re-filtered only when the sky has moved | `_envStamp` throttle in `Water.update` | **pass** — 0 rebuilds in 6s of unchanged sky; 1 after the time changed |
| LIGHT-3 | The sun is never overhead | solar arc in `Water.update` (18° + 44°·height) | **pass** — highest sun over a full day: 62.0° |
| LIGHT-4 | Lit after dark, not only darkened — and only what means something glows | wreck lamp `createWreck`; coral `aActive` glow | **pass** — night 1.00: wreck lamp 7.7, noon lamp 0.00; coral glow on exactly the running threads: true |
| LIGHT-5 | Light the world by real time of day, as an option | `Water.currentTime` (`clockTime`) | **pass** — clock says 0.0917, sky is at 0.0917 |

## Materials

| Check | What the skill asks | Where it lives | Measured |
| --- | --- | --- | --- |
| POST-1 | Bloom picks out lights rather than hazing everything | `Engine._ensureComposer` — src/core/engine.js (shared) | **pass** — bloom threshold 0.92 |
| POST-2 | Depth of field reads depth, with the focal plane on what the camera orbits | `createTiltShift` + `setFocusDistance` from `step` | **pass** — depth-of-field passes: 2; focal distance 62.00 = camera-to-orbit-point 62.00 |
| POST-3 | Cost of each post pass, timed with a GPU sync | measured by wrapping every composer pass with `gl.finish()` | **measured** — Render 1.0ms · Occlusion 0.1ms · _UnrealBloom 0.3ms · Shader 0.0ms · Shader 0.0ms · Overlay 0.0ms · Output 0.0ms · Shader 0.0ms · SMAA 0.0ms (this machine's renderer: WebKit WebGL) |
| POST-4 | A static scene is identical frame to frame | two renders of one moment, compared pixel by pixel | **pass** — 0 of 1024000 pixels differ between two renders of the same moment |
| POST-5 | Turning effects off releases their memory | `Engine._disposeComposer` | **pass** — composer before true, after switching everything off disposed, back on balanced true |

## Settings

| Check | What the skill asks | Where it lives | Measured |
| --- | --- | --- | --- |
| SET-1 | Five presets, defaulting to the middle one | `PRESETS` — src/core/settings.js (shared) | **pass** — potato · low · balanced · high · ultra; default balanced |
| SET-2 | Every knob adjustable, marked when moved off its preset — and the mark survives a reload | `Hud.syncSettings`, `presetBase` — src/reef/hud.js | **pass** — moved knob marked: true; untouched knob unmarked: true; preset it came from saved with the settings: balanced |
| SET-3 | A governor scales under the chosen setting, about a step a second, never above it | `Engine._governQuality` | **pass** — ceiling 1.00; slow frames took it to 0.70; 5 changes over 66 simulated seconds; never above the setting: true |

## Interaction

| Check | What the skill asks | Where it lives | Measured |
| --- | --- | --- | --- |
| ACT-1 | Click an inhabitant to pick it | `fishAt` (screen-space hit test) — src/reef/main.js | **pass** — clicked at (692, 358); picked that fish |
| ACT-2 | Its card is parked beside it and follows it, moved by transform | `Hud.frame` card placement (transform; docked under 700px) | **pass** — card edge within 34px of the fish across 2s of swimming; positioned by transform: true |
| ACT-3 | Every worker knows what it is doing, where it is, and what its job is | `Hud.setSelection`, `DOING` — src/reef/hud.js, src/reef/fish.js | **pass** — card shows status "Idle", job "Check thread 10", shelf "harbour-api", and "Pottering about its shelf — the thread is open, nothing needs you." |
| ACT-4 | Name plates on hover, and kept up for anything that wants attention | name plates in `Hud.frame` | **pass** — 1 plates up without hover (all on fish that want you); hovering a quiet fish adds its plate: true |
| ACT-5 | Hovered fish turn to look at you | `hoverId` facing in `School.update` | **pass** — after 2s of hover, 0.1° off facing the camera |
| ACT-6 | Neighbours turn to look when one celebrates | `_drawAttention` — src/reef/fish.js | **pass** — 5 quiet neighbours within 9 units turned to the flash |
| ACT-7 | Search a shelf or thread and fly there | `search` — src/reef/signals.js; search box in src/reef/hud.js | **pass** — "kiosk" → web-kiosk; "Check thread 4" → 3 results, picked and flew to it: true |
| ACT-8 | Filters — only what is waiting, only one shelf | `FILTERS`, `filterFor` — src/reef/signals.js; `School.filter` | **pass** — "Needs me" keeps 5 fish, hides the rest, 5 badges; one-shelf filter keeps only ml-tides: true |
| ACT-9 | Click a territory to see its threads; click a thread to fly to its inhabitant | `Hud.showShelf`, `openShelf` | **pass** — ml-tides lists 6 of its 6 threads, loudest first (“Blocked”); clicking one flew to it |
| ACT-10 | A minimap and compass once the world is bigger than a screen | `Hud._drawMap`, compass | **pass** — 71268 map pixels drawn; clicking the map flies there: true; compass present |
| ACT-11 | Photo mode hides every panel and keeps the world | `Hud.setPhoto`, `.reef-photo` — src/reef/reef.css | **pass** — panels hidden true, world kept true, panels back after true |
| ACT-12 | Archive sends it back the way it came; arrival comes out of the wreck | `act("archive")`; leaving/arriving + `_route` — src/reef/fish.js | **pass** — archived fish swam home and left after 22s; on the archive list: true; new thread came out of the wreck and reached its shelf in 22s |

## Alive

| Check | What the skill asks | Where it lives | Measured |
| --- | --- | --- | --- |
| LIFE-1 | Appearance is deterministic from the thread id | `fishLook`, `coralLook` | **pass** — same id, same fish and coral, every time: true |
| LIFE-2 | Traffic between territories that carries no information | `Shoal` — src/reef/fish.js | **pass** — 48 silver fish at a third of the size, all above the reef (none below 5.6), one draw, no badge, no card |
| LIFE-3 | Activity drives ambience — running threads breathe bubbles | bubble streams in `Reef.update` | **pass** — 31 bubbles in the water after 3s from 8 working corals (was 64) |
| LIFE-4 | Theme ground by project — older projects are more overgrown | project age → overgrowth in `Seabed.setLayout` | **pass** — old-batch age 1, ml-tides age 0.3 (oldest thread decides) |
| LIFE-5 | Sound is off by default, and has exactly one interrupting call | `ReefSound` — src/reef/sound.js | **pass** — sound setting on a fresh reef: off; the waiting call stays silent while off: true |

## Persistence

| Check | What the skill asks | Where it lives | Measured |
| --- | --- | --- | --- |
| SAVE-1 | One writer: the demo and the check run write nothing anywhere | `queueSave` (demo never saves); the server never writes the file | **pass** — 0 writes attempted during the whole run |
| SAVE-2 | The wreck stands on the colony’s ship cell, where arrivals start | `createWreck` placement — src/reef/seabed.js | **pass** — wreck 0.000 from the ship cell, which no shelf owns |

## Done differently, and why

| What the skill says | What the reef does instead | Why |
| --- | --- | --- |
| Bake skeletal animation into a bone-matrix texture and skin before the instance transform | The swim is a wave down the body computed in the vertex shader, before the instance transform | A fish has no skeleton to bake. The seam is the same one the skill names — deformation upstream of `instanceMatrix` — so the school is still one draw (CROWD-1). |
| Sink a structure and discard what falls below ground to show partial construction | Each coral branch unfolds from its own base as growth passes it | The colony found that a dome cut off by the ground reads as a rendering fault. Unfolding whole branches keeps a young coral a complete small coral, still driven by a shader offset and mirrored in the shadow pass (GROW-1, GROW-2). |
| Expressions as a mask atlas; blink on independent clocks | State is carried by posture, colour and eyes: on its side and drained with red eyes for errored, facing you for waiting, looping and flashing for shipped | Fish have no eyelids and no face to swap. Every state still reads from a distance (STATE-3 to STATE-7). |
| Timeline scrubbing, if you keep history | Not built | The skill makes it conditional on keeping history. The reef keeps none: the world is a function of the current thread list. |
| Harness adapter rules: read freely, write almost nothing, validate ids, merge duplicates | Unchanged — the reef adds no reader | The reef reads the same `/api/threads` the colony does. It writes only `data/colony.json` through the page's merging save, never to a harness (SAVE-1). |
| Asset pipeline: shared atlases, retargeting, licences | Not needed | Every model in the reef is generated in code. Nothing was downloaded, so there is nothing to retarget or license. |
| Sound: a low bed, faint work sounds near what is working, one call for "somebody needs you" | Built (`src/reef/sound.js`), off by default | A headless browser cannot listen, so the checks only prove it is off by default and that the call stays silent while off (LIFE-5). Whether it sounds good needs a person with speakers. |

## What the suite caught along the way

Each of these failed a check, was fixed, and passes now.

- **Departing fish stuck forever.** Two fish heading for the wreck were pinned motionless between two corals whose pushes cancelled the pull. Steering was all they had. Long trips now take a route over a lane above the tallest coral, and a fish making no headway is lifted out (MAP-1, ACT-12).
- **Resting fish hovering in mid-water.** A fish that gave up adopted its position while still sinking, and a resting spot moved clear of a coral kept the height of the ground it left. Both now settle onto the sand beneath them, and resting spots are chosen with the most clearance of eight headings (STATE-4, STATE-7).
- **Resting fish climbing over coral.** Coral avoidance pushed upward as well as outward, which outweighed a resting fish's gentle sink. Resting fish now slide round coral on the sand (STATE-4).
- **Fish closer than a body apart.** Soft steering alone let one pair in 30 seconds come within half a body in a crowd of 172. A hard push-apart after each step guarantees spacing (CROWD-2).
- **The grabbed point slipping under the cursor.** On uneven seabed the drag drifted up to 0.63 and zoom up to 1.57 units. Both now pin to a level plane through the exact point grabbed: drift 0.000, zoom 0.015 (CAM-1, CAM-2).
- **The camera going into the rock at ground level.** The orbit point sat at y=0 under shelves 1.6 high. It now follows the seabed, and the camera keeps 1.5 above the floor (CAM-5).
- **Working fish twitchy rather than busy.** Each dash went up to 2.3 radians round the coral, so fish reversed every leg and averaged ~1.1 u/s. Dashes now flow in one direction: 1.7–2.3 u/s against idle's ~0.5 (STATE-5).
- **A card that cannot fit beside a fish on a phone.** Under 700px wide it docks along the bottom, with the fish framed above it (ACT-2).
- **Coral size with a random part.** Decoration that lies: size is now growth alone (GROW-1).
- **Night glow on every coral.** Only a running thread's coral glows now, so the glow means something (LIGHT-4).

Visual problems no check could see were found by looking at screenshots: an empty name plate drawn in the top-left corner, labels sliding under the top bar, a minimap drawing the reef at a quarter of its size, and the phone top bar overlapping the title. All fixed.
