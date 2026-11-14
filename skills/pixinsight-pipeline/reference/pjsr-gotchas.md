# PJSR Gotchas & Constraints

## Language: ECMAScript 5 Only
PJSR runs ECMAScript 5. Do NOT use:
- `let`, `const` — use `var`
- Arrow functions `() => {}` — use `function() {}`
- Template literals `` `${x}` `` — use `'text' + x + 'text'`
- Destructuring, spread, `class`, `for...of`, `Promise`

## File I/O
```javascript
// Reading
var lines = File.readLines(path);       // returns array of strings
var text = lines.join('\n');

// Writing
File.writeTextFile(path, text);         // static method, no instance needed

// Checks
File.exists(path);
File.directoryExists(path);
File.createDirectory(path, true);       // recursive mkdir

// Listing
searchDirectory(dir + '/*.json');       // glob-like listing
```

**Do NOT use** `DataType_ByteArray` — it's not defined.

## `executeOn()` returning clean proves nothing

The single most expensive lesson of the M27 run. Four processes reported success and
corrupted the image without raising:

| Symptom | Cause | Fix |
|---|---|---|
| Image becomes a flat 0.5 field | MTF coefficient for `HT.midtones` derived from the wrong formula | calibrate midtones by bisection against a probe window (see below) |
| `SCNR.protectionMethod(): invalid argument type` | `SCNR.prototype.MaximumMasking` is `undefined` — PJSR exposes no process constants on the prototype | pass plain integers: `protectionMethod` 0–3 (2 = maximum masking), `colorToRemove` 0=Red 1=Green 2=Blue |
| `ChannelCombination.channels(): table length out of range (0)` | assigning `P.channels = []` before filling entries | assign the whole table at once: `P.channels = [[true,'R'],[true,'G'],[true,'B']]` |
| `Image.Set(): invalid channel index` later on | `image.assign()` **collapses a colour target to 1 channel when the source is mono** | check `numberOfChannels` before assigning; build colour views channel-by-channel with `setSample` |
| Preview save fails with Win32 error 123 | backslashes in a PJSR string literal are escapes — `'D:\astro\x'` collapses to `'D:astrox'` | always forward-slash paths before interpolating them into PJSR |

**Rule:** after any process that is supposed to change pixels, assert on the pixels —
re-read `median` / `min` / `max` and compare against the value before the call. A constant
field (min == max), an unchanged median, or `MAD == 0` all mean the step silently did nothing
or destroyed the data. Roll back to a checkpoint rather than compensating downstream.

### Calibrating `HistogramTransformation` midtones

`H` is **five rows of five numbers** — one row per channel (R, G, B, L, Alpha) — and each row
holds `[blackPoint, midtones, whitePoint, lowClip, highClip]` positions. See
`## HistogramTransformation.H — the documented layout is wrong for this build` before you write
one: on this build only the midtones column is usable above ~0.5, and a six-row table throws
`table length out of range (6)`. The midtones value is **not** the MTF coefficient from the
formula books: measured on this build, `0.5` is identity, values **below 0.5 brighten**, above
0.5 darken. Do not derive it — bisect it:

```javascript
// probe: fill a small window with the current median, apply a candidate,
// read back the median, adjust. 18 iterations converge far tighter than needed.
var w = new ImageWindow(48, 48, 3, 32, false, true, 'midtones_probe');
var v = w.mainView;
v.beginProcess();
var img = v.image;
for (var c = 0; c < 3; c++)
  for (var y = 0; y < 48; y++)
    for (var x = 0; x < 48; x++)
      img.setSample(median, x, y, c);
v.endProcess();
var P = new HistogramTransformation;
P.H = [[0, m, 1, 0, 1], [0, m, 1, 0, 1], [0, m, 1, 0, 1],
       [0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1]];
P.executeOn(v);
var out = img.median();
w.forceClose();
```

`MAD()` is the **median** absolute deviation, so it is legitimately `0` whenever most pixels
sit exactly on the median (a synthetic flat with a small bright patch, for example). It is a
good noise/clipping signal on real frames, not a universal "has structure" test.

## XISF Crop Masks
XISF files from WBPP contain embedded crop masks. Opening creates MULTIPLE windows:
```javascript
// After opening XISF, close crop masks:
var wins = ImageWindow.windows;
for (var i = 0; i < wins.length; i++) {
    if (wins[i].mainView.id.indexOf('crop_mask') >= 0) {
        wins[i].forceClose();
    }
}
```

