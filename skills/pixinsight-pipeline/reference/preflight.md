# Preflight: verify the material before processing

Most "the processing failed" outcomes on weak data are actually material problems
that no amount of careful processing can fix. Run this check **before** the first
process step, report the findings, and let the user decide.

## What to check

### 1. Is the input linear?

```javascript
var linear = (img.median() < 0.05);
```

A sky background above roughly 0.05 means the file has already been stretched.
Treating it as linear and stretching again produces a washed-out result and makes
every linear-stage parameter meaningless. If it is not linear, say so and start
from gradient removal on the stretched data instead.

### 2. Channel balance

Measure background medians per channel. A large imbalance is either a real
colour-cast problem or a sign that the frame was neutralised towards the wrong
region.

```javascript
var img = new Image(view.image);
img.resample(0.25);
// per-channel medians over a downscaled copy
```

Ratios of roughly 0.7 : 1.0 : 0.8 are common for one-shot colour before
correction. A ratio like 0.64 : 1.0 : 0.63 means the green channel dominates by
more than 50% — a large but normal OSC cast that `SCNR` handles. The danger is
neutralising towards a region that is **not** background.

### 3. Does the field actually contain the target?

Before trusting a preview, compute where the signal is. If the frame is dominated
by sky glow, the target may be present but invisible at normal stretch, and a
casual look will conclude "the data is empty".

```javascript
// Normalise by MAD so faint structure becomes visible
var pv = new Image(view.image);
pv.resample(0.25);
var med = pv.median();
var mad = pv.MAD();
var gain = 0.05 / mad;
for each channel, each pixel: (v - med) * gain + 0.5   clamped to 0..1
```

This "MAD-normalised stretch" is a diagnostic, not a deliverable. It shows whether
photons of the target are in the frame at all.

### 4. Are the flats from the same night?

Calibration frames that do not match the lights leave characteristic artefacts:
round rings, "doughnuts", or a bright arc across the field. Compare `DATE-OBS` in
the master flat against the lights, and check that the optics and focus position
are the same.

If they do not match, the remedy is new flats — not more processing.

### 5. Do the headers agree with the folders?

Camera software writes `IMAGETYP` and it is frequently wrong. Folder names are not
evidence. Verify before handing anything to WBPP; see
[wbpp-automation.md](wbpp-automation.md).

## Reporting

Summarise in a short table before starting, and be explicit about consequences:

| Check | Result | Consequence |
|---|---|---|
| Linear | no — median 0.30 | skip linear phase entirely |
| Channel balance | 0.64 : 1.0 : 0.63 | strong green cast, SCNR needed first |
| Target present | yes, M81/M82 visible under MAD stretch | signal is a few percent above sky |
| Flats match | **no** — flat 02-23, lights 03-27 | rings cannot be removed reliably |
| Headers | bias files marked `IMAGETYP=LIGHT` | WBPP will group them as lights |

Then state plainly which problems are fixable and which are not. Do not proceed
silently past a fatal data problem in the hope that processing will hide it.

## What cannot be fixed in processing

- Calibration frames shot with different optics or a different focus position
- A target that never entered the frame
- Exposure far too short for the intended structure, once light pollution sets the
  noise floor
- Wrong `IMAGETYP` values, if the user needs the frames grouped by folder

For each of these, report the finding and recommend re-acquiring the data — that is
more useful than delivering a polished image of artefacts.
