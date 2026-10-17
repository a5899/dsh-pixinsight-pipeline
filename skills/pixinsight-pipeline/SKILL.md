---
name: pixinsight-pipeline
description: |
  Automated deep sky astrophotography processing with PixInsight. Use when processing
  astronomical images (nebulae, galaxies, star clusters) through the full pipeline:
  channel combination, calibration, stretching, Ha/narrowband injection, star handling,
  and final adjustments. Covers HaRGB, HaLRGB, and LRGB workflows. Drives PixInsight's
  PJSR scripting engine via a Node.js file-based IPC bridge. Adapted for DeepSeek Harness
  (DSH): DSH acts as the processing director, calling the bridge directly instead of
  spawning a Claude Code subprocess.
---

# PixInsight Deep Sky Pipeline (DSH-adapted)

## What this skill is

This skill lets the agent drive PixInsight to process calibrated linear masters into
publication-quality deep sky images. The mechanism is a **file-based IPC bridge**:

```
DSH/agent ── pi-tool.mjs ──> ~/.pixinsight-mcp/bridge/commands/{id}.json
                              (written by Node)
                                │
        PixInsight ── pixinsight-mcp-watcher.js (PJSR, poll loop)
                                │  reads command, runs PJSR, writes result
                                ▼
                        ~/.pixinsight-mcp/bridge/results/{id}.json
```

The **PixInsight-side watcher** (`pjsr/pixinsight-mcp-watcher.js`) runs inside PixInsight's
PJSR engine. The **Node-side CLI** (`scripts/pi-tool.mjs`) writes commands and polls results.
There is no socket/HTTP API for PixInsight — this file bridge is the only programmatic control.

This is a **DSH/Windows adaptation** of the upstream `aescaffre/pixinsight-mcp`. The upstream
"creative agent" (`giga-run.mjs`) spawns a Claude Code + Max subprocess, which DSH does not
have. Instead, **DSH is the creative director**: it reads this skill's processing order and
parameter guide, then drives each step via `pi-tool.mjs`.

## Installed components (this machine)

| Component | Path | Role |
|---|---|---|
| Pipeline skill | `~/.dsh/skills/pixinsight-pipeline/` | This file + `reference/` knowledge |
| Node bridge CLI | `%DSH_HOME%\pixinsight-mcp\scripts\pi-tool.mjs` | Writes/reads bridge files, runs tools |
| Bridge backend | `%DSH_HOME%\pixinsight-mcp\agents\ops\bridge.mjs` | createBridgeContext(), isAlive() (Windows-aware) |
| PJSR watcher | `%DSH_HOME%\pixinsight-mcp\pjsr\pixinsight-mcp-watcher.js` | Load in PixInsight (Script > Run Script) |
| Bridge dir | `~/.pixinsight-mcp/bridge/{commands,results,logs}` | Shared filesystem |

## DSH Quick Start

1. **Start PixInsight and load the watcher**
   - Open `%DSH_HOME%\pixinsight-mcp\pjsr\pixinsight-mcp-watcher.js` in PixInsight:
     `Script > Run Script File... > select pixinsight-mcp-watcher.js`.
   - Keep the PixInsight window open. The watcher logs `"PixInsight MCP Watcher v0.1.0"` and
     polls the bridge every ~1s. `Ctrl+F11` or a `shutdown` sentinel file stops it.
2. **Verify the bridge** (with PixInsight + watcher running):
   ```
   node "%DSH_HOME%\pixinsight-mcp\scripts\pi-tool.mjs" list_open_images '{}'
   ```
   A successful run prints a JSON array of open images. If `pi-tool` reports the PixInsight
   process not found, the watcher/process isn't up.
3. **Prepare data**: WBPP-stacked linear masters (`.xisf`) in one folder.
4. **Drive the pipeline**: use `pi-tool.mjs` per step, in the order below, using the
   parameter guide to set values. Example:
   ```
   node ...\pi-tool.mjs run_pixelmath '{"view_id":"RGB","expression":"$R","single_expression":true}'
   ```
5. **Iterate** on parameters, exporting `save_preview` after each step to review JPEGs.