## PixelMath in Global Context
`createNewImage = true` with `executeGlobal()` requires ALL of:
- `newImageWidth`, `newImageHeight`
- `newImageColorSpace` (`PixelMath.prototype.RGB` or `.Gray`)
- `newImageSampleFormat` (`PixelMath.prototype.f32`)

Without these: "Cannot execute instance in the global context" error.

## PixelMath Limitations
- **No `pow()` function** — use `exp(exponent * ln(base))` instead
- **`^` operator** works for fractional/negative exponents
- Negative numbers must be wrapped: `(-1.859)` not `-1.859` in some contexts
- `P.use64BitWorkingImage = true; P.truncate = true` for precision

## StarAlignment
- Output directory path must have **NO SPACES** — PJSR silently fails
- Use `/tmp/aligned/` or `~/.pixinsight-mcp/aligned/` instead
- `targets` format: `[[enabled, drizzle, filepath]]`

## eval() Context
- `#include` directives don't work inside eval — they're compile-time
- Code goes through JSON.stringify → JSON.parse → eval (beware escaping)
- Single quotes in PJSR code work fine
- Write long scripts to `/tmp/` files to avoid escaping issues

## Process Module Availability
- Not all PI processes are installed as `.dylib` modules
- Check: `/Applications/PixInsight/bin/<ProcessName>-pxm.dylib`
- GHS is script-only (no .dylib) — must use PixelMath fallback
- SXT/NXT/BXT ARE native modules
- Runtime check: `try { new ProcessName; } catch(e) { /* not available */ }`

## UI Responsiveness
- `processEvents()` is CRITICAL in any loop to prevent freeze
- `msleep(ms)` blocks completely — no UI events during sleep
- Pattern: alternate `msleep(50)` with `processEvents()` in idle loops
- During `P.executeOn(view)`, UI is blocked — unavoidable

## Memory Management
- PixInsight accumulates undo history — each operation adds ~300MB per 6000x4000 RGB image
- **Purge undo history** with `w.purge()` after mask-heavy steps (LHE, HDRMT) and merge points
- **Close images when done**: L_work after LRGB combine, stars after star addition, masks after use
- Check OS-level memory between heavy steps (BXT, NXT, SXT, SPCC)
- Close crop masks, ABE models, alignment outputs immediately
- Each 5972x3920 f32 RGB image ≈ 280MB RAM (plus undo = 280MB per operation)
- Thresholds: warn=4GB (auto-purge), abort=8GB (auto-checkpoint + exit)
- Without purging: 44GB observed. With purging: peak 1.3GB for same pipeline.
- After pipeline crash: relaunch PixInsight, resume from checkpoint with `--restart-from`

## ImageWindow Constructor — "invalid dimension(s)" means you passed 0

> **Correction (2026-11-14, M27 run).** This section used to claim the constructor
> rejects valid `Image.width` / `Image.height` values, and prescribed a two-call
> JSON round-trip to turn them into integer literals. That diagnosis was wrong and
> the workaround was unnecessary. Measured cause: the source window was **not open**
> (`windowById` returned a null window whose `image` is `0x0`), so the constructor
> received `0, 0` — a genuinely invalid dimension.

```js
// what actually happened in the M27 run
var d = ImageWindow.windowById('S_H').mainView.image;   // no such window
new ImageWindow(d.width, d.height, 3, 32, false, true);
// Script error: ImageWindow.ImageWindow(): invalid dimension(s)
```

**Check both before constructing**, and interpolating real numbers from Node is fine —
no two-call dance needed:

```js
var w = ImageWindow.windowById(id);
if (w.isNull) throw new Error('window not open: ' + id);
var im = w.mainView.image;
if (im.width < 100 || im.height < 100)
    throw new Error('window has no image: ' + im.width + 'x' + im.height);
```

The "invalid dimension(s)" message never means "the numbers were the wrong type". It
means they were out of range — in practice `0`. Guard the source, not the arithmetic.

Still use `floatSample=true` (5th arg) for mask windows — `false` creates integer images
which behave differently for PixelMath operations.

## ImageWindow.windowById() Never Returns Null
`ImageWindow.windowById('someId')` **always** returns an ImageWindow object, even if no
window with that ID exists. The returned object has `.isNull === true` when not found.

**WRONG:**
```javascript
var w = ImageWindow.windowById('myView');
if (!w) throw new Error('not found');  // NEVER throws — w is always truthy!
if (w ? 'yes' : 'no')  // ALWAYS 'yes'!
```

**CORRECT:**
```javascript
var w = ImageWindow.windowById('myView');
if (w.isNull) throw new Error('not found');  // Properly checks
w.isNull ? 'no' : 'yes';  // Correct boolean check
```

