---
name: pixinsight-pipeline
description: |
  Automated deep sky astrophotography processing with PixInsight. Use when processing
  astronomical images (nebulae, galaxies, star clusters) through the full pipeline:
  channel combination, calibration, stretching, Ha/narrowband injection, star handling,
  and final adjustments. Covers the three director flows — A: mono narrowband (SHO/HOO),
  B: mono LRGB, C: one-shot colour (OSC, dual-band channel split) — plus per-stage
  acceptance gates (median/mean/MAD/min/max + STF preview), executable tool detection
  with native fallbacks, and interleaved denoise. Drives PixInsight's PJSR scripting
  engine via a Node.js file-based IPC bridge. Adapted for DeepSeek Harness (DSH):
  DSH acts as the processing director, calling the bridge directly instead of
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

0. **First run — pick a working directory (ask once)**
   Run `workspace_show '{}'`. If it reports `"first_use": true`, nothing has been
   chosen yet: ask the user where previews and intermediate files should live, then
   - `workspace_set` `{"path":"D:\\astro\\work"}` — their folder
   - `workspace_set` `{"path":"default"}` — keep `~/.pixinsight-mcp`

   Not answering is fine: processing continues in the default directory. The choice
   is stored in `~/.pixinsight-mcp/workspace.json` and read by every later command, so
   this question happens once per installation. `PIXINSIGHT_WORKSPACE` overrides it
   for a single session without writing anything. **Never prompt again** once
   `"first_use"` is `false`.
   See `reference/ONBOARDING.md` for the exact agent script.
1. **Start PixInsight and load the watcher**
   - Open `%DSH_HOME%\pixinsight-mcp\pjsr\pixinsight-mcp-watcher.js` in PixInsight:
     `Script > Run Script File... > select pixinsight-mcp-watcher.js`.
   - Keep the PixInsight window open. The watcher logs `"PixInsight MCP Watcher v0.2.0"` and
     polls the bridge every 250 ms. `Ctrl+F11` or a `shutdown` sentinel file stops it.
2. **Verify the bridge** (with PixInsight + watcher running):
   ```
   node "%DSH_HOME%\pixinsight-mcp\scripts\pi-tool.mjs" list_open_images '{}'
   ```
   A successful run prints a JSON array of open images. If `pi-tool` reports the PixInsight
   process not found, the watcher/process isn't up.
3. **Prepare data**: WBPP-stacked linear masters (`.xisf`) in one folder.
   There is no `open_image` command — open a file with
   `pjsr '{"code":"ImageWindow.open(\"C:/path/master.xisf\")[0].mainView.id"}'`.
3b. **Preflight the material — before the first process step.**
   Report these five findings to the user in a short table, and do not process
   silently past a fatal one (`reference/preflight.md`):

   | Check | How |
   |---|---|
   | Linear or already stretched? | `img.median() < 0.05` means linear |
   | Channel balance | per-channel background medians on a downscaled copy |
   | Is the target actually in frame? | MAD-normalised diagnostic stretch |
   | Do the flats match the lights? | compare `DATE-OBS`, look for dust rings |
   | Do headers agree with folders? | `IMAGETYP` decides WBPP grouping |

   Calibration frames shot on a different night, a target that never entered the
   frame, or heavily light-polluted data at short exposure **cannot be fixed in
   processing**. Say so and recommend re-acquiring, rather than delivering a
   polished image of artefacts.
4. **Drive the pipeline**: use `pi-tool.mjs` per step, in the order below, using the
   parameter guide to set values. Example:
   ```
   node ...\pi-tool.mjs run_pixelmath '{"view_id":"RGB","expression":"$R","single_expression":true}'
   ```
5. **Iterate** on parameters, exporting `save_preview` after each step to review JPEGs
   (they land in `<workspace>/previews`).

### pi-tool.mjs tool map

> **Passing args**: pi-tool takes JSON in `argv[3]`. Because shells (especially PowerShell)
> strip inner double quotes, prefer the `@<file>` form: write the JSON to a temp file and pass
> `@C:\path\args.json`. Example:
> ```
> node ...\pi-tool.mjs pjsr "@%TEMP%\piargs.json"
> ```
> where `piargs.json` contains e.g. `{"code":"JSON.stringify({ok:true})"}`.

**Capability detection (run this FIRST, every session):**

| Tool | Args | Purpose |
|---|---|---|
| `workspace_show` | `{}` | Where files go, whether it is writable, and `first_use` (ask the user only when true). |
| `workspace_set` | `{"path":"<dir>"\|"default"}` | Save the working directory; `default` forgets a previous choice. |
| `capability_report` | `{}` | Prints which of BXT/NXT/SXT/GC/MAS/GHS/NBN are installed and what each falls back to. **Start here** — the chosen path (three-piece suite vs native) changes every downstream parameter. |
| `detect_tools` | `{"force":false}` | Raw availability map for 33 known processes |
| `resolve_tool` | `{"group":"sharpen\|denoise\|starRemove\|background\|stretch\|narrowband\|colorCal"}` | Preference-ordered chain + which entry won |
| `has_tool` | `{"name":"BlurXTerminator"}` | Single-process probe |

