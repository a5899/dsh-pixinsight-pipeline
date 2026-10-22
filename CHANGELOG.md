# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-10-22

Headless ASTAP: the plugin now installs a solver a script can actually drive, and verifies
it against the catalog that is on disk.

### Why this release exists

PixInsight's SPCC needs a star catalog; Gaia requires a PI account and ~40 GB, so ASTAP is
the practical fallback. But the **GUI `astap.exe` cannot be scripted**: every invocation
that also asks for output (`-o`, `-tofits`, `-update`) opens a window and blocks forever.
Measured twice here — each run sat at ~0.2 s CPU for 20+ minutes with a live window and had
to be killed. ASTAP ships a separate `astap_cli` for automation; that is what this installs.

### Added

- **`lib/pixinsight-mcp/vendor/astap_cli.exe`** — modern headless solver (v2026.09.19,
  850 KB) bundled in the plugin, so installation needs no network.
- **`lib/pixinsight-mcp/vendor/astap_setup.exe`** — official 6 MB Inno Setup package kept
  as a fallback source for the CLI.
- **`scripts/ensure-astap.mjs`** — installs the headless solver, reuses an existing
  catalog, repairs `ref_database`, and **proves** the solver can read the catalog before
  reporting success. Never reports a state it cannot verify.
- **`test/astap.mjs`** — 8 tests: bundled binary is a real PE, `--check` never writes, the
  config/catalog mismatch is caught, repair backs up the original, catalog identity comes
  from the file prefix (D05/D20/D50/D80 all share `.1476`), legacy h-series is classified,
  and the probe never claims compatibility from an unexecutable binary.
- D20 catalog (1476 tiles, ~382 MB zipped) ships as a **GitHub Release asset**
  (`astap-d20-catalog.zip`) — too large for git or npm, downloaded on demand.

### Fixed

- **A config/catalog mismatch made every solve fail silently.** `astap.cfg` said
  `ref_database=V50` (needs `*.1477`) while only `d20_*.1476` existed, so ASTAP reported
  "No star database found" while the configuration looked correct.
- **Probe false positive.** A non-executable binary produced no output, and "no catalog
  error in empty output" was read as success. The probe now requires positive evidence
  (`Using star database <code>`) and treats a non-execution as inconclusive.
- `.gitignore` no longer risks committing the 382 MB catalog archive.

## [0.3.3] — 2026-10-22

### Fixed

- **The installers were unparseable on a Chinese-locale Windows PowerShell 5.1.**
  `install-into-dsh.ps1` and `install-as-plugin.ps1` are UTF-8 **without** a BOM, so
  PowerShell 5.1 decoded them as GBK: the Chinese help comments turned into mojibake and
  `Info '重启 DSH 后技能生效。'` lost its closing quote, aborting with
  `字符串缺少终止符` / `The string is missing the terminator: '`. The install never ran.
  Both installers and `run-wbpp.ps1` are now written with a UTF-8 BOM, which 5.1 and 7 both
  read correctly. Verified by parsing all three and running the install end to end.

## [0.3.2] — 2026-10-22

Test hygiene: the gates that existed but never ran now run, and the new WBPP scripts are
covered by real fixtures.

### Added

- **`test/scripts.mjs`** — 12 behavioural tests over temp-directory fixtures:
  `find-masters` verdicts (`ready` / `only_calibration` / `none`), nested-master discovery,
  channel parsing that must not read `EXPTIME-300s` as SII and must never treat
  `masterFlat` / `masterDark` as pipeline input; `clean-wbpp-intermediates` default dry-run,
  `--yes` deletion preserving every master, refusal (exit 2) on a calibration-only folder,
  and `--keep-logs`; `resolve-toolkit` detection plus `--sub` success/failure.
- npm scripts `test:skill-sync`, `wbpp:find-masters`, `wbpp:clean`, `toolkit`.

### Fixed

- **`test/syntax.mjs` was never executed by `npm test`** although its own header claimed it
  was. It is now part of the chain, and it also checks every toolkit script under
  `lib/pixinsight-mcp/scripts/`, not just `agents/ops/`.
- **`sync-skill.mjs` reported phantom drift.** Editor backups and OS metadata
  (`.bak*`, `.tmp`, `.swp`, `~`, `.DS_Store`, `Thumbs.db`, `node_modules`) are excluded from
  the comparison — a stray `SKILL.md.bak-<date>` used to look like a changed file.
- **`sync-skill.mjs` exited 0 on drift** unless `--check` was passed, so a gate that forgot
  the flag went green while the copies disagreed. It now exits 1 whenever they differ.
- **`sync-skill.mjs` failed on a machine without a skill-root install.** A plugin-only
  install is legitimate; status/check now report "nothing to check" and exit 0. Copy modes
  still fail loudly when there is nothing to copy from.
- README `Layout` listed `scripts/` twice.

## [0.3.1] — 2026-10-22

Path hygiene: the docs no longer point at directories that may not exist, and the two
copies of the skill can no longer drift apart unnoticed.

### Added

- **`lib/pixinsight-mcp/scripts/resolve-toolkit.mjs`** — resolves the toolkit on *this*
  machine instead of assuming a layout. Probes `PIXINSIGHT_MCP_TOOLKIT`, then
  `%DSH_HOME%\pixinsight-mcp` (installed), then walks up for `<workspace>\tools\pixinsight-mcp`
  and `lib/pixinsight-mcp` (source tree), verifying each candidate by a fingerprint
  (`scripts/pi-tool.mjs` + `pjsr/pixinsight-mcp-watcher.js`). `--check` reports per-file
  presence; `--sub <path>` prints a concrete tool path; exits 1 when nothing is usable.
- **`scripts/sync-skill.mjs`** — compares the user skill root (`%DSH_HOME%\skills\...`)
  against the package copy and reports/repairs drift. Default is report-only; `--check`
  exits 1 on differences (CI-friendly); `--to-user` / `--to-package` copy one way;
  `--dry-run` previews; `--diff` shows a line-level diff.

### Changed

- All documentation paths (`SKILL.md`, `AGENTS.md`, `README.md`) now use `<toolkit>\...`
  with a Step 0 that resolves it, replacing `%DSH_HOME%\pixinsight-mcp\...` and
  `<plugin>\lib\pixinsight-mcp\...` placeholders that were dead on a source-tree machine.
- The two skill copies are re-merged and now in sync (14 files): the package copy's newer
  references (`pjsr-gotchas` 140→296 lines, `processing-knowledge`, ONBOARDING,
  director-flow, preflight, wbpp-automation) landed in the user copy, and the user copy's
  field-tested references (`layered-enhancement`, `narrowband-palette`, `support-weights`)
  landed in the package.

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
