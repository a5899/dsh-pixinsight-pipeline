# Narrowband palettes — HOO and HSO without fooling yourself

Everything here was measured on the M27 dataset (H 65, O 35, S 12 frames,
3840x2160, 300 s each) while building a layered HOO flow that had to match an
accepted reference render. The numbers are from that target; the *rules* transfer.

---

## 1. Palette decision table

| Brief | Mapping | Driver | Expect |
|---|---|---|---|
| Natural colour with H-a boost | R/G/B + Ha into red | `layered-method2.mjs` | genuine star colours, correct colour calibration |
| Two-line broadband-free | `R = Ha`, `G = B = OIII` | `layered-hoo.mjs` | blue-cyan body, red H-a rim, pink transition |
| Three-line narrowband | `R = H (+S)`, `G = O`, `B = O` | `prep-hso.mjs` + `finish-hso.mjs` | **reads cyan on OIII-dominated targets** |
| Hubble palette | SII→R, Ha→G, OIII→B | remap by hand | red/green/blue separation, no natural colour |
| Foraxx / dynamic | per-pixel line mixing | not implemented | — |

The rule that matters: a **two-line** palette can only separate two things. Asking HSO
for a red nebula with a cyan core is asking three lines to behave like three colours —
which is what the Hubble palette is for.

---

## 2. Measure the lines inside the nebula

Whole-frame medians are dominated by background pixels, and the three narrowband
masters have different sky levels. Comparing those medians answers a question about
the sky, not about the object.

M27, per-channel median:

| region | Ha | OIII | Ha/OIII |
|---|---|---|---|
| whole frame | 0.006767 | 0.006948 | 0.97 |
| core box (1780,980)-(2070,1270) | 0.011148 | 0.009477 | **1.18** |
| inner box (1850,1060)-(2000,1190) | 0.011958 | 0.010401 | 1.15 |
| outer ring (1560,780)-(2300,1500) | 0.006907 | 0.007027 | 0.98 |

An intermediate conclusion of "Ha/OIII = 5.45, so red must dominate" was traced to
comparing channel *backgrounds*; the real signal ratio in the core is 1.15-1.18.

**How to measure**: set `img.selectedRect = new Rect(x0, y0, x1, y1)`, read
`median()/mean()/maximum()`, then `resetSelections()`. Do **not** loop over pixels
with `sample()` — ~77k calls hung the bridge for 8+ minutes (failures doc 13e).

---

## 3. Stretch rules are inverted between broadband and narrowband

| | Broadband (natural colour) | Narrowband palette |
|---|---|---|
| black point | one global, below the darkest sky | one global, below the darkest sky |
| midtones | **per channel** (so a cast neutralises) | **one shared** (so the ratio survives) |
| why | the cast is an artefact | the colour *is* the ratio |

Applying the broadband rule to HOO produced `R=G=B=0.2501/0.2500/0.2500` — a
perfectly neutral grey from correctly mapped data. Applying per-channel midtones
derived from very different sky+noise levels instead can drive R to 25x G.

---

## 4. The radial hue problem

Reference render, radial R/G ratio measured from the object centre:

| ring (px) | reference R/G | physical data Ha/OIII |
|---|---|---|
| 0-40 | 0.767 | 1.17 (core, highest in frame) |
| 40-80 | 0.743 | — |
| 120-160 | 0.900 | — |
| 160-200 | 1.085 | 1.05 (ring) |
| 250-300 | 1.00 | 0.98 (envelope) |

The render's core is the **bluest** part while the data's core has the **highest**
Ha/OIII. No global channel weight or mapping can produce that inversion — whatever
turns the core blue turns the rim blue with it.

The fix is a feathered radial tilt applied to the starless layer after the stretch:

```
sm = smoothstep( clamp( (feather - r) / (feather - core) ) )
R  = base_R * redScale * sm + base_R * (1 - sm)
B  = base_B * (1 + blueGain) * sm + base_B * (1 - sm)
```

- `redScale` is the fraction of red **kept** in the core (0.78 keeps 78 %).
  Naming it "fraction kept" matters: an earlier version applied `(1 - redScale)`
  and drove the core R/G to 0.025, near-zero red.
- `feather` must stop **before** the H-a rim. With core 120 / feather 260 the rim at
  160-250 px was inside the gate and got de-reddened; 150 / 255 works.