**Acceptance / measurement (run after EVERY stage):**

| Tool | Args | Purpose |
|---|---|---|
| `get_image_stats` | `{"view_id":"X"}` | median / mean / MAD / min / max, per-channel for color. One round-trip per view: pixels are bulk-read and cached PI-side (resampled to 2000 px on the long edge for very large frames), so never loop this per channel from the agent. |
| `acceptance_check` | `{"view_id","phase":"linear\|nonlinear","stage":"..."}` | The full gate: background neutrality, highlight burn, black clip, MAD sanity, histogram gap. Returns `{pass, checks[], failures[], warnings[]}`. Add `"strict":true` for exit code 2 on failure. |
| `compute_stf` | `{"view_id","target_background":0.25}` | STF shadows/midtone/highlights for eyeball-equivalent preview |
| `measure_uniformity` | `{"view_id","sample_size":200}` | 4-corner gradient uniformity |
| `measure_noise` | `{"view_id"}` | Local σ, normalized noise score, verdict (clean/light/moderate/heavy) |
| `get_fits_keywords` | `{"view_id":"X"}` | Read the real rig — never hardcode equipment |

**Stretch family:**

| Tool | Args | Purpose |
|---|---|---|
| `mas_stretch` | `{"view_id","target_background":0.25,"shadow_lift":0.5,"highlight_protect":0.5}` | MAS when installed, else staged HT emulation |
| `ghs_stretch` | `{"view_id","D":0.5,"b":0.0,"SP":0.0,"LP":0.0,"HP":1.0,"use_native":false}` | GHS (native module or PixelMath fallback) |
| `staged_ht_stretch` | `{"view_id","target_background":0.25,"passes":4}` | Two-plus-stage HT — avoids histogram gaps |
| `channel_ht_stretch` | `{"view_id","channel":0\|1\|2\|null,"target_median":0.25}` | Per-channel HT (SHO channel balancing) |
| `arcsinh_stretch` | `{"view_id","stretch":10,"black_point":0}` | Arcsinh — preserves star colour |
| `seti_stretch` | `{"view_id","target_median":0.25}` | Seti statistical stretch |
| `linear_fit` | `{"reference_id","target_id"}` | LinearFit target → reference (channel levelling) |

**Narrowband:**

| Tool | Args | Purpose |
|---|---|---|
| `combine_sho` | `{"sii_id","ha_id","oiii_id","target_id"}` | ChannelCombination S/H/O → R/G/B |
| `dynamic_blend` | `{"rgb_id","sii_id","ha_id","oiii_id","weights":{...}}` | PixelMath dynamic mix. Default R=SII, G=0.8Ha+0.2OIII, B=OIII |
| `extract_clean_ha` | `{"ha_id","red_id","out_id","q":0.045}` | `Ha_clean = Ha − Q·(RGB_R − med(RGB_R))` |
| `search_clean_ha_q` | `{"ha_id","red_id","candidates":[0.02,…0.08]}` | Measures leakage per Q and recommends one — **do not guess Q** |
| `inject_ha` | `{"target_id","ha_clean_id","b":1.75,"blue_ratio":0.1,"mode":"rgb\|luminance"}` | R += B·(Ha_clean−med), B += B·ratio·(…) |
| `search_injection_b` | `{"target_id","ha_clean_id"}` | Picks the largest B that keeps max < 0.95 |
| `mix_oiii` | `{"source_id","out_id","g_weight":0.2,"b_weight":0.8}` | OIII from a dual-band composite |
| `extract_channel` | `{"source_id","out_id","channel":0}` | Split R/G/B out of a color view |

**Stars:**

| Tool | Args | Purpose |
|---|---|---|
| `separate_stars` | `{"source_id","starless_id","stars_id","tool":"StarXTerminator"}` | SXT, or native StarMask fallback (`"tool":"native"`) |
| `fix_star_color` | `{"view_id","amount":1.0}` | 去紫/去洋红: invert → SCNR → invert (no inverted mask) |
| `remove_green` | `{"view_id","amount":0.85}` | Plain SCNR on a composite |
| `shrink_stars` | `{"view_id","iterations":1,"size":5,"amount":0.5}` | MorphologicalTransformation erosion |
| `recombine_stars` | `{"starless_id","stars_id","out_id","strength":0.85,"method":"screen\|add\|max"}` | Recompose |
| `denoise_chroma` | `{"view_id","chroma_amount":0.6}` | ACDNR, chrominance only |

**Denoise (interleaved, never one big final pass):**

| Tool | Args | Purpose |
|---|---|---|
| `plan_denoise` | `{"view_id","phase":"linear\|nonlinear","purpose":"pre-mix\|post-split\|final\|rescue","starred":false}` | Measures then decides; returns `{needed, denoise, detail, reason}` without applying |
| `auto_denoise` | same + applies | Measure → plan → apply in one call |
| `apply_denoise` | `{"view_id","denoise":0.6,"detail":0.15}` | Force a specific strength |
| `run_nxt` | `{"view_id","denoise"}` | NXT, or TGVDenoise when NXT is absent (reports which) |
| `run_bxt` | `{"view_id","correct_only":true,"non_stellar":0.5,"stellar":0.2,"psf_fwhm":3.5}` | BXT, or Deconvolution RL when absent |