### pi-tool.mjs tool map (subset that DSH uses most)

> **Passing args**: pi-tool takes JSON in `argv[3]`. Because shells (especially PowerShell)
> strip inner double quotes, prefer the `@<file>` form: write the JSON to a temp file and pass
> `@C:\path\args.json`. Example:
> ```
> node ...\pi-tool.mjs pjsr "@%TEMP%\piargs.json"
> ```
> where `piargs.json` contains e.g. `{"code":"JSON.stringify({ok:true})"}`.

| Tool | Typical args | Purpose |
|---|---|---|
| `pjsr` | `{"code":"..."}` | Run arbitrary PJSR (full control) |
| `list_open_images` | `{}` | List open views |
| `get_image_stats` | `{"view_id":"X"}` | median/MAD/min/max |
| `get_fits_keywords` | `{"view_id":"X"}` | FITS/XISF header keywords — read the real equipment |
| `run_pixelmath` / `run_pixelmath_rgb` | `{"view_id","expression",...}` | PixelMath |
| `run_nxt` / `run_bxt` (via pjsr) | `{"view_id","denoise"}` | NoiseX/BXT |
| `run_curves` | `{"view_id","channel","points"}` | Curves |
| `run_lhe` / `run_hdrmt` | `{"view_id",...}` | Detail enhancement |
| `create_luminance_mask` / `apply_mask` / `remove_mask` | | Masking |
| `star_screen_blend` / `stretch_stars` | | Star handling |
| `save_preview` | `{"view_id","label"}` | Export JPEG to `~/.pixinsight-mcp/previews/` |
| `save_variant` / `load_variant` / `list_variants` | | Save/restore XISF candidates |
| `get_image_stats` | | Post-step metrics |

## Auto-run WBPP (preprocessing, headless)

The first stage — turning raw frames into calibrated/registered/integrated masters — can be
automated too. PixInsight's **WeightedBatchPreprocessing** (WBPP) ships with a **CLI automation
mode** (`BPP-automation.js`). There is no need to drive calibration/registration/integration
step-by-step over the bridge; run the official WBPP engine headlessly:

```
"C:\Program Files\PixInsight\bin\PixInsight.exe" -n --automation-mode -r="<WBPP.js>,automationMode=true,dir=<inputDir>,outputDirectory=<outDir>,integrate=true,imageRegistration=true" --force-exit
```

where `<WBPP.js>` = `C:\Program Files\PixInsight\src\scripts\BatchPreprocessing\WBPP.js`.

A ready wrapper exists at
`%DSH_HOME%\pixinsight-mcp\run-wbpp.ps1`:
```
powershell -ExecutionPolicy Bypass -File ...\run-wbpp.ps1 -InputDir "<lights dir>" -OutputDir "<out dir>" [-ExtraParams "debayerOutputMethod=0"]
```

Useful automation params (lowercase, comma-separated inside the `-r` string):

| Parameter | Meaning |
|---|---|
| `automationMode=true` | Required; enables CLI mode |
| `dir=<path>` / `file=<path>` | Input frames (repeatable) |
| `outputDirectory=<path>` | Output dir |
| `integrate=true` | Run image integration |
| `imageRegistration=true` | Register frames to reference |
| `debayerOutputMethod=0/1/2` | 0=CombinedRGB, 1=SeparateChannels, 2=Both |
| `groupingKeywordsEnabled=true` | Group by FITS/FITS-like keywords (e.g., FILTER) |
| `subframeWeightingEnabled=true` | WBPP subframe weighting |
| `plateSolve=true` | Plate solving during registration |
| `frameSelection.FWHM.enabled=true,...` | Frame selection (e.g. FWHM < 3.5) |
| `reuseLastReferenceFrames` / `bestFrameReferenceMethod` | Reference frame selection |

Caveats:
- WBPP runs headlessly; progress goes to its console (not easily captured). Verify by checking
  files in `outputDirectory` after the run (masters, per-frame logs).
- Without calibration masters (bias/dark/flat) WBPP will still debayer + register + integrate;
  calibration is skipped.
- Don't run WBPP while the MCP watcher instance is running (a second PixInsight automation
  might conflict); stop the watcher first.