This is a critical PJSR gotcha — caused mask creation to silently fail for 4 iterations
because the Ha_work existence check always returned 'yes'.

## Astrometry Transfer
```javascript
// Copy WCS solution from source to destination
dstWindow.copyAstrometricSolution(srcWindow);
```
Essential after creating PixelMath composites — SPCC needs WCS data.

## File API — what actually exists

Verified on PixInsight 1.9.4. Several seemingly obvious members do **not** exist,
and calling them throws inside the watcher poll loop (which used to be fatal).

```javascript
File.readTextFile(path)          // OK
File.writeTextFile(path, text)   // OK
File.exists(path)                // OK
File.directoryExists(path)       // OK
File.createDirectory(path, true) // OK
File.remove(path)                // OK — but throws on a locked file
```

**These do NOT exist** — do not use them:

| Missing | Use instead |
|---|---|
| `File.size(path)` | not available; report via a separate call or skip |
| `File.appendTextFile(path, s)` | read + concat + `writeTextFile`, or write a fresh file each time |
| `File.searchDirectory(...)` | the **global** `searchDirectory(pattern)`, visible after `#include` |
| `File.directoryEntryList(dir)` | `searchDirectory(dir + '/*')` |

`searchDirectory` is a global function, not a `File` member. It returns absolute paths,
so strip the directory prefix when you need bare names:

```javascript
var abs = searchDirectory(dir + '/*.json');
var names = [];
for (var i = 0; i < abs.length; ++i) {
   var s = String(abs[i]);
   names.push(s.substring(s.lastIndexOf('/') + 1));
}
```

`File.remove` raises a sharing violation while another process still holds the file
open (Windows). Always wrap it and fall back to a rename:

```javascript
function retireCommandFile(path) {
   try { File.remove(path); return true; } catch (e) {}
   try { File.rename(path, path + '.done'); return true; } catch (e) {}
   return false;
}
```

## Image.crop() needs an Array

```javascript
// WRONG — silently does nothing, leaves the image untouched
img.crop(x0, y0, x1, y1);

// WRONG — "Image.crop(): invalid argument type: Array expected."
img.crop(new Rect(x0, y0, x1, y1));

// CORRECT — a plain JS array
img.crop([x0, y0, x1, y1]);
```

The silent no-op form is the dangerous one: it reports success and the image is
unchanged, so a "crop" step can appear to work while nothing happens.

## Image statistics take a Rect, not a channel index

```javascript
// WRONG — "Image.median(): invalid argument type: Rect expected."
img.median(c);
img.minimum(c);

// CORRECT — select the channel, measure, then reset
img.selectedChannel = c;
var m = img.median();
img.resetSelections();
```

`new Statistics(img, c)` also throws (`Wrong number of arguments`). For whole-image
figures just call `img.median()`, `img.minimum()`, `img.maximum()`, `img.MAD()`
with no arguments.

## Stretched vs linear input — check before you trust it

A WBPP `masterLight` is **not necessarily linear**. Verify before running any
linear-stage process (BXT, NXT, SPCC, LinearFit):

```javascript
var linear = (img.median() < 0.05);   // roughly: sky background below 5%
```

An already-stretched master typically reports `median ≈ 0.2–0.35` and
`max ≈ 0.95`. Applying a linear-stage denoise or deconvolution to it, then
stretching again, produces a washed-out double-stretched result. If the input is
non-linear, **skip the linear phase entirely** and start from gradient removal on
the stretched data.

## Undefined globals

These look like they should exist and do not:
`ColorSpace_RGB`, `ImageColorSpace_RGB`, `UndoFlag_NoSwapFile`, `MTF`.

`new MTF()` throws `MTF is not defined`. Use `HistogramTransformation.H` for
midtone work instead, or `img.mtf(m, x0, x1)` as an image method.

## HistogramTransformation.H layout

`H` is **five rows** — R, G, B, L, Alpha — and each row is five numbers. The conventional
reading is `[blackPoint, midtones, whitePoint, lowClip, highClip]`, and that reading is what
`pjsr-gotchas.md` originally documented. **On this build it only partly holds**: the default is
`[0, 0.5, 1, 0, 1]` per row and midtones work as expected, but values above ~0.5 in the third
column throw `numeric value out of range`, and a six-row table throws
`table length out of range (6)`. Verify with a probe before trusting any non-identity table —
see the next section.

