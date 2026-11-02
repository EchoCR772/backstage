# Tests

End-to-end tests that drive the real app with Playwright against a small fake clip library.
They run in a Linux container (the cloud workspace), headless under xvfb.

## Setup (once per workspace)
- Copy the project (main.js, preload.js, package.json, renderer/, tools/, tests/, build/icon.png) and run `npm install`.
- Playwright must be installed globally (`npm i -g playwright`) and run with `NODE_PATH=$(npm root -g)`.

## Run
```
NODE_PATH=$(npm root -g) xvfb-run -a node tests/run.js           # everything
NODE_PATH=$(npm root -g) xvfb-run -a node tests/run.js overlay   # one test
NODE_PATH=$(npm root -g) xvfb-run -a node tests/run.js --gpu     # overlay also with software WebGPU
```
Each test prints PASS/FAIL with the checks that failed. Profiles, exports and the big scrolling
library are created in `tests/out/` (ignored by git).

## Tests
- `overlay.test.js`: the editor end to end (open, play, click-to-pause, keyboard and typed trims, frame keys, transport buttons, playhead trapped, a row per person, mute, export video/audio with the confirmation, ready-made copy, menus, saved trim, rename from the title, card length, card copy).
- `library.test.js`: card controls, right-click menu, rename, NEW badges, folder filter and games sidebar, tabs (next clip, Ctrl+Tab, back/forward), settings overlay, scrolling with 64 clips, refreshes keep the cards.
- `export.test.js`: smart cut (exact frame count, length, clean decode), names on exports/copies, named hard links, drag-ready files, Replace original (tracks, Discord info, dates, name).
- `effects.test.js`: Trim and Edit, the Edit timeline (tracks, trimming on V1, zoom), undo/redo, split/duplicate, the asset panel, Save Changes / Cancel, exports with effects and under a size.
- `cliplist.test.js`: the editor's clip list (compact cards, virtual scrolling, games filter it, back to top).
- `encore.test.js`: Encore recordings (audio rows, badge, size preview, exports).
- `games.test.js`: finding a game (sidebar search and Recent / Alphabetical sort), Edit's tabs in the sidebar, the Clips tab's game picker, folding the panel, the timeline running under the sidebar.
- `fixes.test.js`: his Nov 2 round: Discard after playing in Edit, a newly saved clip showing up in the editor's list, a half-written clip getting its picture once finished, drawing after undo, Edit's full transport bar and icons, tooltips below the title bar, V1 pictures kept while scrolling.
- `report.test.js`: Report a Problem and recording software reports against a stand-in server, My Reports replies.
- `delete.test.js`: deleting clips and empty folders.
- `style-snapshot.js`: not a pass/fail test; records computed styles in 11 states so a CSS cleanup can be proven to change nothing (`--compare a.json b.json`).

On Linux the bundled ffmpeg-static build crashes reading MPEG-TS (used by smart cut), so the tests point the app at the system ffmpeg (`BACKSTAGE_FFMPEG=/usr/bin/ffmpeg`, set in helpers.js; `apt install ffmpeg` if missing). ffprobe is used by export.test.js. The Windows build has no such problem.

## Fixtures (`fixtures/`)
- `nv/`: NVIDIA-style per-game folders (Instant Replay `.DVR` names, a `Clips` subfolder, `peak.exe` exe-named folder, "Call of Duty  Black Ops 6" double-space name).
- `goplib` (made by helpers.js in tests/out): a 12 s clip with a keyframe every second and two audio tracks, for smart cut.
- `dc/`: Discord-style clips (`Game_<uuid>.mp4`), three with 4 audio tracks labelled `0:all`, `0:application` and two `<id>:voice`, one with no audio.
