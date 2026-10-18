# Director Prompt v1 — machine-readable quick sheet

This is the condensed, executable form of the deep-sky post-production director brief.
`SKILL.md` carries the narrative; this file carries the exact call shapes and thresholds so a
step can be issued without re-reading the whole skill.

## Rule zero — detect before you plan

```
pi-tool workspace_show '{}'      # first_use:true -> ask once, see ONBOARDING.md
pi-tool capability_report '{}'
```

Output tells you which of BXT / NXT / SXT / GC / MGC / GraXpert / MAS / GHS /
NarrowbandNormalization are present, and what each missing one falls back to.
**Every downstream parameter depends on this answer.** Re-run with `{"force":true}` only when
the user installs a module mid-session.

## Rule zero-B — preflight the material, then branch on linearity

Before the first processing stage, run the preflight table in
[preflight.md](preflight.md) and report it. The single most consequential line:

```javascript
var linear = (img.median() < 0.05);
```

| Result | What it changes |
|---|---|
| linear (`median` ≈ 0.001–0.02) | run the flow as written; linear-stage BXT/NXT/SPCC apply |
| **already stretched** (`median` ≈ 0.2–0.35, `max` ≈ 0.95) | **skip the entire linear stage**; start at gradient removal; treat every parameter as non-linear |

Stretching an already-stretched master a second time washes the image out and makes all
linear-stage numbers meaningless. Confirm linearity before choosing a flow — a WBPP master
that was saved after an STF stretch is not linear, and nothing in its filename says so.

If the preflight finds a fatal material problem — flats from a different night, the target never
in frame, headers that will mis-group in WBPP — **say so and stop**. Report it instead of
processing artefacts into a polished image.

## Flows that are really galaxies (M81/M82, M31, M33)

Galaxies are not processed like emission nebulae, and low-contrast galaxy data has its own
failure mode: the galaxy is present but only a few percent above the sky background, so every
ordinary preview looks empty. Two consequences:

1. **Establish that the target is there before judging quality.** Use the MAD-normalised
   diagnostic stretch (`(v − median) * (0.05 / MAD) + 0.5`) once. It is a diagnostic, never a
   deliverable.
2. **Do not solve a low-contrast galaxy with global stretching alone.** Global stretch lifts the
   sky as fast as the galaxy. Local contrast (LHE) and gradient removal are what make the
   structure readable; if the sky background is very bright, the honest outcome may be "the
   exposure is too short for this target" — say that rather than over-processing.

## Stage loop — the same five calls, every stage

```
1. <the processing call>
2. pi-tool acceptance_check '{"view_id":"X","phase":"linear|nonlinear","stage":"A.4 linear denoise"}'
3. pi-tool compute_stf      '{"view_id":"X","target_background":0.25}'
4. pi-tool save_preview     '{"view_id":"X","label":"A04_linear_denoise"}'
5. report: tool + params, STF values, median/mean/MAD/min/max, pass|failures
```

`acceptance_check` exits with code 2 under `"strict":true` when it fails — usable as a gate in
a script.

**Round-trip budget.** PixInsight-side statistics are batched, not looped: one `get_image_stats`
call returns the whole frame's median/mean/MAD/min/max *and* every channel's median/MAD/mean from
a single bulk pixel read. Never issue per-channel stats calls from the agent, and never re-measure
a view you just measured — the bridge caches the pixel planes per view (resampled to 2000 px on the
long edge when larger) and the cache is dropped by any process that writes through the bridge.

## Thresholds enforced by `acceptance_check`

| Check | Metric | Limit |
|---|---|---|
| `background_neutral` | spread of the three channel medians | ≤ 0.02 linear / ≤ 0.03 nonlinear |
| `no_highlight_burn` | `max()` | < 0.9995 |
| `no_black_clip` | `min()` | > 0.0 (warning only — minor clipping is normal post-stretch) |
| `noise_sane` | `MAD()` | > 1e-7 |
| `no_histogram_gap` | longest empty run of 256 bins | ≤ 5 % of the occupied range |
| `stf_preview` | report only | — |

Override per call: `max_channel_spread`, `burn_threshold`, `clip_threshold`.

## Flow A — narrowband (exact calls)