```javascript
var ht = new HistogramTransformation();
// identity is [0, 0.5, 1, 0, 1]; mids < 0.5 brightens
ht.H = [[0, 0.38, 1, 0, 1],   // R
        [0, 0.38, 1, 0, 1],   // G
        [0, 0.38, 1, 0, 1],   // B
        [0, 0.38, 1, 0, 1],   // L
        [0, 0.5,  1, 0, 1]];  // Alpha — leave at identity
ht.executeOn(view, false);
```

Getting this wrong does not throw. A malformed `H` can push a single channel to
saturation and turn the whole frame solid red while reporting success — always
re-measure channel means after the call.

## MultiscaleLinearTransform: column 3 of `layers` is BIAS, not strength

`layers` is a **7-column** table — `[enabled, biasEnabled, bias, nrEnabled,
threshold, amount, iterations]`. Column 3 is the **bias**, so writing a denoise
strength there inflates the pedestal instead of smoothing noise. Measured on
M27 (2026-10-28): background went from `0.0068` to `0.21` — 600x — with **no
error, no warning, and a clean `executeOn()`**.

The noise controls are four separate scalar properties:

```javascript
var m = new MultiscaleLinearTransform();
m.layers = [[true, true, 3, false, 0.0, 0.500, 1],   // col 3 = bias = 3
            [true, true, 3, false, 0.0, 0.500, 1],
            [true, true, 3, false, 0.0, 0.500, 1],
            [true, true, 2, false, 0.0, 0.500, 1],
            [true, true, 2, false, 0.0, 0.500, 1]];
m.noiseThresholding       = true;   // <- the actual denoise switch
m.noiseThresholdingAmount = 1.0;    // strength
m.noiseThreshold          = 3.0;
m.softThresholding        = true;
m.executeOn(view);
```

Correct parameters measured on M27 HOO: noise MAD **−43% (R) / −67% (G)**
while nebula medians moved **0.05%**. Anything that does not achieve both is
either a no-op or a working image being destroyed.

## Pick ONE white point across channels of a composite

Stretching R, G and B with independently chosen white points gives the weaker
channel a smaller span, hence a **larger gain on the same noise**. On M27 HOO
the O span was 62% of H, so O was stretched 366x against H's 230x — 59% more
gain on identical noise, which reads as colour speckle — and R/G came out
`0.952` (green brighter than red) instead of the true `~1.8`.

Normalise every channel against one physical span while keeping each channel's
own black point:

```javascript
black_c = median_c - k * MAD_c     // per channel: removes its own pedestal
span    = max over channels of (P99.95_c - black_c)
white_c = black_c + span           // shared span -> identical gain 1/span
```

`shared_span_stretch` does this. Rule of thumb: **any channels that must read
as one brightness scale share a span; only the pedestal is per-channel.**

## PixelMath channel expressions

The per-channel expression members are `expression0`, `expression1`, `expression2`
(R/G/B) — **not** `expressionR` / `expressionG` / `expressionB`. Setting the
non-existent names is silently ignored and the operation becomes a no-op.

```javascript
var pm = new PixelMath;
pm.useSingleExpression = false;
pm.expression0 = '$T * 1.31';
pm.expression1 = '$T';
pm.expression2 = '$T * 1.84';
pm.rescale = false;
pm.truncate = false;               // keep true only if you want 0..1 clamping
pm.executeOn(view, false);
```

Note `truncate = true` clips the lower bound to 0. On a linear frame whose
background is near zero this destroys shadow detail and shows up later as a
`no_black_clip` gate failure. Prefer `truncate = false` plus an explicit
`max(epsilon, ...)` in the expression.

## eval() for capability probes

```javascript
// Check whether a process exists at runtime
var available = true;
try { eval('new ' + name + '()'); } catch (e) { available = false; }
```

Do **not** check `instance.isValid` to test availability — it is `false` for every
process until its parameters are set, so it reports false negatives for tools that
are actually installed.

---

# Gotchas from the M45 v03 run (2026-11-14)

Everything below was measured on this machine (PixInsight Core 1.9.3 Lockhart,
`C:\Program Files\PixInsight\bin\PixInsight.exe`). Each entry cost real time.

## A silent `ok:true` is normal — always verify on disk

`pi-tool.mjs save_variant` builds its PJSR path with `path.join(VARIANT_DIR, name)`,
which on Windows yields **backslashes**. Interpolated into a PJSR string literal
those become escapes: `\v` → vertical tab `\u000b`, `\b` → backspace, `\0` → NUL.
The save then fails, **still prints `{"ok":true}` and writes its `.json` sidecar**,
and the target directory contains zero `.xisf` files. `load_variant` later dies with
`No such file`.

**Rule:** any Windows path that goes into PJSR must be forward-slashed first:

```javascript
var p = winPath.replace(/\\/g, '/');
```

**Rule:** after every write, confirm on disk from the shell
(`Get-ChildItem` → check `Length` / `LastWriteTime`). A tool's `ok:true` is not
evidence the file exists.

## Prefer `pisave.mjs` / `piopen.mjs` over save_variant / load_variant

Local wrappers (kept under the run's `work/` dir) save/load by **absolute,
forward-slashed** path and verify with `File.exists` inside PJSR:

- `pisave.mjs <viewId> <absXisf>` — `mainView.saveAs(...)` + existence check.
- `piopen.mjs <absXisf> <newViewId>` — opens, closes the `crop_mask` window, renames.

`File.size()` **does not exist** in PJSR — calling it throws
`Script error: File.size is not a function`.

## Shell: JSON arguments into node get mangled

Passing `'{"a":"b"}'` as a PowerShell argument to node frequently arrives as
`{\"a\":\"b\"}` (one extra escape layer). Two fixes that work:

1. Write the JSON to a temp file and pass `@/path/to/args.json`.
2. Do the self-heal in the wrapper: if the string starts with `{\"`, run
   `json.replace(/\\"/g, '"')` before `JSON.parse`.

Keep `psh` for shell work; the mangling is the shell quoting layer, **not** a reason
to switch to another shell.

## `beginProcess()` / `endProcess()` — only around manual image edits

`PixelMath.executeOn(view)` and `HT.executeOn(view)` open the processing session
themselves. Wrapping them again throws:

```
Script error: Invalid view update request: The image is already being processed: <view>
```

Wrap only direct `image.*` calls (e.g. `image.resample()`), not `executeOn`.

## `image.crop()` — works, but only on a WRITABLE image

**Root cause (confirmed 2026-11-14): images loaded from disk are read-only.** Every
crop form below fails on such an image — silently, or with `read-only image`. The
crop API itself is fine. Copy into a fresh writable window first:

```javascript
var src = ImageWindow.open(srcPath)[0].mainView.image;   // READ-ONLY
var out = new ImageWindow(src.width, src.height, src.numberOfChannels, 32, false, src.isColor);
out.mainView.beginProcess();
out.mainView.image.assign(src);          // writable copy
out.mainView.endProcess();
if (out.mainView.image.numberOfChannels !== src.numberOfChannels)
    throw new Error('assign collapsed channels');

out.mainView.beginProcess();
out.mainView.image.cropTo(x0, y0, x1, y1);   // now it takes
out.mainView.endProcess();
```

`cropTo(x0, y0, x1, y1)` is the reliable primitive (4 ints, exclusive right/bottom).
Verified: `5493x3664 -> 1633x1350 ch=3`. `img.crop([x0,y0,x1,y1])` (Array form) also
works on the writable copy. **Always assert the resulting `width`/`height`** — the
failure mode is a silent no-op.

What each attempt does on a READ-ONLY (disk-loaded) image:

| Attempt | Result |
|---|---|
| `img.cropTo(x0, y0, x1, y1)` | `Script error: Image.cropTo(): read-only image` |
| `img.cropTo(new Rect(...))` | same `read-only image` |
| `img.crop([x0, y0, x1, y1])` | silent no-op, size unchanged |
| `img.crop(x0, y0, x1, y1)` | silent no-op, size unchanged |
| `Crop.mode = Crop.prototype.Absolute` | `Crop.mode(): invalid argument type: unsigned integer value expected` |
| `Crop.setBounds(...)` | `P.setBounds is not a function` |
| `new DynamicCrop` + `.interpolation = ...prototype.Bicubic` | `DynamicCrop.interpolation(): invalid argument type: unsigned integer value expected` |
| `DynamicCrop` without interpolation | no error, size unchanged |
| `w.saveCropped(q, new Rect(...))` | `w.saveCropped is not a function` |

Note: the `Crop`/`DynamicCrop` process objects are a dead end regardless. Use
`Image.cropTo()` on a writable copy. When `cropTo` isn't available, fall back to
`image.resample(factor)` inside `beginProcess()/endProcess()`.

Bonus trap: `image.selectedChannel = c` does **not** affect `image.sample(x, y)` —
all channels return the same value. Per-pixel copying that relies on it (e.g. a manual
"zoom into region" routine) writes one channel's data into all three and produces a
monochrome-red image. Don't hand-copy pixels; crop instead.

## `HistogramTransformation.H` — the documented layout is wrong for this build

`pjsr-gotchas.md` claims five rows of
`[blackPoint, midtones, whitePoint, lowClip, highClip]` with a free choice of values. Setting
such a table with ordinary curve parameters throws:

```
Script error: HistogramTransformation.H(): numeric value out of range: 0.15
```

Probing the live object shows the default is `[0, 0.5, 1, 0, 1]` per row, and the
setter rejects ordinary curves:

| Table attempted | Result |
|---|---|
| 6 rows | `H(): table length out of range (6)` |
| 5 rows, y = 1.0 in a row | `H(): numeric value out of range: 1` |
| 5 rows, `[0.00,0.00,0.85,1.00,1]` | `numeric value out of range: 1` |
| 5 rows, `[0.000,0.000,0.180,0.150,1]` | `numeric value out of range: 0.15` |

**Do not fight it.** For contrast work use PixelMath with the MTF formula that
already works inside `pi-tool.mjs`:

```javascript
var m = 0.54;                       // > 0.5 darkens midtones, < 0.5 brightens
var a = (1 - m).toFixed(6);
var b = (1 - 2 * m).toFixed(6);
var P = new PixelMath;
P.expression = '(' + a + '*$T)/((' + b + ')*$T+' + m.toFixed(6) + ')';
P.useSingleExpression = true; P.createNewImage = false;
P.use64BitWorkingImage = true;
P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
P.executeOn(v);
```

Measured: `m = 0.54` on a stretched frame moved the median 0.199815 → 0.175405.

## PixelMath single expression: no `var` statements

A multi-line expression using `var L = ...;` compiles without error, runs without
error, and **changes nothing** (median identical before and after). Under
`useSingleExpression = true` the expression must be a single inline formula —
expand every intermediate:

```javascript
var L = '(($T[0]+$T[1]+$T[2])/3)';
var t = 'min(1,max(0,(((' + L + ')-0.035)/(0.220-0.035))))';
var k = '(1+0.30*' + t + ')';
P.expression = '(' + L + ')+($T-(' + L + '))*' + k;
```

## `masked_saturation` is broken on this build

It fails inside with

```
Error: maskedSaturation: Script error: CurvesTransformation.S(): expected an array table row definition (row #0)
```

The RangeSelection mask builds fine (`coverage 19.3%`) and then the saturation step
dies. Use the PixelMath luminance-ramped chroma boost above instead (it keeps the
luminance and leaves the dark sky alone).

## BXT statistics do not reflect its parameters

`run_bxt` with `sharpen_nonstellar: 0.0` and `sharpen_nonstellar: 65` returned
**byte-identical** stats (`median 0.02366804846173477`, `max 1`). The reported
statistics are computed from the input, not the output. Judge BXT by a saved
preview, never by its `stats` block.

## Stale preview files

Several differently-named `save_preview` calls produced the *same* file
(identical length 5,574,794 bytes and sha256). Check `Length` + `LastWriteTime`
before trusting a preview, and give each attempt a fresh label.

## Files written by `saveAs()` stay locked (EBUSY) until PixInsight quits

Files saved from PJSR (`w.saveAs(path, ...)`) are **not** available to other processes
afterwards. Reading or copying them from PowerShell / another app fails with:

```
EBUSY: resource busy or locked, open '...\m45_v03_nebula_closeup.jpg'
文件"..."正由另一进程使用，因此该进程无法访问此文件。
```

Closing the image window does **not** release it, and a re-`saveAs` to the same path
fails (the second attempt silently leaves the file untouched — its `LastWriteTime`
stays at the first write). PI holds the handle.

Two ways out:
1. **Preferred:** do the final conversion outside PI. Save only the XISF from PJSR,
   then write the JPEG yourself (or re-open the XISF in a separate process).
2. Stop PixInsight (`Stop-Process -Id <pid> -Force`), then the handle is released.
   Verified: `LOCK RELEASED - file is readable now`.

Detect a lock without guessing:

```powershell
try { $fs = [System.IO.File]::Open($p, 'Open', 'Read', 'None'); $fs.Close(); 'FREE' }
catch { "LOCKED: $($_.Exception.Message)" }
```

Also: PJSR `File.exists` returns `undefined` in this build, so `File` is **not** a
reliable verification for saved output. Verify with `Get-ChildItem` (`Length` +
`LastWriteTime`) from outside PI.

## `seti_stretch` mutates the view in place

There is no copy. If you save after stretching, the "linear" checkpoint you just
wrote is **already stretched** (measured: an intended linear backup came back with
`median = 0.140214`). Always save the linear XISF *before* calling `seti_stretch`,
and re-check `median < 0.05` before running any linear-stage process on it.

## Denoise plan differs wildly between phases

Same image, `plan_denoise`:

- `phase: "linear"` → `denoise 0.56, detail 0.15` (verdict heavy, local σ/bg 0.1290)
- `phase: "nonlinear"` → `denoise 0.36, detail 0.12` (verdict heavy, local σ/bg 0.1590)

Call it again after stretching; do not reuse the linear numbers.

## Block-median grids CANNOT prove a faint extended target is absent

> **Correction (2026-11-14, same session).** An earlier version of this section claimed
> the M45 frame had "no strong nebula signal" based on a 12x8 block-median grid. That
> was **wrong**, and the user caught it. M45's reflection nebulosity is absolutely
> there — see the next section for what actually fooled the measurement.

A 12x8 block grid is far too coarse for low-surface-brightness extended targets, and
medians inside a block throw away exactly the small, low-contrast signal you're looking
for. On the M45 frame the grid gave `(1716,1489) 0.03976` against `globalMed 0.023563`
(a 1.7x peak), which reads as "flat field" — yet the nebula is plainly visible once the
region is cropped and viewed at native scale.

**Rule: never conclude "the target isn't in the data" from a downscaled full-frame
preview or a coarse grid.** Crop the suspect region to a writable copy and view it at
1:1 first (see `image.crop()` above). Only then talk about signal.

Also confirm the frames really are the target: WBPP's `Center coordinates:` line in the
log is the authority, not the folder name.

## WBPP centre coordinates alone are NOT a target check

`<run>\logs\<timestamp>.log` carries `Center coordinates: RA = ..., Dec = ...`.
M45 (Pleiades) sits at roughly RA 03h47m, Dec +24°; a log line reading
`RA = 09 53 31.309, Dec = +69 06 32.85` is **not** the Pleiades.

But do **not** let that line alone veto an identification. On the M45 run this
coordinate was a WBPP plate-solving artifact/placeholder — the frames demonstrably
contained the Pleiades cluster and its blue reflection nebula. Treat a coordinate
mismatch as "needs verification", and verify by looking at the cropped pixels; the
`Center coordinates:` line is a hint, not proof either way.

# Gotchas from the M27 narrowband run (2026-11-14)

Context: mono camera, 300 s subs, masters `M27_{H,O,S,L,R,G,B}.xisf` at 3840x2160,
channels H 65 / O 35 / S 12 / L 24 / R 33 / G 21 / B 25. Flow A (narrowband) →
HOO composite with SII mixed into red.

## `separate_stars` returns `ok:true` with pure-black output windows

The tool reports success and every statistic is exactly `0`:

```json
{"ok":true,"tool":"StarXTerminator","native":false,
 "starlessStats":{"median":0,"mad":0,"mean":0,"min":0,"max":0},
 "starsStats":   {"median":0,"mad":0,"mean":0,"min":0,"max":0}}
```

Both output windows exist with the right dimensions (1120x1120x3) but
`max = 0.0000` — nothing was written. `ok:true` plus plausible dimensions is not
proof; **read `max`/`median` back from the output views before using them**:

```js
var im = ImageWindow.windowById(starlessId).mainView.image;
if (im.maximum() <= 0) throw new Error('star separation produced an empty image');
```

Fallback that worked: skip separation entirely and use `shrink_stars` on the whole
frame (see below).

## `shrink_stars` — amount below ~0.2 is a silent no-op

`shrink_stars {iterations, size, amount}` on a 1120x1120 crop:

| iterations / size / amount | Result |
|---|---|
| 1 / 2 / 0.12 | **nothing changed** — preview byte-identical (same sha256) to the input |
| 1 / 3 / 0.22 | stars pulled in, nebula intact — the value to use |
| 2 / 3 / 0.45 | **stars erased, nebula smeared into a blob** |

Below the threshold the morphological operator does nothing and still returns
`ok:true` with plausible statistics. Compare the output hash against the input, or
make a preview before committing.

## Weak-signal channels: measure contrast before designing the stretch

On M27 the nebula region read (inside a 640x640 box centred on the object):

| Channel | background | p99 | p99.9 | peak | p99/bg |
|---|---|---|---|---|---|
| H | 0.006767 | 0.016733 | 0.022799 | 0.072098 | **2.47** |
| O | 0.006948 | 0.011784 | 0.012894 | 0.025196 | **1.70** |
| S | 0.005787 | 0.006946 | 0.010118 | 0.084166 | **1.20** |

`p99/bg` under ~3 means a conventional stretch will amplify background grain faster
than it reveals structure. Use it to decide three things: which channel carries the
luminance, how much of each channel goes into the mix (SII at 1.20 got only 35% of
the red), and what stretch target to try.

## The auto-STF preview's white core is NOT clipping

`save_preview` with `is_linear:true` applies an automatic STF, which saturates the
bright core and looks blown out. Measured on the same data: **zero** samples ≥ 0.98 in
the H master, `max = 0.9167` over the whole frame, and only `0.0683` inside the nebula
box. The dynamic range was fine; the signal was merely weak.

Before building a highlight-recovery pipeline, run a clip census:

```js
// percentage of samples at or above a threshold, inside the object box
for (var y = y0; y < y1; y += 3)
  for (var x = x0; x < x1; x += 3) {
    var s = im.sample(x, y);
    if (s >= 0.98) ge98++;
  }
```

If `ge98 == 0`, there is nothing to recover — fix the stretch, not the highlights.

## Stretch target: probe at three points, never reuse the previous object's value

`seti_stretch {target_median}` on the M27 H master:

| target_median | Verdict |
|---|---|
| 0.25 | flat grey sheet, background = 64% of the frame |
| 0.12 | balanced, faint outer shells visible |
| 0.08 | cleanest darkness, object pops, a little outer detail lost |
| **0.10** | **chosen** |

Same lesson as M45 (where the carried-over 0.14 came out too dark): the correct target
depends on the background offset produced by the upstream chain, so it must be
re-measured per object.

## Bridge command queue: check the backlog, never `rm` it while PI runs

The watcher replays every unconsumed file in
`~/.pixinsight-mcp/bridge/commands/` at startup. Left unattended the queue grew to
**113 pending commands**, each pointing at deleted or renamed files → a modal error
dialog per command, and the resulting stalls surfaced as unrelated failures downstream
(`invalid dimension(s)` because a window never opened).

Clearing it while PixInsight runs fails — the watcher holds the handles:

```
Remove-Item : 无法删除项 ...\bridge\commands\<id>.json: 文件 ... 正由另一进程使用
```

(That message is the only evidence that the queue is still draining; it is not a bug in
your own command.)
Correct sequence:

```powershell
Get-Process PixInsight | Stop-Process -Force
Start-Sleep -Seconds 4
# move, don't delete — keeps a rollback path
Move-Item $bridge\commands "$backup\commands"; New-Item -ItemType Directory $bridge\commands
Move-Item $bridge\results  "$backup\results";  New-Item -ItemType Directory $bridge\results
```

Check the backlog count (`Get-ChildItem $bridge\commands -File | Measure-Object`) before
and after any long run; a non-zero count at start means the previous session left a
landmine.

## Pass tool arguments through a JSON file, not the command line

Shell quoting mangles `\"` and eats backslashes, producing commands whose paths have
lost their separators. Write the args object to a file and hand over the path:

```javascript
// pirun_args.mjs
fs.writeFileSync(argsPath, JSON.stringify(args), 'utf-8');
spawnSync(process.execPath, [TOOL, tool, '@' + argsPath], {...});
```

Same for PJSR source: write the snippet to a UTF-8 `.js` file and read it back, rather
than embedding it in a shell string.

## Reusable scripts left on this machine

Both target folders hold the same probe toolkit, so either can be copied into a new run:

| Script | Purpose |
|---|---|
| `pisurvey.mjs` | open every master, print median/mad/sigma/min/max per channel |
| `pisig_probe.mjs` | background / p99 / p99.9 / peak inside an object box → `p99/bg` |
| `picore_probe.mjs` | clip census: % of samples `>= 0.98`, whole frame and object box |
| `pistretch_probe.mjs <ch> <targetMedian> <label>` | stretch sweep, one preview per target |
| `pirun_args.mjs <tool> <args.json>` | run any pi-tool command with args from a file |
| `pirun_pjsr.mjs <file.js>` | execute a PJSR snippet read from a UTF-8 file |
| `picrop3.mjs <xisf\|viewId> <x0> <y0> <x1> <y1> <label> [linear]` | crop via a writable copy, then preview |
| `pngstats.mjs <png> [outPreview]` | 8-bit histogram p1/p50/p99 + `%>=245`, optional downscaled preview |
| `piclip.mjs` | 12x8 grid of `%>=245` — finds which cell is blown out |
| `piclean.mjs ""` | close every image window (does **not** release file handles) |

Locations: `astro\M45run\work\` and `astro\M27run\work\` under the DSH workspace
(`C:\Users\a5093\Documents\deepseek-harness\default-workspace\`).

Closing windows does **not** release `saveAs()` handles — only exiting PixInsight does.