- Add at least a few lights to the input dir; WBPP needs a group of matching frames to stack.

## Pipeline Architecture

### Branches
| Branch | Label | Color | Forks After | Merges At |
|--------|-------|-------|-------------|-----------|
| `main` | RGB | blue | — | — |
| `stars` | Stars | yellow | `sxt` | `star_add` |
| `ha` | H-alpha | red | `combine_rgb` | `ha_inject` |
| `lum` | Luminance | purple | `sxt` | `lrgb_combine` |

### Standard Processing Order

**Pre-combination (Phase 0):**
0a. `gc_per_channel` — Per-channel GradientCorrection on R, G, B, L individually (`perChannel: true`). CRITICAL for LRGB — different channels have different gradients.
0b. `align` — StarAlignment (align G, B to R reference)

**Linear (on combined RGB composite):**
1. `combine_rgb` — PixelMath R/G/B into RGB, copy astrometry
2. `gc` — AutomaticBackgroundExtraction or GradientCorrection on combined image
3. `bxt_correct` — BlurXTerminator correctOnly (fix aberrations before calibration)
4. `plate_solve` — ImageSolver astrometry (needed for SPCC)
5. `spcc` — SpectrophotometricColorCalibration
6. `scnr` — Green cast removal
7. `bxt_sharpen` — BlurXTerminator sharpening pass
8. `nxt_pass1` — NoiseXTerminator linear denoise (moderate: 0.30)
9. `sxt` — StarXTerminator on linear (stars=true, NO unscreen)

**Stars branch (non-linear extraction):**
10. `star_stretch` — Load pre-SXT checkpoint, apply same HT+GHS, SXT with unscreen=true
11. `star_saturate` — CurvesTransformation S channel boost

**Ha branch:**
12. `ha_sxt` — StarXTerminator on linear Ha
13. `ha_stretch` — HT auto-stretch
14. `ha_curves` — Custom transfer curve
15. `ha_ghs` — GHS midtone/highlight control

**Luminance branch (if L data):**
16. `l_stretch` — HT auto-stretch
17. `l_nxt` — NoiseXTerminator denoise
18. `l_bxt` — BlurXTerminator sharpening (optional)

**Main stretch:**
19. `stretch` — HT auto-stretch + GHS refinement passes

**Non-linear processing:**
20. `nxt_pass2` — Post-stretch denoise (stronger: 0.50)
21. `curves_main` — Contrast S-curve + saturation
22. `ha_inject` — Three-part Ha injection with nebula mask
23. `lrgb_combine` — LRGBCombination (if L data; LinearFit L to RGB luminance first)
24. `lhe` — Local Histogram Equalization (tonal separation, with lum mask + maskGamma)
25. `lhe_fine` — LHE with smaller radius for micro-contrast (optional)
26. `hdrmt` — HDRMultiscaleTransform (core detail in bright regions, with lum mask + maskGamma)
27. `nxt_final` — Light denoise after LHE/HDRMT (0.30 — cleans amplified noise without over-smoothing)
28. `hue_boost` — Hue-selective saturation (blue spiral arms, pink HII regions; galaxies only)
29. `shadow_darken` — Gentle background darkening via lightness curve (galaxies only)
30. `channel_boost` — Per-channel color correction (filter-specific residual cast)
31. `curves_final` — Gentle lightness/saturation refinement
32. `star_add` — Screen blend stars back

### Key Techniques

**Non-linear star extraction** — Avoids halo bloating. Load pre-SXT checkpoint, apply identical
stretch (HT+GHS), then SXT with `unscreen=true`. Screen blend to recombine: `~(~$T*~(strength*stars))`.

**Ha injection (three-part with nebula mask):**
1. Conditional R-channel: `R + strength * max(0, Ha - threshold*R)` — adds Ha where it exceeds existing R
2. Luminance boost: LRGBCombination with Ha as luminance — transfers structural detail to all channels
3. Detail layer: `$T + detailStr * (Ha - GaussianBlur(Ha, sigma=15))` — color-neutral filament enhancement

**GHS via PixelMath** — The GHS process module (.dylib) is not installed. Use the PixelMath
fallback with `exp(exponent*ln(base))` (no `pow()` in PixelMath). See `reference/ghs-stretch.md`.