```
# linear
pi-tool linear_fit          '{"reference_id":"Ha","target_id":"SII"}'
pi-tool linear_fit          '{"reference_id":"Ha","target_id":"OIII"}'
pi-tool run_bxt             '{"view_id":"Ha","correct_only":true}'
pi-tool auto_denoise        '{"view_id":"Ha","phase":"linear","purpose":"pre-mix"}'

# stretch + colour
pi-tool channel_ht_stretch  '{"view_id":"Ha","target_median":0.25}'
pi-tool combine_sho         '{"sii_id":"SII","ha_id":"Ha","oiii_id":"OIII","target_id":"SHO"}'
pi-tool dynamic_blend       '{"rgb_id":"SHO","sii_id":"SII","ha_id":"Ha","oiii_id":"OIII",
                              "weights":{"gHa":0.8,"gO3":0.2}}'
pi-tool separate_stars      '{"source_id":"SHO","starless_id":"SHO_sl","stars_id":"SHO_st"}'

# starless structure
pi-tool run_lhe             '{"view_id":"SHO_sl","radius":64,"amount":0.20}'
pi-tool run_lhe             '{"view_id":"SHO_sl","radius":16,"amount":0.15}'

# stars + recompose
pi-tool fix_star_color      '{"view_id":"SHO_st","amount":1.0}'
pi-tool shrink_stars        '{"view_id":"SHO_st","iterations":1,"size":5,"amount":0.4}'
pi-tool recombine_stars     '{"starless_id":"SHO_sl","stars_id":"SHO_st","out_id":"SHO_final"}'
```

Background neutralisation limitation: `BackgroundNeutralization` is a GUI process with an
`Upper limit` derived from the sampled background. Read the background RGB with
`get_image_stats`, then set the limit just above the largest of the three, and call it through
`pjsr` if the bridge has no dedicated wrapper.

## Flow B — LRGB (exact calls)

```
pi-tool linear_fit        '{"reference_id":"L","target_id":"R"}'
pi-tool run_bxt           '{"view_id":"RGB","non_stellar":0.9,"stellar":0.2}'
pi-tool auto_denoise      '{"view_id":"L","phase":"linear"}'
pi-tool mas_stretch       '{"view_id":"RGB","target_background":0.20,"highlight_protect":0.7}'
pi-tool arcsinh_stretch   '{"view_id":"L","stretch":15}'
pi-tool separate_stars    '{"source_id":"RGB"}'
pi-tool run_bxt           '{"view_id":"RGB_sl","stellar":0,"non_stellar":0.5,"psf_fwhm":3.5}'
pi-tool remove_green      '{"view_id":"RGB_st","amount":0.85}'
pi-tool fix_star_color    '{"view_id":"RGB_st"}'
pi-tool recombine_stars   '{"starless_id":"RGB_sl","stars_id":"RGB_st","out_id":"RGB_final"}'
pi-tool auto_denoise      '{"view_id":"RGB_final","phase":"nonlinear","purpose":"final"}'
```

LRGB fusion happens through `lrgb_combine` or the `Image Blend` script (L = Base, RGB = Blend,
mode **Color**) — the bridge wrapper is `lrgb_combine`.

## Flow C1 — OSC with Ha injection (exact calls)

```
pi-tool extract_channel     '{"source_id":"RGB","out_id":"RGB_R","channel":0}'
pi-tool separate_stars      '{"source_id":"RGB_R"}'
pi-tool separate_stars      '{"source_id":"Ha"}'
pi-tool search_clean_ha_q   '{"ha_id":"Ha_sl","red_id":"RGB_R_sl"}'
pi-tool extract_clean_ha    '{"ha_id":"Ha_sl","red_id":"RGB_R_sl","out_id":"Ha_clean","q":0.045}'
pi-tool search_injection_b  '{"target_id":"RGB","ha_clean_id":"Ha_clean"}'
pi-tool inject_ha           '{"target_id":"RGB","ha_clean_id":"Ha_clean","b":1.75,"blue_ratio":0.1}'
```

**Never skip the two search calls.** The brief is explicit that both Q and B must be tuned per
image, and that the 0.1 blue coefficient is experimental. Target-specific exception: no
blue-channel Ha for M82 — the emission would read purple.

## Flow C2 — dual-band → SHO (exact calls)

```
pi-tool extract_channel '{"source_id":"HO","out_id":"Ha","channel":0}'
pi-tool mix_oiii        '{"source_id":"HO","out_id":"OIII_HO","g_weight":0.2,"b_weight":0.8}'
pi-tool extract_channel '{"source_id":"SO","out_id":"SII","channel":0}'
pi-tool mix_oiii        '{"source_id":"SO","out_id":"OIII_S","g_weight":0.8,"b_weight":0.2}'
# ImageIntegration over OIII_HO + OIII_S (each repeated ≥1x, 3+ total) → OIII
pi-tool combine_sho     '{"sii_id":"SII","ha_id":"Ha","oiii_id":"OIII","target_id":"SHO"}'
```

Then rejoin Flow A from the dynamic blend onward.

## Denoise policy — what `plan_denoise` will never do

| Phase | Floor | Ceiling | Detail |
|---|---|---|---|
| linear | 0.50 | 0.70 | 0.15 |
| nonlinear | 0.15 | 0.45 | 0.12 |