**Everything else:**

| Tool | Purpose |
|---|---|
| `pjsr` | Arbitrary PJSR |
| `list_open_images` / `clone_image` / `restore_from_clone` / `close_image` / `purge_undo` | Image management |
| `run_pixelmath` / `run_pixelmath_rgb` | Direct PixelMath |
| `run_curves` / `run_lhe` / `run_hdrmt` | Curves, LHE, HDRMT |
| `create_luminance_mask` / `apply_mask` / `remove_mask` / `close_mask` | Masking |
| `star_screen_blend` / `stretch_stars` | Legacy star helpers |
| `lrgb_combine` / `ha_inject_red` / `ha_inject_luminance` | Legacy combination helpers |
| `check_star_quality` / `check_ringing` / `check_sharpness` | Quality gates |
| `save_preview` / `save_variant` / `load_variant` / `list_variants` | Artifacts |

## Auto-run WBPP (preprocessing, headless)

The first stage — turning raw frames into calibrated/registered/integrated masters — can be
automated too. PixInsight's **WeightedBatchPreprocessing** (WBPP) ships with a **CLI automation
mode** (`BPP-automation.js`). There is no need to drive calibration/registration/integration
step-by-step over the bridge; run the official WBPP engine headlessly:

```
"C:\Program Files\PixInsight\bin\PixInsight.exe" -n --automation-mode -r="C:\pi_wbpp\BatchPreprocessing\WBPP.js,automationMode=true,dir=<inputDir>,outputDirectory=<outDir>" --force-exit
```

**Three things that must be right, or the run silently processes nothing:**

1. Every parameter goes **inside the quoted `-r=` string**, joined by commas — not
   as separate argv entries. Passed separately they are read as files to open, and
   the console fills with `No such file: .../automationMode=true`.
2. The whole `-r=...` value is wrapped in one pair of double quotes, because
   `C:\Program Files\PixInsight\...` contains a space.
3. `WBPP.js` itself must live at a **space-free** path. Copy
   `C:\Program Files\PixInsight\src\scripts\BatchPreprocessing\` to
   `C:\pi_wbpp\BatchPreprocessing\` first; the relative `#include`s resolve inside
   the copied folder.

Full failure catalogue and parameter list: [reference/wbpp-automation.md](reference/wbpp-automation.md).

A wrapper ships with the plugin at `scripts/run-wbpp.ps1`. It performs all three steps
above, verifies the inputs, and then reads the resulting log for the registration
failures that a "successful" run can hide:

```
powershell -ExecutionPolicy Bypass -File <plugin>\scripts\run-wbpp.ps1 `
  -InputDir "C:\data\lights","C:\data\calib" -OutputDir "C:\data\out" `
  [-ExtraParams "debayerOutputMethod=0,integrate=true"] [-StagingDir "C:\temp\pi_wbpp"]
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
| `generateRejectionMaps=false` | Skip rejection maps (large disk/time saving) |
| `frameSelection.FWHM.enabled=true,...` | Frame selection (e.g. FWHM < 3.5) |
| `reuseLastReferenceFrames` / `bestFrameReferenceMethod` | Reference frame selection |

Caveats:
- WBPP runs headlessly; progress goes to its console (not easily captured). Verify by checking
  files in `outputDirectory` after the run (masters, per-frame logs).
- **WBPP classifies frames by the FITS `IMAGETYP` header, not by folder name.** Confirm the
  log line `Group of N Light frames` reports the count you intended as lights. A set of bias
  frames whose header says `IMAGETYP='LIGHT'` will be filed as lights, and the group then dies
  with `RANSAC: Unable to find a valid set of star pair matches` /
  `Error: No image could be registered`. Check headers before every run.
- Calibration masters must match the lights in time and optics. A flat shot a month earlier
  leaves circular dust rings that cannot be processed away — see
  [reference/preflight.md](reference/preflight.md).
- Without calibration masters (bias/dark/flat) WBPP will still debayer + register + integrate;
  calibration is skipped.
- Don't run WBPP while the MCP watcher instance is running (a second PixInsight automation
  might conflict); stop the watcher first.
- Add at least a few lights to the input dir; WBPP needs a group of matching frames to stack.
- A run that reports completion can still have skipped a group. Always read the tail of
  `<outputDirectory>/logs/<timestamp>.log`.

## Role — you are the processing director

You are the PixInsight post-production director. Every frame is processed **inside** PixInsight
through the bridge; you never simulate a result and never report a metric you did not measure.

**Eight rules that hold for every flow:**

1. **Linear data is sacred.** While the image is still linear, do nothing that breaks the
   linear relationship: no heavy denoise, no non-affine transforms.
2. **Denoise opportunistically, never all at the end.** Noise that becomes visible mid-flow
   gets a gentle pass right there. One violent final denoise is a defect, not a shortcut.
3. **Sharpen before saturating.** Detail work comes before saturation, and if stars are
   removed, structural enhancement happens immediately after star removal.
4. **Accept every stage.** After each stage run `acceptance_check`, then export a preview.
   Report `median / mean / MAD / min / max` to the user.
5. **Never fabricate.** If a measurement fails, say so. If a parameter is a guess, say it is
   a guess and give the alternative.
6. **Ask on anomalies.** When a check fails, tell the user and offer one or two alternative
   parameter sets rather than silently pushing on.
7. **Colour in SHO / OSC is art.** Chase contrast and structural legibility, not colour
   fidelity. Channel substitution and dynamic blending are allowed and encouraged.
8. **Detect tools first.** `capability_report` at session start; the whole parameter set
   differs depending on whether BXT/NXT/SXT are installed.

### Tool priority — three-piece suite vs native

| Goal | Preferred (RC Astro) | Native substitute |
|---|---|---|
| Deconvolution / sharpening | BlurXTerminator | Deconvolution (needs PSF + star mask, rings easily, slow) |
| Denoise | NoiseXTerminator | TGVDenoise + MultiscaleMedianTransform |
| Star removal | StarXTerminator | StarNet2 / StarNet / StarMask |
| Background / gradient | GradientCorrection → MGC → GraXpert → DBE | DBE (evaluate in that order) |
| Stretch | MAS → GHS | HistogramTransformation / ArcsinhStretch |
| Narrowband colour | NarrowbandNormalization | manual PixelMath dynamic mix |
| OSC chroma noise | — | ACDNR (chroma only), after combination, before NXT |

> **Detection is executable, not assumed.** `capability_report` instantiates each target
> process inside `try/catch`; a missing module is a boolean, not an exception. `run_nxt`,
> `run_bxt`, and `separate_stars` each consult it and report which path they actually took.

---

## Choose the flow

Ask (or read from headers) which of the three branch applies:

| Data | Flow | Section |
|---|---|---|
| Mono + SHO / HOO / false-colour narrowband filters | **A** — narrowband emission nebula | Flow A |
| Mono + LRGB broadband (galaxies, reflection nebulae) | **B** — LRGB | Flow B |
| One-shot colour (OSC), incl. dual-band and channel-split | **C** — OSC | Flow C |

Flow C1/C2/C3 are variants of C. C2 (dual-band → true Hubble palette) rejoins Flow A after
the channels are built.

---

## Flow A — Mono narrowband (SHO / HOO / false SOO), emission nebulae

### A.1 Linear stage — clean the data

1. **Crop + align.** `StarAlignment` S/H/O onto one reference, then `DynamicCrop` with the
   *same* rectangle for all three. Different crop boxes poison the later background model.
2. **Background calibration — per channel, one at a time.** Evaluate `GradientCorrection` →
   MGC → GraXpert → DBE in that order and keep the best result. DBE sample points must avoid
   both nebulosity and stars; for a full-frame SHO target use few, carefully placed samples.
   **Verify the sample set separately for each of the three frames** — their structure differs.
3. **Sharpen / repair (BXT).**
   - Pass 1: `correct_only:true` (aberration repair only).
   - Pass 2: `correct_only:false`, `stellar ≈ 0.2–0.3`, `non_stellar ≈ 0.6–0.8`.
   - High-SNR data tolerates more. Without BXT, use `Deconvolution` and then
     `check_ringing` — RL deconvolution rings on this data if pushed.
4. **Gentle linear denoise.** `auto_denoise {"phase":"linear","purpose":"pre-mix"}` on each of
   S/H/O. With NXT present this lands at `denoise ≈ 0.5–0.7`, `detail 0.15` when the frame is
   noisy and skips entirely when it is already clean. Keep the grain; plastic is worse than noise.
5. **Channel levelling.** `linear_fit` with **Ha as the reference** (strongest signal,
   best SNR), applied to SII and OIII so all three sit at the same brightness scale.

### A.2 Nonlinear stretch + colour synthesis

6. **Stretch.** Either per-channel HT (`channel_ht_stretch`, one channel at a time) when you
   want independent control, or `mas_stretch` / `ghs_stretch` for layered results.
   - **Per-channel HT recipe:** put the Ha peak in the middle of the range first, then bring
     OIII and SII to match Ha's background and main-structure brightness.
   - SII has the worst SNR: stretch it weakly, `auto_denoise` it (purpose `rescue`), then
     finish the stretch. Do not stretch SII hard on the first pass.
   - Optional: Starless plate via GHS, Stars via HT / `arcsinh_stretch`.
7. **Combine.** `combine_sho` → ChannelCombination S,H,O → R,G,B. A wall of green right after
   combination is normal (Ha dominates); do not panic-correct it yet.
8. **Advanced dynamic mix** (`dynamic_blend`, per-channel PixelMath):
   ```
   R: SII
   G: 0.8*Ha + 0.2*OIII     # a little OIII pushes green toward cyan
   B: OIII
   ```
   Weights are adjustable. `dynamic_blend` normalises the weights so they behave as mixing
   fractions.
9. **Background neutralisation.** Find a clean background patch, read its RGB, and set
   `BackgroundNeutralization` **Upper limit** slightly above the largest of those three
   numbers. Do **not** run star-referenced colour calibration in the nonlinear stage.
   With no colour reference, neutralise against the narrowband channels' own background.
10. **Star separation.** `separate_stars` → Starless + Stars. From here on, **every
    structural enhancement happens on the Starless plate** and may be aggressive.
11. **Colour — build the gold/blue.**
    - Preferred: NarrowbandNormalization when installed. Remove green *moderately* — stripping
      it entirely creates banding and an unnatural look.
    - Manual: pull R/G/B curves with an anchor pinned at the background brightness so the
      background does not drift.
    - **Forbidden:** brute-force SCNR plus violent selective-colour shifts. That combination
      produces hard yellow/blue banding and yellow blotches. Keep a thin cyan transition at
      the yellow/blue boundary.
    - Heavy chroma noise: `denoise_chroma` (ACDNR, chroma only) **before** NXT.
12. **Structural enhancement on the starless plate.**
    - LHE in two tiers: `radius 64, amount 0.2` (large scale) → `radius 16, amount 0.15` (fine).
    - `DarkStructureEnhance` (script) deepens dust lanes where applicable.
    - Final cleanup: one more very light NXT if the background still shows noise.
13. **Stars.**
    - SHO stars usually come out magenta from unequal channel contribution. A quick fix:
      **invert → SCNR remove green → invert** (`fix_star_color`). Do not use an inverted *mask*.
    - Halo removal on the Stars plate uses the same invert/SCNR/invert.
    - Maintenance: a saturation boost via Curves, and
      `shrink_stars` (MorphologicalTransformation, mild) so the nebula leads.
14. **Recombine.** `recombine_stars` (screen blend by default).
15. **Output.** Final light `auto_denoise {"purpose":"final"}`, optional HT to darken the
    background a touch, then save **XISF (16-bit, full resolution) + JPG**.

---

## Flow B — Mono camera LRGB (galaxies, reflection nebulae)

### B.1 Linear

1. **Background** — DBE (or GC/MGC) on L, R, G, B **separately**. L and RGB differ in
   resolution and SNR, so their parameters must be tried independently.
2. **Brightness matching** — `linear_fit` with **L as the reference**, applied to R, G, B.
3. **Combine** — ChannelCombination R,G,B → RGB.
4. **Colour calibration — SPCC.** Pick the R/G/B reference curves for the actual filters.
   Requires the Gaia DR3/SP database configured. SPCC fixes the brown cast and the
   anomalous purple stars.
5. **Initial sharpening (BXT)** on RGB: `non_stellar ≈ 0.9`, `stellar ≈ 0.2`, Automatic PSF.
   This tightens galaxy detail and shrinks oversized stars.
6. **Denoise** — `auto_denoise` on RGB and on L separately (`phase:"linear"`), again gentle.

### B.2 Stretch + LRGB fusion

7. **Stretch RGB** with `mas_stretch` or `ghs_stretch`, protecting the highlights.
8. **Stretch L** — BXT-recover fine bright detail first, then `seti_stretch` / GHS / MAS to
   the same brightness level as RGB. For the L channel `arcsinh_stretch` keeps star colour.
9. **LRGB fusion** — convert L to RGB colour, then `Scripts > Utilities > Image Blend`:
   - L is the **Base**, RGB is the **Blend**, mode **Color**.
   - Adjust Black Point and Midtones so detail emerges without washing the background white.

### B.3 Star separation + starless refinement

10. **`separate_stars`** → Starless + Stars.
11. **Blemish repair** — `CloneStamp` over satellite trails (brush ≈ 50, Ctrl-sample the
    background, keep off galaxy detail).
12. **Core HDR** — when the core is blown white use `Toolbox > Create HDR Image` with ~4
    layers and moderate darkening to recover core structure. Higher output gain removes
    the blown void.
13. **Local saturation** — build a `RangeSelection` mask (tune Lower limit + Smoothness so
    only the galaxy body is selected), then with the mask active raise saturation via the
    S curve in `CurvesTransformation`; small R/G/B tweaks (e.g. a little blue-violet) are
    fine. Stop before colour blotches appear.
14. **Second sharpening on Starless** — BXT again with `stellar: 0`, Auto PSF off, manual
    FWHM (e.g. 3.5), `non_stellar ≈ 0.5`, to squeeze out dust-lane detail.

### B.4 Stars + output

15. **Star colour** — plain `remove_green` first (there are no green stars), then
    `fix_star_color` for magenta/violet halos on bright stars.
16. **Recombine** — `recombine_stars`.
17. **Final denoise** — `auto_denoise {"phase":"nonlinear","purpose":"final"}`; with NXT
    present, push Denoise Color up and keep `denoise ≈ 0.85` only for the colour component;
    verify in the live preview.
18. **Final** — HT darkening of the background for contrast, then save XISF + JPG.

---

## Flow C — One-shot colour (OSC), incl. smart telescopes

### C1 — generic OSC, with optional HaRGB hydrogen injection

**Preconditions:** RGB is cropped, DBE'd, colour-balanced, **still linear**. Ha is cropped
and DBE'd, **still linear**.

**Verify "still linear" before anything else.** Some WBPP masters come out already
stretched (median ≈ 0.2–0.35 instead of ≈ 0.001–0.02). If
`img.median() >= 0.05`, the frame is non-linear: skip the linear stage entirely
(no BXT/NXT/SPCC on it), start from gradient removal, and treat every subsequent
parameter as a non-linear value. Stretching non-linear data again washes the image out
and makes all the linear-stage numbers meaningless.

**Colour deficits live in the input, not in the pipeline.** On a heavily
light-polluted OSC frame the background channel ratio can be far from 1:1:1
(e.g. 0.79 : 1.0 : 0.56). Do not fight this by neutralising towards a region that is
not background — on a nebula field most of the frame *is* nebulosity, and forcing it
neutral destroys the colour the target is known for. Measure per-channel means on a
genuinely empty patch, correct with explicit channel ratios, and leave the subject's
colour alone.

1. **Extract the red channel** — `extract_channel {"channel":0}` on RGB.
2. **Star removal** — `separate_stars` on both RGB_R and Ha, giving two starless plates.
3. **Extract clean Ha** — `extract_clean_ha`:
   ```
   Ha_clean = Ha − Q·(RGB_R − med(RGB_R))
   ```
   **Q is per-image — never use the default blindly.** Run `search_clean_ha_q` with
   candidates `[0.02, 0.03, 0.045, 0.06, 0.08]`; it measures continuum leakage per candidate
   and recommends the smallest-leak Q that still retains ≥ 60 % of the Ha mean.
   Symptoms: Q too large → Ha loses its own structure; Q too small → continuum leaks through.
4. **Inject Ha into RGB** (`inject_ha`, three separate channel expressions):
   ```
   R: $T + B*(Ha_clean − med(Ha_clean))
   G: $T
   B: $T + B*0.1*(Ha_clean − med(Ha_clean))
   ```
   `B ≈ 1.75` is the starting point. `search_injection_b` picks the largest B that keeps
   `max < 0.95`. **Both B and the 0.1 blue coefficient are experimental.**
   Not every target wants blue-channel Ha — for M82 that turns the emission regions purple.
   The output window must be the open RGB image.
5. **Small green-flower correction** — when HII/OIII regions look green in RGB, image an OIII
   channel and inject it the same way, except you subtract from the **G+B composite** rather
   than from red.
6. **L also gets Ha** — if you also shot L with a mono camera, apply the same formula with
   `mode:"luminance"` and tune B.
7. Continue with Flow B's nonlinear / star / recombination stages.

### C2 — Smart telescope / dual-band → true Hubble palette (SHO channel split)

Requires externally-shot SO and HO filters (or an in-scope dual-band carrying Ha/OIII plus an
SO filter to fill in SII).

1. **Import / align / remove stars.** HO stack + SO stack → `StarAlignment` align →
   `separate_stars` on each → `auto_denoise` both starless plates hard (`purpose:"rescue"`).
2. **Split HO channels.** `extract_channel` R (this is Ha), then `mix_oiii` with
   `g_weight 0.2, b_weight 0.8` to build `OIII_HO`.
3. **Split SO channels.** R is SII; `mix_oiii` with `g_weight 0.8, b_weight 0.2` to build
   `OIII_S`.
4. **Stack the OIII channels.** `ImageIntegration` over `OIII_HO` and `OIII_S`
   (add each at least once; three or more copies is better) for a higher-SNR OIII.
5. **Stretch** SII / Ha / OIII separately until their brightness ranges match.
6. **Combine** `combine_sho` → R=SII, G=Ha, B=OIII, then optionally Flow A's `dynamic_blend`.
7. Denoise before colour work, attach stars, output.

This mapping matches the actual element distribution — it is the real Hubble palette, and it
is the advanced path.

### C3 — OSC quick pass (minimal channel surgery)

On a single colour RGB: SCNR green → SPCC (if Gaia is configured) →
`run_bxt {"non_stellar":0.9,"stellar":0.2}` → `mas_stretch`/`ghs_stretch` →
`separate_stars` → on Starless `run_lhe` twice (`64/0.2` then `16/0.15`) and `auto_denoise` →
Stars `remove_green` + `fix_star_color` → `recombine_stars` →
`auto_denoise {"purpose":"final"}` + HT darkening → output.

---

## Stage acceptance checklist

After **every** stage, run at least one of these and report the numbers:

| Check | How | Fail condition |
|---|---|---|
| **Background neutrality** | `acceptance_check` → `background_neutral` | channel median spread > 0.02 (linear) / 0.03 (nonlinear) |
| **Linearity preserved** | `acceptance_check` → `noise_sane` + visual | blotchy/plastic patches, `MAD` at 0 |
| **No clipped stretch** | `acceptance_check` → `no_black_clip`, `no_highlight_burn` | histogram's left foot severed; `max` hits 1.0 early |
| **No banding / gaps** | `acceptance_check` → `no_histogram_gap` | longest empty bin run > 5 % of range |
| **Colour boundaries** | visual preview | yellow/blue splits, yellow blotches; cyan transition missing |
| **Stars** | `check_star_quality` | green stars; magenta/violet halos; stars oversized and dominating |
| **Noise** | `measure_noise` | visible chroma blotches; "plastic" look |

When `acceptance_check` fails it returns `failures[]` naming the exact remediation — apply it
or offer the user the alternative before continuing.

## Reporting — after every stage

Tell the user:

1. **Tool + parameters actually used** (including which tool the fallback selected).
2. **STF view** — export via `save_preview` and state what you saw, or `compute_stf` numbers.
3. **Statistics** — `median / mean / MAD / min / max` plus the per-channel values for colour.
4. **Acceptance verdict** — pass or the specific failures.

When something is anomalous, ask whether the user accepts the current setting or prefers one
of one or two alternative parameter sets.

Final delivery: **XISF (16-bit, full resolution)** + **JPG preview** + the recipe (every
parameter, in order).

---

## Legacy branch model (kept for reference)

The original flow branches remain available through the low-level tools
(`lrgb_combine`, `ha_inject_red`, `ha_inject_luminance`, `star_screen_blend`).
They are still useful for HaRGB/HaLRGB, but the three flows above are the
default path and supersede them for parameter selection.

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

**Per-channel gradient correction** — Apply GradientCorrection to R, G, B, L individually
before combination. Essential for LRGB where different filters/nights produce different gradient profiles.
Has baseline guard that reverts if GC makes any channel worse.

**HDR headroom** — Modified Seti Hermite HDR compress that caps maximum pixel value below 1.0.
Gives HDRMT working room in bright galaxy cores. L headroom=0.10, RGB headroom=0.05.

## Parameter Tuning Guide

### Stretch
| What to adjust | Tool + parameter | Range | Notes |
|---|---|---|---|
| Background brightness | `mas_stretch.target_background` | 0.10–0.25 | 0.10 galaxies, 0.25 nebulae |
| Shadow lift | `mas_stretch.shadow_lift` | 0.3–0.7 | higher lifts faint structure |
| Highlight protection | `mas_stretch.highlight_protect` | 0.3–0.8 | raise when the core burns |
| GHS stretch factor | `ghs_stretch.D` | 0.2–1.5 | linear-units stretch amount |
| GHS symmetry point | `ghs_stretch.SP` | 0.0–0.5 | where the curve pivots |
| HT staging | `staged_ht_stretch.passes` | 3–6 | more passes = fewer histogram gaps |
| Arcsinh strength | `arcsinh_stretch.stretch` | 5–50 | star-plate / L-channel colour keeper |

### Denoise (interleaved)
| Stage | Tool | Range | Notes |
|---|---|---|---|
| Linear, pre-mix | `auto_denoise {"phase":"linear"}` | 0.50–0.70, detail 0.15 | keep grain, never plastic |
| Nonlinear, post-split | `auto_denoise {"phase":"nonlinear","purpose":"post-split"}` | 0.25–0.45 | starless plate tolerates more |
| Final cleanup | `auto_denoise {"purpose":"final"}` | 0.15–0.30 | only if noise came back |
| Rescue (SII, dual-band) | `auto_denoise {"purpose":"rescue"}` | up to cap | weak-SNR channels only |
| Chroma only | `denoise_chroma` | amountC 0.4–0.8 | before NXT when chroma noise is heavy |

`auto_denoise` measures first and refuses to run on a clean frame — that refusal is correct
behaviour, not an error.

### Narrowband / Ha injection
| What to adjust | Tool + parameter | Range | Notes |
|---|---|---|---|
| B channel mix (SHO) | `dynamic_blend.weights.gO3` | 0.1–0.3 | 0.2 is the gold/blue starting point |
| Ha continuum removal | `search_clean_ha_q` → `q` | 0.02–0.08 | **measured, never assumed**; 0.045 typical |
| Ha injection strength | `search_injection_b` → `b` | 1.0–2.5 | largest B that keeps max < 0.95 |
| Ha in blue | `inject_ha.blue_ratio` | 0.0–0.2 | 0.1 typical; **0 for M82** (avoids purple) |
| OIII from HO stack | `mix_oiii.g_weight` | 0.2 (HO) / 0.8 (SO) | weights flip per filter set |

### Sharpening
| What to adjust | Tool + parameter | Range | Notes |
|---|---|---|---|
| Aberration-only pass | `run_bxt {"correct_only":true}` | pass 1 | always do this first |
| Star sharpening | `run_bxt.stellar` | 0.1–0.5 | subtle is better |
| Nebula sharpening | `run_bxt.non_stellar` | 0.3–0.9 | galaxies tolerate more |
| Halo reduction | `run_bxt.adjust_halos` | -0.5–0.0 | 0.0 for galaxies (negative rings pre-SXT) |
| Starless pass | `run_bxt {"stellar":0,"psf_fwhm":3.5}` | manual FWHM | Auto PSF off on starless plates |

### Gradient Correction
| What to adjust | Parameter | Range | Notes |
|---|---|---|---|
| Per-channel mode | per-channel GC | always for LRGB | separate gradient profiles per filter/night |
| GC order | GC → MGC → GraXpert → DBE | evaluate in order | keep the best result per channel |
| ABE polynomial | `gc.polyDegree` | 2–4 | 2–3 galaxies (higher eats signal) |

### LHE / HDRMT Masks
| What to adjust | Parameter | Range | Notes |
|---|---|---|---|
| LHE tonal separation | `lhe.amount` | 0.15–0.50 | two tiers: 64/0.2 then 16/0.15 |
| LHE contrast limit | `lhe.slopeLimit` | 1.3–2.0 | 1.3 edge-on, 1.5 face-on, 1.8 nebulae |
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

- **The subject is invisible / "the data is empty"**: compute a MAD-normalised diagnostic
  stretch before concluding anything — `(v − median) * (0.05 / MAD) + 0.5`. Light-polluted
  data often does contain the target, sitting only a few percent above the sky background.
  Resolve whether to fight for the signal or report it as unprocessable; do not guess from a
  normal preview.
- **Colour correction made things worse**: a neutralised background can look worse than the
  original cast if the reference region was not actually background. Always re-measure the
  three channel means straight after, and compare against the previous step. A stage that
  reports success but moves the ratio the wrong way must be rolled back, not compensated for
  downstream.
- **Whole frame went solid red (or another single colour) after a histogram step**: the
  `HistogramTransformation.H` array was malformed. It must be five arrays
  `[blackPoint, midtones, whitePoint, lowClip, highClip]` for R, G, B, L, Alpha. This does
  not throw — roll back to the last checkpoint and rebuild it.
- **A "crop" step reported success but the image is unchanged**: `img.crop(x0,y0,x1,y1)` is a
  silent no-op. Use `img.crop([x0, y0, x1, y1])`.
- **`File.size is not a function` mid-script**: several `File` members do not exist. Re-run with
  the call removed; if a save already happened before the throw, do not save it twice — check
  the file on disk first. See `reference/pjsr-gotchas.md`.
- **Round dust rings / "doughnuts" across the field**: the master flat does not match the
  lights (different night, different optics or focus position). Not removable by processing —
  report it and recommend new flats.
- **WBPP reports completion but nothing was integrated**: read the tail of
  `<out>/logs/<timestamp>.log`. `RANSAC: Unable to find a valid set of star pair matches` plus
  `No image could be registered` means the group contains unalignable frames — usually wrong
  `IMAGETYP` headers filing calibration frames as lights.
- **WBPP GUI opens with empty lists / parameters were ignored**: the command line was split
  incorrectly. All parameters belong inside the single quoted `-r=` value, comma-separated,
  and `WBPP.js` must be at a space-free path.
- **Stars have halos**: Avoid star erosion/threshold — use clean non-linear extraction instead
- **Over-processed look**: Reduce LHE amount, disable LHE fine and HDRMT, use gentler curves
- **Magenta/purple background**: SPCC issue — check sensor QE and filter profiles
- **PixInsight crash**: Check memory (warn at 8 GB). Close intermediate images aggressively.
- **ImageSolver not defined**: `#include` doesn't work inside `eval`/`run_script`. SPCC still works
  without plate solve if the master has WCS (WBPP writes WCS). If you must plate-solve, do it
  through a standalone ImageSolver run, not through `eval`.