**Star Method: Linear Seti Stretch (Recommended)** — SXT on linear (`stars=true`), clip
pedestal, then N iterations of the Midtone Transfer Function `MTF(m,x)=(1-m)*x/((1-2m)*x+m)`,
then aggressive saturation boost, then add back at 100% (`screenBlend: false`). `setiMidtone`
0.20 with 5 iterations is a good start.

**Mask gamma compression** — Luminance masks for LHE/HDRMT on galaxies must use gamma compression
to prevent bright cores from saturating to 1.0 in the mask. Formula: `exp(gamma * ln(max(rescaled, 0.00001)))`.
LHE uses maskGamma=2.0, HDRMT uses maskGamma=1.5.

**Per-channel gradient correction** — Phase 0c applies GradientCorrection to R, G, B, L individually
before combination. Essential for LRGB where different filters/nights produce different gradient profiles.
Has baseline guard that reverts if GC makes any channel worse.

**HDR headroom** — Modified Seti Hermite HDR compress that caps maximum pixel value below 1.0.
Gives HDRMT working room in bright galaxy cores. L headroom=0.10, RGB headroom=0.05.

## Workflow selection

- **HaRGB** (no luminance): skip lum branch + `lrgb_combine`
- **HaLRGB** (with luminance): include lum branch + `lrgb_combine`
- **LRGB** (no Ha): skip Ha steps; auto-detect `hasHa`
- **RGB only** (no Ha, no L): skip Ha + lum branch steps

## Equipment — read it from the data, never hardcode

Every rig differs. Before SPCC / ImageSolver / channel-boost, read the actual acquisition
metadata from the input headers and configure from that:

- PI: `ImageWindow.windowById('<id>').keywords` (array of `{name, value}`), or
  `pi-tool get_fits_keywords '{"view_id":"<id>"}'`.
- Keywords to use: `INSTRUME`, `TELESCOP`, `FOCALLEN`, `APTDIA`, `XPIXSZ`/`YPIXSZ`,
  `BAYERPAT` (OSC), `FILTER`, `EXPTIME`, `DATE-OBS`, `IMAGETYP`.
- Derive: SPCC sensor QE + filter curves, and ImageSolver plate scale
  (≈ `206.265 * pixelSize_um / focal_mm` arcsec/px).
- If headers are absent (RAW before stacking), the WBPP master usually carries them; else
  ask the user — do not invent a profile.

## Parameter Tuning Guide

### Core Parameters
| What to adjust | Parameter | Range | Notes |
|----------------|-----------|-------|-------|
| Background brightness | `stretch.targetBg` | 0.10-0.25 | 0.10 for galaxies, 0.25 for nebulae |
| Ha strength | `ha_inject.injectionStrength` | 0.3-0.8 | Higher = more Ha in red channel |
| Ha structure | `ha_inject.detailLayer` | 0.3-0.7 | Higher = more filament detail |
| Ha luminance | `ha_inject.lumBoost` | 0.3-0.7 | Adds Ha brightness to all channels |
| Denoise (linear) | `nxt_pass1.denoise` | 0.2-0.5 | Don't over-denoise linear data |
| Denoise (non-linear) | `nxt_pass2.denoise` | 0.4-0.7 | Can be stronger post-stretch |
| Denoise (final) | `nxt_final.denoise` | 0.25-0.35 | 0.30 after LHE/HDRMT; 0.40 over-smooths recovered detail |
| Star sharpening | `bxt_sharpen.sharpenStars` | 0.1-0.5 | Subtle is better |
| Nebula sharpening | `bxt_sharpen.sharpenNonstellar` | 0.3-0.75 | Can be more aggressive |
| Halo reduction | `bxt_sharpen.adjustStarHalos` | -0.5 to 0 | 0.00 for galaxies (neg. causes ringing before SXT) |
| Seti midtone | `star_stretch.setiMidtone` | 0.15-0.25 | Lower = more aggressive stretch per iteration |
| Seti iterations | `star_stretch.setiIterations` | 3-7 | More = brighter faint stars |
| Star saturation | `star_saturate.starSaturationCurve` | curve points | Must be aggressive — Seti stretch desaturates |
| Star strength | `star_add.starStrength` | 1.0 | Use 1.0 with simple addition (screenBlend: false) |
| Green removal | `scnr.amount` | 0.2-0.5 | 0.35 is a good default |

