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

## ImageWindow Constructor — Dimension Bug
PJSR `Image.width` / `Image.height` properties don't pass cleanly as arguments to
`new ImageWindow(width, height, ...)`. The constructor throws "invalid dimension(s)"
even though the values appear correct.

**Workaround: Two-call pattern**
1. First PJSR call: query dimensions as JSON
```javascript
var img = srcW.mainView.image;
JSON.stringify({ w: Math.round(img.width), h: Math.round(img.height) });
```
2. Second PJSR call: use JS template literals to inject literal numbers
```javascript
var mw = new ImageWindow(${dims.w}, ${dims.h}, 1, 32, true, false, 'maskId');
```

The key is that `${dims.w}` gets interpolated by JavaScript (Node.js) into a literal
number like `5972` BEFORE the PJSR code is sent to PixInsight. This avoids passing
PJSR Image property values directly to the constructor.

Also use `floatSample=true` (5th arg) for mask windows — `false` creates integer images
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

`H` is **five arrays** — R, G, B, L, Alpha — and each array is
`[blackPoint, midtones, whitePoint, lowClip, highClip]`:

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
