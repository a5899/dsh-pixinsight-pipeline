# Layered Enhancement Recipe (mono LRGBSHO → natural RGB)

This is the **default** flow for a mono-camera LRGBSHO dataset that should end up *natural*
RGB (broadband colour, narrowband used as support for faint structure, not as a false-colour
palette). It was distilled from an approved M27 method-2 result and is expressed entirely in
tools that ship with this plugin; every number below has a tool parameter.

Use the HaRGB/HaLRGB pipeline when the intent is *narrowband-dominated* colour. Use this when
the intent is *truthful colour with deep faint structure*.

## Why it is layered

One stretch for everything forces a bad compromise: the faint outer halo needs a hard stretch,
the core needs none, and the stars need less than either. So the image is separated into
layers that are each stretched against their own background, then recombined in a regime where
the recombination cannot clip.

The layers are **starless** and **star**, per component (RGB and L). Narrowband channels never
get their own stretch — they only push energy into the linear starless layers.

## Order

1. **Linear RGB baseline.** Combine, gradient-correct per channel *while linear*, correct
   colour. Record whether SPCC was used or the classic CC+BN fallback was chosen, and why
   (`run_color_calibration` writes that record).
2. **Layer separation (still linear).** `run_bxt` → `run_nxt` → `run_sxt` on the linear RGB.
   Save the linear starless RGB and the RGB stars. The stars saved here are the *only* stars
   that will ever carry colour.
3. **Narrowband → support (still linear).** Per narrowband channel, subtract a scaled
   continuum estimate from the broadband channel it contaminates, keep the positive residual,
   smooth it (`continuum_support`). H and S feed red, O feeds both green and blue. Down-weight
   low-SNR channels; do not add a channel just because it exists.
4. **Stretch the starless RGB.** One colour-linked stretch with black-point headroom, then a
   protected HDRMT blend.
5. **Protected tone on the starless RGB.** `run_lhe_protected` — never darken the background
   to fake contrast.
6. **Outer faint structure.** `enhance_continuous_halo` — a *continuous* curve over the whole
   frame, luminance-gated, with a finite core floor. Never a fixed-ellipse protect + separate
   outer brightening.
7. **Linear L.** Extract with `run_sxt` (keep its stars only as an archive — final star colour
   comes from RGB), inject narrowband while still linear (`ha_inject_luminance` /
   `continuum_support` weights), *then* `run_bxt` → `run_nxt` on the enhanced L, then stretch
   independently with its own protected tone.
8. **Merge L into colour.** `lrgb_combine` with an explicit low weight (`clipHighlights=false`
   is set by the tool). Raise the weight gradually; watch for colour loss, graying, and noise
   amplification. If highlights clip, go back to the pre-merge save — do not "fix" it by
   lowering the weight only.
9. **Stars.** Stretch the RGB stars *weaker than the nebula*, defringe the star layer only
   (`defringe_star_layer`), then `star_screen_blend` with the highlight-compressing screen so
   a bright star on a bright nebula cannot saturate.
10. **Finish.** `weighted_saturation` (Akima S-curve gated off the background and off the
    highlight cores), then `highlight_rolloff` if anything still reaches the ceiling.
11. **Accept.** Same-display-scale comparison of full frame / core / periphery / bright stars
    on nebulosity / 100% star field. Then `export-deliverable` for the 16-bit TIFF.

## The parts that are easy to get wrong

**Background/level estimates must come from linear units on the layer they describe.** The
continuous-halo gate `clamp((0.55 - Y)/0.20)` is a *linear* expression; feeding it a
non-linear guide zeroes the whole chain and the enhancement silently does nothing. Take the
background and noise from `get_image_stats` on the linear support channel, not from the
stretched image.

**Guard the support curve output.** The compressed support `(asinh(max(0,C-b-a*n)/k)/asinh(200))^0.65`
reaches ≈1.2 on a strong channel. Always `clamp(0,1)` it before using it as a target.

**The core floor must be finite and old.** Inside the protected radius the layer must be
untouched, and the transition must be a smoothstep of radius, not a mask edge. Interpolation
along an old mask silhouette re-injects the mask as a visible ring.

**Screen blends need the highlight guard.** A star layer at 1.25× over a 0.8 nebula wants to
make 1.05. `star_screen_blend` compresses the coefficient with a smooth knee at 0.9 instead of
letting the result clip; keep that on.

**Defringe is a star-layer operation.** Applied to the whole image it removes real magenta
from the nebula. Order: defringe the star layer, *then* recombine.

## Parameter starting points

| What | Start | Notes |
|---|---|---|
| RGB starless target background | 0.055–0.08 | linear units before stretch; keep headroom below the clip point |
| L target background | 0.055–0.10 | usually slightly above RGB so L does not crush colour |
| BXT on linear RGB | `sharpen_stellar 0.35`, `sharpen_nonstellar 0.20`, `adjust_halos -0.05` | correct *before* the SXT split so stars are corrected as stars |
| NXT on linear RGB | `denoise 0.45`, `detail 0.15` | one pass; a second pass before stretch removes signal |
| SXT (linear) | `stars=true`, `unscreen=false` | `unscreen` only for non-linear inputs |
| Continuum subtraction | noise multiplier 1.2–2.0, smoothing σ 1.5–2.5 | higher multiplier on low-SNR channels |
| Narrowband weight into RGB | H 0.45, S 0.50, O 0.45 (G) / 0.65 (B) | scale down when the channel is noise-dominated |
| Protected LHE | `radius 48`, `amount 0.18`, `slope_limit 1.35` | the gate is what makes it safe |
| HDRMT | 6 layers, lightness mode, blend 55–65% | blend by luminance, not globally |
| Continuous halo | protect radius = bright core radius + 10%, ramp 200–260 px | strength 1.0 first; 0.75 if it looks soft |
| L weight | 0.70 (LRGB), up to 0.8 only if colour survives | `clipHighlights=false` |
| Star screen coefficient | 0.95 | the guard handles the bright-star case |
| Final saturation | S-curve through (0,0),(0.25,0.29),(0.5,0.58),(0.75,0.82),(1,1) | gated, not global |

These are starting points from one approved dataset (f/5.6 APO + 0.8× reducer, 3.76 µm mono,
≈17 h). Treat them as a prior, not a mandate — re-derive the background and ramp from the
actual layer.

## Acceptance numbers

Record these in the iteration note, not just in your head:

- dimensions unchanged, all pixels finite, `min ≥ 0`, `max < 1.0`
- zero-sample and saturated-sample counts versus the previous version
- `BXT delta` (the difference between the pre- and post-final-sharpen versions) — if the
  99th percentile is large the sharpening is doing real work; if it is tiny it is doing nothing
- intentional-difference check inside the protected region must be **exactly zero**

`export-deliverable` re-decodes the TIFF and refuses to report success unless bits=16,
channels=3, uncompressed, size-matched, and it carries an ICC profile.