### Gradient Correction
| What to adjust | Parameter | Range | Notes |
|----------------|-----------|-------|-------|
| Per-channel mode | `gc.perChannel` | true/false | **Always true for LRGB** — fixes per-channel color gradients that combined-image GC cannot |
| GC method | `gc.method` | "auto"/"abe"/"gc" | "auto" compares ABE vs GC and picks best |
| ABE polynomial | `gc.polyDegree` | 2-4 | 2-3 for galaxies (higher eats signal) |

### LHE / HDRMT Masks
| What to adjust | Parameter | Range | Notes |
|----------------|-----------|-------|-------|
| LHE tonal separation | `lhe.amount` | 0.25-0.50 | 0.25 edge-on, 0.35 face-on spirals, 0.50 nebulae |
| LHE contrast limit | `lhe.slopeLimit` | 1.3-2.0 | 1.3 edge-on, 1.5 face-on, 1.8 nebulae |
| LHE mask gamma | `lhe.maskGamma` | 1.5-2.5 | **2.0 for galaxies** — protects bright cores from flattening |
| HDRMT layers | `hdrmt.numberOfLayers` | 5-8 | 6 for L, 7 for RGB on spiral galaxies |
| HDRMT iterations | `hdrmt.numberOfIterations` | 1-4 | 3 for spirals, 1 for edge-on |
| HDRMT mask gamma | `hdrmt.maskGamma` | 1.0-2.0 | **1.5 for galaxies** — lighter than LHE (HDRMT has built-in lum mask) |
| HDRMT mask clip low | `hdrmt.maskClipLow` | 0.10-0.30 | 0.20 for L channel, 0.10 for main RGB |

### HDR Headroom
| What to adjust | Parameter | Range | Notes |
|----------------|-----------|-------|-------|
| L headroom | `l_stretch.hdrHeadroom` | 0-0.15 | 0.10 for galaxies — prevents core clipping before HDRMT |
| RGB headroom | `stretch.hdrHeadroom` | 0-0.10 | 0.05 for galaxies — less aggressive for color fidelity |

### Hue-Selective Saturation (hue_boost)
| What to adjust | Parameter | Range | Notes |
|----------------|-----------|-------|-------|
| Blue arm boost | `hue_boost.blueBoost` | 1.0-1.5 | 1.30 — enhances spiral arms |
| Pink HII boost | `hue_boost.pinkBoost` | 1.0-1.4 | 1.25 — enhances emission regions |
| Golden bulge | — | 1.0 (fixed) | Left untouched — already warm enough |

### Channel Color Correction
| What to adjust | Parameter | Range | Notes |
|----------------|-----------|-------|-------|
| G channel factor | `channel_boost.G` | 0.90-1.0 | 0.94 for some broadband filter sets — reduces green cast |
| B channel factor | `channel_boost.B` | 1.0-1.15 | 1.12 for some broadband filter sets — compensates blue deficit |

## Iteration Workflow — Required Artifacts

Every run MUST produce a complete artifact set in the target's `output/processed/` folder:

| Artifact | File | Purpose |
|----------|------|---------|
| **XISF** | `iteration_XX.xisf` | Full-resolution output |
| **JPEG preview** | `iteration_XX.jpg` | Quick visual review |
| **Config JSON** | `TargetName_vXX.json` | Exact parameters used (created before run) |
| **Iteration notes** | `iteration_XX.md` | Analysis, metrics, assessment, next steps |
| **Step previews** | `~/.pixinsight-mcp/previews/*.jpg` | Per-step JPEG exports |

Write `iteration_XX.md` **IMMEDIATELY** after each run (before any other work). Include config,
key changes table (with rationale), results (per-channel GC stats, stretch median/max, final
median), assessment (wins / problems / diagnosis), next steps (specific parameter changes).
Name configs `TargetName_vXX.json`; the config IS the reproducible recipe.

