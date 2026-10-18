# WBPP Automation (command line)

Drive `BatchPreprocessing` without clicking through its GUI. This page records the
exact invocation that works on Windows, because most of the plausible variations
fail in ways that are hard to read.

## The working invocation

```cmd
"C:\Program Files\PixInsight\bin\PixInsight.exe" -n --automation-mode ^
  "-r=C:\pi_wbpp\BatchPreprocessing\WBPP.js,automationMode=true,dir=C:\lights,dir=C:\calib,outputDirectory=C:\out,generateRejectionMaps=false" ^
  --force-exit
```

Three rules, each learned from a failed run:

1. **All parameters go INSIDE the `-r=` string, separated by commas.**
   They are not separate argv entries.
2. **The whole `-r=...` value is wrapped in one pair of double quotes** — because
   `C:\Program Files\...` contains a space.
3. **`WBPP.js` itself must be copied somewhere without a space in the path.**
   Copying `C:\Program Files\PixInsight\src\scripts\BatchPreprocessing\` to
   `C:\pi_wbpp\BatchPreprocessing\` is enough; the script's relative `#include`s
   then resolve inside the copied folder.

Add `--force-exit` so the process terminates after the script finishes, instead of
leaving a headless PixInsight resident.

## Why the obvious variants fail

| Attempt | Symptom |
|---|---|
| Parameters as separate argv entries after `-r=<script>` | Each parameter is treated as a **file to open**: `No such file: .../automationMode=true`, then `No files were opened` |
| `-r=` pointing at the script in `C:\Program Files\...` without quoting | The path is split at the space and the tail becomes stray arguments |
| Same, with quoting but parameters outside the quotes | Same "no such file" family of errors |
| Leaving it as a bare `WBPP.js` with no parameters | Opens the WBPP GUI and waits — nothing is processed |

The tell-tale console output is a run where the Output Directory field in the WBPP
GUI shows a truncated path such as `:/Users/.../C 27`. That means the command line
was split incorrectly and the GUI came up with empty file lists.

## Useful parameters

| Parameter | Meaning |
|---|---|
| `automationMode=true` | Run the full pipeline headless and exit when done |
| `dir=<path>` | Add a directory as an input. **Repeatable** — one per directory |
| `outputDirectory=<path>` | Where masters and working frames go |
| `generateRejectionMaps=false` | Skip rejection maps (saves a lot of disk and time) |
| `groupingKeywordsEnabled=false` | Do not split groups by FITS keywords |
| `lightsLargeScaleRejectionHigh/Low=false` | Disable large-scale rejection for lights |
| `flatsLargeScaleRejection=false` | Same for flats |

To add a single file rather than a directory use `file=<path>`; it accepts the same
repetition.

## Frame-type detection is header-based — verify it first

WBPP decides bias / dark / flat / light from the **FITS `IMAGETYP` keyword**, not
from the folder name. Camera software frequently writes the wrong value, and the
consequence is silent corruption of the grouping rather than an error:

```
[..] Group of 20 Light frames (20 active)
```

If that line reports frames you supplied as bias or dark, WBPP has filed them as
lights. Those groups then fail to register, because a 0-second bias cannot be
aligned to a 300-second light:

```
Matching stars: done
195 putative star pair matches.
** RANSAC: Unable to find a valid set of star pair matches.
*** Error: Unable to find an initial linear transformation.
*** Error: No image could be registered.
** Warning: Error registering light frames. This group will be skipped.
```

**Check before every run** — read each input directory's `IMAGETYP` and confirm it
matches the folder it came from:

```javascript
var wins = ImageWindow.open(path);
var kw = wins[0].keywords;
var type = '';
for (var i = 0; i < kw.length; ++i) {
   if (kw[i].name === 'IMAGETYP') type = kw[i].value;
}
wins[0].forceClose();
```

If the headers are wrong, either fix them before running WBPP or sort the folders
by the value actually in the header rather than by name.

## Calibration frames must match the lights in time

Calibration masters go stale. A flat set shot a month before the lights will not
divide out dust shadows or vignetting, and the result is a field covered in round
"doughnut" rings that no amount of gradient removal will fix:

```
... bright arcs and circular rings across the whole frame
```

Before reusing an old calibration set, compare `DATE-OBS` in the master flat
against the lights, and prefer flats from the same night with the same optics and
focus position. If matching flats do not exist, processing cannot manufacture them —
report the problem rather than shipping a ringed image.

## After the run

Confirm the outputs before starting post-processing:

```
<outputDirectory>/master/masterLight_*.xisf
<outputDirectory>/master/masterFlat_*.xisf
<outputDirectory>/logs/<timestamp>.log
```

Read the tail of the log — a run that "finished" can still contain
`Error registering light frames` or `No image could be registered` while the GUI
reported completion.
