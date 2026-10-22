# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-10-22

WBPP stops being the opening move: the skill now looks for a master first, defaults its
output into the material folder, and offers to clean up after itself.

### Added

- **`lib/pixinsight-mcp/scripts/find-masters.mjs`** — recursive scan of a material folder that
  classifies every candidate and returns `verdict: ready | only_calibration | none`, so an
  existing light master is reused instead of re-stacking the frames. Parses channels from
  `FILTER-Ha` / `FILTER-OIII` style markers; digit-adjacent letters such as `EXPTIME-300s`
  are never misread as a band, and `masterFlat` / `masterDark` are never treated as
  pipeline input.
- **`lib/pixinsight-mcp/scripts/clean-wbpp-intermediates.mjs`** — reports (default `--dry-run`)
  or deletes (`--yes`) WBPP's scratch tree (`registered/`, `calibrated/`, `debayer/`,
  `cache/`, `logs/`). Refuses with exit 2 when no light master exists to protect, and never
  steps outside `--dir`.
- **"Entry protocol" section** in `SKILL.md` and `AGENTS.md`: hunt the master, ask about
  WBPP only when the hunt proved there is none, keep outputs in the material folder, offer
  the cleanup after a successful run.

### Changed

- **`run-wbpp.ps1` (both copies): `-OutputDir` is now optional**, defaulting to
  `<first InputDir>\wbpp` — inside the material folder, where `find-masters.mjs` will look
  next time. Both wrappers print the intermediate footprint and tell the caller to ask
  before deleting.
- `README.md` documents the locator, the cleanup script and the new default output path.

### Removed

- **Duplicate WBPP copies under `scripts/`.** `scripts/run-wbpp.ps1`, `scripts/find-masters.mjs`
  and `scripts/clean-wbpp-intermediates.mjs` were unreferenced second copies — both installers
  only deploy `lib/pixinsight-mcp/*`. The single source of truth is now `lib/pixinsight-mcp/`,
  and every doc path was updated to match.

## [0.2.0] — 2026-10-18

Verified end to end against a live PixInsight 1.9.4 on real deep-sky data
(a one-shot colour M45 processed through the full Flow C, and an M81/M82 attempt
that surfaced the material and WBPP problems now documented here).

### Added

- **First-run workspace onboarding.** `workspace_show` reports
  `first_use: true` when nothing has been chosen yet, so the agent asks once where
  previews and intermediate files should live; `workspace_set` stores it in
  `~/.pixinsight-mcp/workspace.json`. `PIXINSIGHT_WORKSPACE` overrides it per
  session; `workspace_set {"path":"default"}` resets. New `reference/ONBOARDING.md`.
- **Preflight stage** (`reference/preflight.md`) run before the first process step:
  linearity, channel balance, whether the target is in frame, whether the flats
  match the lights, and whether FITS headers will mis-group in WBPP. Documents
  explicitly which problems processing cannot fix.
- **WBPP automation reference** (`reference/wbpp-automation.md`) with the exact
  working command line, every failure variant that was observed, and the
  header-based frame grouping trap.
- **`scripts/run-wbpp.ps1`** — a wrapper that encodes the three quoting rules,
  validates inputs, and reads the resulting log for the registration failures a
  "successful" run can hide. (The skill previously referenced a wrapper that did
  not exist.)
- **Tool detection with fallback** (`tooling.mjs`): BXT / NXT / SXT / GC / MGC /
  GraXpert / MAS / GHS / NarrowbandNormalization are probed at runtime and each
  missing tool resolves to a documented native fallback. `capability_report`
  reports the whole matrix.
- **Flow A/B/C director flows** wired to exact calls: narrowband dynamic colour
  mixing, LRGB fusion, OSC HaRGBT injection with per-image Q and B search,
  dual-band to SHO channel synthesis, and a quick-pass variant.
- **Per-stage acceptance gates** (`acceptance_check`): background neutrality,
  highlight burn, black clip, noise sanity, histogram gaps — plus STF and
  median/mean/MAD/min/max reporting.
- **Interleaved denoise policy** (`denoise-policy.mjs`) with per-phase floors and
  ceilings, and a refusal path when a frame is already clean.
- **Diagnostic stretch guidance** for low-contrast targets: a galaxy only a few
  percent above the sky background looks empty in a normal preview; use a
  MAD-normalised stretch to establish the target is present before judging quality.

### Fixed

- **Bridge crash on heartbeat.** `processNextCommand` deleted the heartbeat file
  before dispatching, and dispatch is synchronous — a long process left no
  heartbeat at all, so the Node side concluded PixInsight had crashed and abandoned
  a result that was still coming. The command file then blocked the queue forever.
  The heartbeat is now refreshed before dispatch, and `isAlive` only treats a
  missing PixInsight **process** as death.
- **Re-dispatched commands.** Node removes the result file as soon as it reads it,
  so "result file exists" cannot protect a command that is still running. Commands
  are now claimed in memory before dispatch.
- **Head-of-queue livelock.** A command file that could not be deleted stayed at the
  head of the queue and was re-read forever: the watcher looked alive (heartbeat
  ticking) while nothing ran. The queue now skips answered-and-undeletable entries.
- **Watcher died silently on the first poll.** `File.searchDirectory` does not
  exist; `searchDirectory` is a global. The old code threw inside the loop while the
  file-written heartbeat kept ticking, which looked exactly like "alive but idle".
- **Poll-loop exception handling.** Consecutive failures on the same command now
  stop the loop with a diagnostic instead of spinning.
- **PJSR API misuse** across the ops modules: `expressionR/G/B` (they are
  `expression0/1/2`), `Image.median(channel)` (needs `selectedChannel`), and
  `minimum()`/`maximum()` without a `Rect`.
- **Quality-gate pixel access** now bulk-reads through `getSamples()` instead of one
  PJSR-to-C++ crossing per pixel; FWHM is corrected for the downsample scale, and an
  unmeasurable field reports as failure rather than passing.
- **`HistogramTransformation.H`** documentation and usage: five arrays of
  `[blackPoint, midtones, whitePoint, lowClip, highClip]`. A malformed `H` does not
  throw — it can turn the frame solid red.
- **`Image.crop`** must take a plain array; the four-number form silently does
  nothing and the `Rect` form throws.
- **`File.size` / `File.appendTextFile`** do not exist.

### Changed

- Skill documentation reorganised around eight director rules, the three flows, and
  a stage acceptance checklist; PJSR gotchas expanded with the exhaustively verified
  API surface.

## [0.1.0] — 2026-10-17

### Added

- Initial packaging: the `pixinsight-pipeline` skill as a DSH plugin, the file-based
  IPC bridge, the PJSR watcher, and `pi-tool.mjs`.