## Preview & Image Review Discipline (avoid "too many images")

> The DSH vision route caps the number of images allowed in a single request. Every
> `save_preview` export and every `read_image` you attach to the conversation stays in the
> session context and re-sends on later requests. Accumulating many previews is what caused
> `400 too many images in request`. Follow these rules to keep each request image-light.

1. **Prefer numbers over pixels.** Use `get_image_stats` (median/MAD/min/max) and the written
   `iteration_XX.md` notes to judge most steps. Only actually read a preview when you need a
   *visual* judgment (colors, star shapes, background gradients, halos) that a metric can't tell.
2. **Read only the essential images.** At minimum review the final `iteration_XX.jpg`; review a
   per-step preview only at decision points (e.g. after stretch, after Ha injection, before/after
   star recombine). Do **not** attach every `save_preview` you export.
3. **Read images one at a time, not in bulk.** If several previews genuinely need review, issue
   separate `read_image` calls / separate messages rather than stacking many image blocks into
   one request. Split a large review into a few small batches.
4. **Record what you saw.** After reading a preview, write the conclusion into the iteration
   notes and move on; don't keep re-reading the same image on later steps.
5. **Keep the session image pool bounded.** Read only the previews that drive the *current*
   decision. For long multi-iteration sessions, prefer continuing in a fresh session rather than
   letting previews pile up; offload/compress the context when you can.

## Common Issues

- **Stars have halos**: Avoid star erosion/threshold — use clean non-linear extraction instead
- **Over-processed look**: Reduce LHE amount, disable LHE fine and HDRMT, use gentler curves
- **Magenta/purple background**: SPCC issue — check sensor QE and filter profiles
- **PixInsight crash**: Check memory (warn at 8 GB). Close intermediate images aggressively.
- **ImageSolver not defined**: `#include` doesn't work inside `eval`/`run_script`. SPCC still works
  without plate solve if the master has WCS (WBPP writes WCS). If you must plate-solve, do it
  through a standalone ImageSolver run, not through `eval`.
- **Watcher won't load**: verify the AdP include paths in `pixinsight-mcp-watcher.js` point at
  `C:/Program Files/PixInsight/src/scripts/AdP/*` (this build already does).
- **`tasklist` returns nothing**: the PixInsight process must be running for `pi-tool` to talk to it.

## Reference Files

- [PJSR Process Parameters](reference/pjsr-processes.md) — LHE, HDRMT, MorphologicalTransformation, LRGBCombination, Convolution, SCNR
- [PJSR Gotchas](reference/pjsr-gotchas.md) — File I/O, eval quirks, crop masks, ECMAScript 5 constraints
- [Xterminator Tools](reference/xterminator-tools.md) — SXT, NXT, BXT parameter reference
- [GHS Stretch](reference/ghs-stretch.md) — GHS formula, PixelMath implementation, multi-pass strategy
- [Processing Knowledge](reference/processing-knowledge.md) — Equipment settings, quality assessment, lessons learned
- [Galaxy Cluster Processing](reference/galaxy-cluster-processing.md) — tiny-galaxy-specific approach

> **PJSR constraint**: ECMAScript 5 only — no `let`/`const`/arrow functions inside `pjsr` code.
> **PixelMath** has no `pow()` — use `exp(exponent*ln(base))`. **XISF crop_mask** windows open on
> load — close them immediately. Close images aggressively to manage memory.

## Credits

| Technique | Source |
|-----------|--------|
| Star Stretch (Seti/MTF method) | [Seti Astro](https://www.setiastro.com) — Bill Blanshan |
| Generalized Hyperbolic Stretch | [GHS Script](https://ghsastro.co.uk) — Mike Cranfield & Mark Shelley |
| Non-linear star extraction | PixInsight community technique |
| Screen blend recombination | Standard astrophotography: `1-(1-A)*(1-B)` |
| STF Auto-stretch | PixInsight built-in STF algorithm |
| Ha 3-part injection | Community narrowband techniques |

Upstream project: [aescaffre/pixinsight-mcp](https://github.com/aescaffre/pixinsight-mcp) (MIT).
