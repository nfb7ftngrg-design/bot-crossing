# The Lab

A third world over the same threads. Open `/lab.html`: Level B3 of the *Directorate of Thread
Operations* (DTO), an underground facility seen from above through a cut-away ceiling. Every
thread is a person at a workstation, every repo a department, and the big tasks you hand out are
**cases** pinned to corkboards in the operations room. The agency is fictional: its name, seal,
motto and signage are drawn in `src/lab/look.js` and copy no real agency's insignia.

Like the reef, it is a costume over the shared frame — `statusFor`, the stable layout allocator
(generalised to a square lattice, `createAllocator` in `src/world/layout.js`), the engine,
camera, quality presets and `data/colony.json` — so it can be open beside the colony and the reef
and all three agree.

## The concept

1. **Who works here?** One person per thread: clothes, hair, skin, height and walking pace all
   come from the thread id, so a person looks the same every visit.
2. **The setting.** A windowless sub-basement: polished concrete, ceiling fixtures throwing pools
   of light on a 4 m grid, glass-walled department rooms off the corridors. By night the fixtures
   drop and what stays lit is somebody working — their lamp, their screen, the server racks.
3. **A project's home.** A department: one or more 12 m rooms, six desks a room, its name on a
   wall screen with its counts. A department keeps its rooms when another grows.
4. **What working looks like.** Seated at the workstation, typing, headset on, code scrolling,
   lamp on, steam off the coffee.
5. **The building.** A lobby with the elevator, the agency seal set in the floor and a
   security checkpoint every arrival walks through; an operations room with a video wall, a
   conference table and twelve case-board slots; a server room whose rack LEDs blink faster the
   more threads are running; an evidence archive whose shelves fill with a box per archived
   thread; a break room with coffee stations.

## The mapping

| The lab | The sessions |
| --- | --- |
| A department (glass-walled rooms) | One project or repo |
| A person and their workstation | One thread |
| How built-up the desk is (mug, paper, 2nd/3rd monitor, binders, notes, photo) | Transcript size |
| The colour of a department's sign | The loudest state among its threads |
| Out of the elevator, through the checkpoint, to the desk | A thread just appeared |
| Clears the desk, back into the elevator; a box in the evidence archive | Archived |
| A corkboard in the operations room | A case you opened |
| A photo on that board, a case folder on the desk | That worker is on the case |
| Night shift: lights down, working desks lit | Real or chosen time of day |

## States

Decided by `statusFor` (`src/game/status.js`), first match wins. Every person's card says in
plain words what they are doing and what that means about the thread (`DOING` in
`src/lab/people.js`), so every worker knows what they're doing, where they are (department, on
the card and the plate) and what their job is (the thread title, and any case).

| Thread state | Person | Screen |
| --- | --- | --- |
| Errored | Slumped at the desk, head in hands, `!` | Red |
| Working | Seated, typing, headset on | Code scrolling |
| PR merged | Standing by the desk, cheering; confetti; neighbours turn to look; `✓` | Green |
| **Waiting on you** | **Standing by the desk, waving, facing the camera, under a gold light column seen through walls; `?`** | Amber, pulsing |
| Dormant | Asleep at the desk; does not move | Dark |
| Anything else | Short legs about the department, pauses, coffee in the break room, each at their own pace | Screensaver |

## Cases

A case is `{ id, title, brief, priority, status, assigned[], createdAt, updatedAt }`, kept in
`state.cases` (`src/lab/cases.js`; sanitised by `asCases` in `server/api.mjs`, merged per case by
`mergeState`). Priority is routine / priority / urgent; status open → active (once someone is on
it) → closed. Open the panel with `C`, or "Put on a case…" on any card. The boards
(`src/lab/caseboards.js`) are canvas corkboards: title, stamp, priority tape, brief, a polaroid
per worker joined by red string. Clicking a board opens its case; "Show board" walks the camera
to it. "Brief" copies `briefText(case, thread)` to the clipboard and opens the thread where the
harness allows — Bot Crossing never writes to a harness.