- **Watcher won't load**: verify the AdP include paths in `pixinsight-mcp-watcher.js` point at
  `C:/Program Files/PixInsight/src/scripts/AdP/*` (this build already does). Launch it with
  `PixInsight.exe -n --automation-mode -r=<q-script> <q-script>`; the `-r=` flag is the reliable
  path (`--run` does not always load the file).
- **Console floods with `already answered … retrying until released`**: Node still holds the
  command file open. Harmless — the watcher retires it as soon as the lock clears and never
  re-executes that command.
- **Watcher refuses to start / `File.searchDirectory is not a function`**: `searchDirectory` is a
  global PJSR function, not a `File` method. A stale build with `File.searchDirectory` dies on the
  first poll while the heartbeat keeps ticking, which looks like "the watcher is alive but idle".
- **`tasklist` returns nothing**: the PixInsight process must be running for `pi-tool` to talk to it.

## Reference Files

- [Onboarding](reference/ONBOARDING.md) — first-run working-directory question, what to say, how to reset
- [Preflight](reference/preflight.md) — verify the material before processing; what cannot be fixed later
- [WBPP Automation](reference/wbpp-automation.md) — the exact working command line, every failure variant, header-based grouping traps
- [Director Flow](reference/director-flow.md) — **exact call sheet** per flow (A / B / C1 / C2), acceptance thresholds, denoise policy, reporting template
- [PJSR Process Parameters](reference/pjsr-processes.md) — LHE, HDRMT, MorphologicalTransformation, LRGBCombination, Convolution, SCNR
- [PJSR Gotchas](reference/pjsr-gotchas.md) — File I/O members that do not exist, `Image.crop` array form, statistics Rect signature, `HistogramTransformation.H` layout, PixelMath channel names, ECMAScript 5 constraints
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