- Shipped result: 0.688 / 0.702 / 0.727 / 0.802 / 1.050 for rings
  0-40 / 40-80 / 80-120 / 120-160 / 160-200 versus the reference's
  0.767 / 0.743 / 0.810 / 0.900 / 1.085 — within ~5 %.

Outer rings stay redder than the reference (1.76 vs 1.00 at 250-380 px) because that
H-alpha envelope is real. Widening the tilt to fix it costs the rim's colour.

---

## 5. Why HSO reads cyan

OIII feeds **both** green and blue; H-alpha feeds only red. On a planetary nebula
whose OIII shell covers far more area than its thin H-alpha rim, `G + B` outweighs
`R` by construction.

Measured across five weight sets (`prep-hso.mjs`, H/OIII/S sky levels 0.006767 /
0.006948 / 0.005787):

| set | hWeight | sWeight | oWeight | R | G=B | R/(G,B) | look |
|---|---|---|---|---|---|---|---|
| weak | 1.0 | 0.35 | 1.00 | 0.008792 | 0.006948 | 1.27 | cyan |
| strong | 1.0 | 0.50 | 0.70 | 0.009660 | 0.004863 | 1.99 | cyan |
| siii | 1.0 | 0.80 | 0.60 | 0.011396 | 0.004169 | 2.73 | orange lean |
| red-h | 1.3 | 0.45 | 0.75 | 0.011401 | 0.005211 | 2.19 | cyan |
| v3 | 1.6 | 0.55 | 0.70 | 0.011965 | 0.004529 | 2.64 | cyan + red rim |
| v5 | 2.2 | 0.55 | 0.70 | 0.015849 | 0.004529 | 3.50 | still cyan |

Raising `oToBlue` alone made it **worse** — a pure-green frame — because it lifts
blue without lifting red.

Conclusion: a red-looking narrowband image requires a Hubble remap. If the brief
forbids that, accept the cyan base and finish it well (that is what
`finish-hso.mjs` does: shared-curve stretch, protected LHE, rolloff, weighted
saturation).

---

## 6. Stars in a narrowband frame

Every star is a saturated version of the palette colour, so an untreated field reads
as a wall of red or cyan dots that outshines the object.

The working recipe:

1. SXT on the linear composite; the starless result stays in the view, the stars
   arrive in a new window (diff `ImageWindow.windows` to find it).
2. Stretch the star layer on its own, **gentler** curve:
   `odds = (base/(1-base))^strength`, `mid = odds/(1+odds)`.
   Strength 0.35 on M27.
3. Pull the star saturation *down* with a `P.S` curve that sits below the identity,
   blended in at ~0.25. Narrowband stars should not be more saturated than the
   nebula.
4. Defringe the star layer only: `e = max(0, min(R,B) - G - 0.008)`, `R -= 0.55e`,
   `B -= 0.55e`, `G += 0.398210291 * 0.55e`. Never on the whole image.
5. Screen composite at `k` below 1. Measured on M27: k 0.85 = wall of stars,
   k 0.55 = stars almost gone, **k 0.70 = visible but subordinate**.

---

## 7. Judging the result

**Do** compare:

- a radial profile of R/G and B/G from the object centre, per ring, against whatever
  reference you are matching;
- subject-only colour: select a rect over core / body / rim and read medians;
- the same-display-scale full frame, so the object's apparent size is comparable.

**Do not** rank renders by whole-frame mean chroma. It is dominated by background
and stars: it once marked a clearly better image as a 4.25x regression. The old
pipeline scored high on it only because a warm cast covered the entire frame.

---

## 8. Re-running for a new target

1. Measure each master's sky (median) and noise (MAD) in the sky region — do not
   reuse M27's numbers, they encode this sensor and this sky.
2. Measure Ha/OIII inside the nebula to decide whether the target is H-a or OIII
   dominated. An H-a-dominated object (Rosette, North America) needs none of the
   core tilt; the plain HOO already reads red.
3. Determine the subject geometry (centre, core radius, feather) — scale from the
   frame, never copy M27's (1923, 1124) / 150 / 255.
4. Run `layered-hoo.mjs` and read the log: `sky ratio Ha/OIII`, `post-stretch
   medians`, `colour retained R/(G,B)`. Then measure the radial profile before
   touching any knob.
5. Accept when the radial profile matches the target look, then export with
   `--target <TARGET> --png --to-deliverables`.