## Walking

The floor plan (`src/lab/floorplan.js`) is the source of the walls: corridors wrap every room,
a department's wall to a corridor is glass, a door sits off-centre in each shared wall so desks
and screens keep clear of it. The nav grid (0.25 m) opens every square on the plan and closes
every wall and every piece of furniture; people route with A\* and every step slides against the
same grid, so the check suite can count person-frames inside a wall (always zero). Someone who
stops making progress for 3 s gives up on that leg; a leaver whose way out has gone fades where
they stand.

## References

The floor plan borrows from how real facilities are described in public sources — none of them
is reproduced, and no real agency is named in the world:

- The FBI's Strategic Information and Operations Center: a ~40,000 sq ft command facility of
  separate rooms that can be "reconfigured and compartmentalized" around active cases, running
  several critical events at once — the idea behind departments of rooms around a shared
  operations room. [FBI: SIOC Turns Ten](https://www.fbi.gov/news/stories/2008/december/sioc120908),
  [GovExec, 1998](https://govexec.com/federal-news/1998/11/fbi-unveils-crisis-management-center/5029)
- ICD/ICS 705 SCIF technical specifications: one primary entrance through which people enter and
  exit, with access control — why each secure room has a single door from the lobby.
  [IC Tech Spec for SCIF construction (DNI)](https://www.dni.gov/files/NCSC/documents/Regulations/Technical-Specifications-SCIF-Construction.pdf),
  [ICS 705 (FAS mirror)](https://irp.fas.org/dni/icd/ics-705-ts.pdf)
- The White House Situation Room's 2023 rebuild: a conference room supported by a 24/7 "watch
  floor" of staff watching intelligence and media feeds — the operations room's video wall and
  conference table. [NPR via MPR News](https://www.mprnews.org/story/2023/09/08/npr-white-house-situation-room-makeover)
- The FBI Laboratory at Quantico: offices and public areas separated from lab areas, and an
  evidence control centre that receives and logs everything on a chain-of-custody form — the
  evidence archive with a box per archived thread. [DOJ OIG](https://oig.justice.gov/archives/reports/FBI/a0633/intro.htm),
  [FBI Laboratory history](https://www.fbi.gov/about-us/lab/forensic-science-communications/fsc/oct2007/research/2007_10_research01_test4.htm)

The look — chunky low-poly people, an angled top-down camera over a cut-away building, a bit of
swagger in the animation — is after the overhead view of open-world crime games, without
borrowing any of their assets.

## Checklist

`/lab.html?check` runs these against a fixed roster that puts all six states on the floor and
publishes the report on `window.__labChecks`. The details below are from a run in headless
Chromium (SwiftShader); the suite passed 59/59 on five runs, four at 1280×800 and one at 400×800.

| Id | Area | Requirement | Measured |
| --- | --- | --- | --- |
| MAP-1 | Mapping | One person per thread | 29 threads, 29 people, 29 desks; 0 missing, 0 extra (waited 38s for departures) |
| MAP-2 | Mapping | One department per project — every desk stands in its own department’s rooms | 29/29 desks inside their own department |
| MAP-3 | Mapping | Idle people stay on open floor — their department, the corridors, the break room — never in a secure room | 990 idle samples: own department 889, corridor 37, break 40, another department 24 |
| NAV-1 | Floor plan | Every desk can be walked to from the elevator, through doorways | 29/29 chairs reachable from the elevator |
| NAV-2 | Floor plan | Departments keep their rooms when another grows; new rooms appear beside the old | 0 other departments moved; docs-reef grew and kept its rooms: true; shrank back to its first shape: true |
| NAV-3 | Floor plan | Routes are found, and walking is checked against walls on every step | 550 routes asked for, 0 failed |
| STATE-1 | States | State is decided once, and everything reads it | 0 disagree with statusFor; corner counts match: true; every screen shows its thread's state: true |
| STATE-2 | States | All six states are on the floor | {"blocked":2,"waiting":3,"working":7,"celebrating":2,"idle":11,"sleeping":4} |
| STATE-3 | States | Waiting reads as asking for you: on their feet by the desk, waving, facing you | 3/3 standing at their desk, waving, within 20° of facing the camera |
| STATE-4 | States | Errored reads at a distance: slumped at the desk, head in hands, red screen | 2/2 slumped at their desk with a red screen |
| STATE-5 | States | Working is busy: seated, typing, headset on, code on the screen, lamp lit | 7/7 typing at their desk with a headset and code on screen; 0 headsets on anyone else |
| STATE-6 | States | Finished well is good news: on their feet cheering, confetti | 2/2 cheering; 4 confetti bursts in 6s |
| STATE-7 | States | Dormant stays put: asleep at the desk, screen dark | 4/4 asleep at their desk; furthest moved in 30s: 0.000 |
| STATE-8 | States | Idle people potter: short legs, pauses, coffee breaks, each at their own pace | 11/11 paused at least once in 30s, 2 on a coffee break; 39 legs; 9 distinct paces |
| STATE-9 | States | Walking comes from distance covered: held still, no stride; moving, the stride matches the ground | every step refused for 1s: stride advanced 0.000, pose stand; then walked 1.67 m at 4.80 stride units per metre (fixed at 4.8) |
| STATE-10 | States | Only signal what wants attention — badges on waiting, errored and shipped only | 7 badges for 7 people who want something; 15 quiet people carry none |
| SIG-1 | Signal | A light column over everyone waiting on you, visible through walls | 3 columns for 3 waiting; drawn through walls: true |
| SIG-2 | Signal | The waiting gold is used nowhere else | 29 clothing colours checked; 0 near the waiting gold |
| SIG-3 | Signal | N goes to the person who has waited longest, then the next | 3 visited in longest-waiting order: true |
| SIG-4 | Signal | Colour by state, not by department | harbour-api: blocked, ml-tides: blocked, web-kiosk: waiting, old-batch: working, docs-reef: working |
| GROW-1 | Structures | A desk fills in with the work its thread has done, and with nothing else | clutter rises with transcript size: true; every desk the same size, no random part: true |
| GROW-2 | Structures | Desk pieces unfold in the shader, mirrored in the shadow pass; so does the skeleton | workstations and people both carry a depth material with the same vertex code |
| CROWD-1 | Crowd | One instanced draw for all the people, and one for all the desks | 29 people: 79 draws · 89 people: 58 draws (any difference is new rooms' walls and screens, not people) |
| CROWD-2 | Crowd | Crowds, not piles — people keep a body apart | 89 people for 30s: 0 pairs closer than half a body; closest 0.43 (spacing 0.62) |
| CROWD-3 | Crowd | Nobody walks through a wall or a desk | 80100 person-frames: 0 inside a wall or furniture; 0 outside the plan; 1110 spacing pushes |
| CROWD-4 | Crowd | A spot someone else is standing on is given up on, not shouldered at forever | gave up after being blocked and moved on: true; closest it pressed: 0.43 (body 0.62); wall hits 0 |
| CAM-1 | Camera | Dragging grabs the floor — the point under the cursor stays under it | dragged 152px; drifted at most 0.000 units |
| CAM-2 | Camera | Scrolling zooms at the cursor | zoomed 62.0 → 38.2; point under the cursor moved at most 0.008 |
| CAM-3 | Camera | Right-drag tilts and turns; orbit yields to a touch and comes back | right-drag turned the view: true; orbit 0.99 → touched 0.17 → after 0.99 |
| CAM-4 | Camera | Down to the floor in one gesture, never below head height | G: tilt 76°; lowest camera height in a full turn 1.94 |
| LIGHT-1 | Light | PBR lit by an environment map (a generated room, since there is no sky underground) | scene.environment bound; intensity 0.42 |
| LIGHT-2 | Light | The night shift dims the floor, and what stays lit means someone is working | night 1.00: 7 lamp pools for 7 working desks; by day 0 |
| LIGHT-3 | Light | Lit by real time of day, as an option | clock 0.1248, floor 0.1248 |
| LIGHT-4 | Light | The key light is never straight overhead, so walls catch light | key light elevation 64.3° |
| POST-1 | Materials | Bloom threshold high; depth of field on what the camera orbits | bloom threshold 0.92; focal distance 46.00 = 46.00 |
| POST-2 | Materials | Cost of each post pass, timed with a GPU sync | Render 2.7ms · Occlusion 0.1ms · _UnrealBloom 0.2ms · Shader 0.0ms · Shader 0.0ms · Overlay 0.1ms · Output 0.1ms · Shader 0.0ms · SMAA 0.0ms |
| POST-3 | Materials | The frame is not washed out, and a static scene is identical frame to frame | 0 pixels differ between two renders; mean brightness 156/255; 0.1% blown to white |
| POST-4 | Materials | Switching effects off releases their memory | composer disposed when every effect is off: true |
| SET-1 | Settings | Five presets, the middle by default; a moved knob is marked | potato · low · balanced · high · ultra; moved knob marked: true |
| ACT-1 | Interaction | Click a person to pick them | clicked (640, 332); picked that person |
| ACT-2 | Interaction | Every worker knows what they are doing, where they are, and what their job is | “Working” · Check thread 4 · harbour-api · “At their workstation, typing — the thread is running right now.” |
| ACT-3 | Interaction | The card rides beside them, by transform | card edge 34px from the person |
| ACT-4 | Interaction | Name plates on hover, and kept up for whoever wants you | 4 plates without hover, all on people who want you; hovering adds a quiet person's plate: true |
| ACT-5 | Interaction | A hovered person looks at you; neighbours turn to a celebration | hovered person 0.0° off facing the camera; 2 people turned to the celebration |
| ACT-6 | Interaction | Search, filters, a department’s staff list, minimap and compass, photo mode | search → web-kiosk; "Needs me" keeps 5; ml-tides lists 6; 71268 map pixels; photo mode hides every panel: true |
| ACT-7 | Interaction | Archive: the desk clears, they walk to the elevator and leave, their file goes to evidence | walked out in 14s; evidence boxes 0 → 1 |
| ACT-8 | Interaction | Arrival: out of the elevator, through the checkpoint, to their desk | stepped out of the elevator: true; cleared the checkpoint at 4s; at their desk typing at 50.5s |
| CASE-1 | Cases | Open a case from the panel — it goes up on a board in the operations room | 1 case; “Stop the checkout from timing out” urgent/open; on a wall: true; listed in the panel: 1 |
| CASE-2 | Cases | Put a worker on it from their card — folder on their desk, their photo on the board | assigned and now active; case folder on the desk: true; chip on the card: true; photo on the board: true |
| CASE-3 | Cases | Add more from the panel, take one off, close it — the board follows | 2 on it after one was taken off; closed on the board: true; folders cleared from desks while closed: true |
| CASE-4 | Cases | Brief a worker: the case text, ready to paste into their agent | CASE: Stop the checkout from timing out / Priority: Urgent / Assigned to: Check thread 3 |
| CASE-5 | Cases | Click a board to open its case; “Show board” walks the camera to it | board in view after “Show board”: true; click at its centre hits that case: true; panel opened on it: true |
| CASE-6 | Cases | Delete asks to be clicked twice | first click armed it (“Delete — sure?”); second deleted it: true |
| CASE-7 | Cases | Two tabs editing different cases keep both edits | my assignment and their closure both survive the merge |
| LIFE-1 | Alive | A person looks the same every time, from their thread id | same id, same clothes, hair and skin |
| LIFE-2 | Alive | Activity drives ambience: the server racks blink faster the more threads work | rack activity 0.55 from 8 working of 29 |
| LIFE-3 | Alive | Sound is off by default | off on a fresh floor; the waiting call stays silent while off |
| SAVE-1 | Persistence | The demo and the check run write nothing anywhere | 0 writes attempted |
| SAVE-2 | Persistence | The elevator is in the lobby, where arrivals start and departures end | elevator point is in the lobby |
