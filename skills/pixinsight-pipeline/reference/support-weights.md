# HSO Support Weights — measured sweep

The support weights decide how much continuum-subtracted H-alpha, OIII and SII is added
to each broadband channel before the stretch. The original recipe's numbers
(`R += 0.45H + 0.50S, G += 0.45O, B += 0.65O`) came from one target. This note records how
they were re-measured on M27 and what the shipped defaults now are.

## Why measure at all

"More narrowband" is not "better". Adding a support raises the linear signal, but it also
shifts the ratio between the channels, and after a shared-black-point stretch that ratio
change is what decides whether the nebula reads as a coherent structure or as coloured
noise. The only trustworthy criterion is **separation**: how far the subject core sits
above the sky in each channel, holding everything else constant.

## Method

`scripts/sweep-method2.mjs --config <cfg> --grid light,medium,skill,strong,haonly,oiii_heavy`

For each candidate it:

1. closes every open view and re-opens the balanced RGB under a fixed id (the id must be
   claimed and verified — `ImageWindow.open()` silently renames on collision);
2. rebuilds the three continuum-subtracted supports from the **same** measured sky/noise
   levels, so only the weights change between candidates;
3. measures the subject circle and a sky corner, reporting their ratio.

Then `scripts/compare-candidates.mjs` re-measures the saved candidates in four concentric
regions (core / halo / outer / sky) using `img.selectedRect` — not `Crop`, which is a
silent no-op in this build.

## Candidate results (M27, core-vs-sky separation)

| Candidate | R | G | B | Verdict |
|---|---|---|---|---|
| light | 0.25 / 0.25 / 0.25 / 0.35 | 1.28 | 1.41 | 1.48 | conservative baseline |
| medium | 0.35 / 0.35 / 0.35 / 0.50 | 1.32 | 1.42 | 1.50 | |
| skill | 0.45 / 0.50 / 0.45 / 0.65 | 1.35 | 1.44 | 1.52 | the recipe's recorded numbers |
| **strong** | 0.60 / 0.65 / 0.60 / 0.85 | **1.40** | **1.46** | **1.55** | **shipped default** |
| haonly | 0.45 / 0 / 0 / 0 | 1.35 | 1.38 | 1.44 | shows O support helps red too |
| oiii_heavy | 0.35 / 0.30 / 0.65 / 0.90 | 1.32 | 1.46 | 1.55 | matches G/B, starves the red rim |

(Weight order is `haToR / siiToR / oiiiToG / oiiiToB`.)

`strong` leads or ties on every channel and on core luma, so it is the default in
`scripts/layered-method2.mjs` (`rgbAdd: { H: [0.60, 0.65], O: [0.60, 0.85] }`).

Two things the table proves that are easy to get wrong:

- **OIII support helps the red channel.** `haonly` scores *lower* in red (1.35) than
  `strong` (1.40), because raising G and B changes the post-stretch balance. Treating the
  red channel as an H-alpha-only problem is a mistake.
- **`oiii_heavy` is a trap.** Its G/B numbers tie `strong` exactly while its red collapses
  to 1.32, so a G/B-only measurement would have picked the worse candidate.

## Re-running for a different target

1. Set `subject.cx / cy / protectRadius / featherRadius` in the config to the new subject.
2. `node scripts/sweep-method2.mjs --config <cfg>`
3. `node scripts/compare-candidates.mjs --config <cfg> --files <sweep/*.xisf> --labels ...`
4. Pick the candidate that leads across **all three** channels; write it into
   `params.rgbAdd` of that target's config.

Do not assume these numbers transfer. The ratios that produce "natural" depend on the
filter passbands, the exposure split between narrowband and broadband, and the target's
own emission mix. The sweep costs about 6 minutes and removes the guesswork.