Purpose modifiers: `final` ×0.7, `rescue` ×1.25, `post-split` ×1.15, `starred` ×0.8.
A frame measured `clean` gets `needed:false` — the module refuses rather than over-smoothing.
That refusal is the correct output, not an error to work around.

## Reporting template

```
Stage A.4 — linear denoise (Ha)
  tool      NoiseXTerminator denoise=0.62 detail=0.15   (detected: NXT present)
  STF       shadows=0.00021 midtone=0.03128 highlights=1.0
  stats     median=0.00118 mean=0.00131 MAD=0.000247 min=0.00003 max=0.0412
  accept    PASS  (spread mono / max 0.0412 / MAD 2.47e-4 / gap 0.0%)
  preview   ~/.pixinsight-mcp/previews/A04_linear_denoise.jpg
```

If `accept` is FAIL, paste the `failures[]` entries verbatim and offer one or two alternative
parameter sets — do not proceed silently.

## Final delivery

1. `XISF` — 16-bit, full resolution, saved from the final view.
2. `JPG` — preview export.
3. The recipe — every stage in order with the parameters actually used, including which tool
   the fallback chain selected.

## PJSR gotchas — verified against a live PixInsight 1.9.4

These cost real debugging time on the M45 run. Each one fails **silently or confusingly**, so
treat them as hard rules.

| Symptom | Reality | Correct form |
|---|---|---|
| PixelMath per-channel expressions have no effect | There is no `expressionR/G/B`; assigning to those creates dead properties on the object | `expression0/1/2` = R/G/B, with `useSingleExpression = false` |
| `Image.median(): invalid argument type: Rect expected` | `median()` takes no channel number. Select the channel first | `img.selectedChannel = c; img.median();` then `img.resetSelections()` |
| `Image.minimum(): invalid argument type: Rect expected` | `minimum()` / `maximum()` always require a `Rect` | `img.minimum(new Rect(0, 0, img.width, img.height))` |
| `File.size is not a function` | PJSR's `File` has no `size` | stat the file from Node instead |
| `File.appendTextFile is not a function` | PJSR's `File` has no append | read + concat + `writeTextFile`, or write a fresh file |
| `File.searchDirectory is not a function` | `searchDirectory` is a **global**, not a `File` member | `searchDirectory(dir + '/*')` after the `#include`s |
| `Image.crop(x0,y0,x1,y1)` "succeeds" but nothing changes | four numbers is a silent no-op | `img.crop([x0, y0, x1, y1])` — a plain array |
| `Image.crop(new Rect(...))` → `Array expected` | despite the message, a `Rect` is rejected | pass the array form |
| `ImageSolver` throws `Math.trunc(): invalid argument type` | `ImageSolver` is a *script* class, not a `Process` — it has no `executeOn` | `new ImageSolver().SolveImage(imageWindow)` (pass the **window**, not the view) |
| `SPCC` returns in ~20 ms and changes nothing | Without a plate solution there are no star matches, so it no-ops | solve first; if the solver fails, fall back to measured channel gains |
| `ImageSolver` fails with `No database files have been selected` | No Gaia/XPSD catalogue is installed; SPCC needs one too | fall back to measured channel gains; installing Gaia needs a PI account (login-gated download) |
| `Image.resample()` on a freshly assigned image → `read-only image` | `assign()` into a view makes the target read-only under some sequences | copy first (`new Image(src)`), `resample()` the copy, then assign inside `beginProcess` |
| `HistogramTransformation` turns the frame solid red | `H` is five arrays `[R, G, B, L, A]`, each `[blackPoint, mids, whitePoint, lowClip, highClip]` | identity is `[0, 0.5, 1, 0, 1]`; change **only** `mids` to brighten |
| Star extraction is required for `capability_report` to be useful | `isValid` on a fresh process instance is `false` even when the module is installed | judge presence by "constructor exists and returns an object", never by `isValid` |

### Colour deficits live in the **input**, not in the stretch

Before blaming the pipeline, measure the raw master's background ratio:

```javascript
// per-channel background means on the linear master
if (0.2126*r + 0.7152*g + 0.0722*b < 0.012) { /* accumulate r,g,b */ }
```

If `R:G:B` is far from `1:1:1`, correct it with explicit channel gains **before** stretching:

```
gains = [1 / (R/G), 1, 1 / (B/G)]      // e.g. 0.789 : 1 : 0.558 -> 1.268, 1.0, 1.793
expression0 = 'max(0.0005, $T[0] * 1.268)'
```

Use `truncate = false` and a positive floor, or the shadow end lands on exactly 0 and the
`no_black_clip` gate fails later.

**Do not** reach for `BackgroundNeutralization` with an arbitrary `backgroundLow/High` window on a
nebulosity-filled frame: the "low" window may sit on the nebula, and the neutraliser then drives
the nebula's own colour out of the picture. On a blue reflection nebula it will happily turn the
target purple.
