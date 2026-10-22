# AGENTS.md — operating instructions for AI agents

This repository packages the **`pixinsight-pipeline`** skill as a DSH plugin. If you are an
agent asked to process deep-sky astro images with it, read this file first, then read
`skills/pixinsight-pipeline/SKILL.md` for the pipeline order and parameter guide.

The plugin is only the **director**. PixInsight itself does the work, and PixInsight must be
running **with the bundled watcher script loaded** — otherwise every `pi-tool` call fails
with `PixInsight process not found`.

---

## 0. Resolve the toolkit first

The toolkit lives in one of two places — installed (`%DSH_HOME%\pixinsight-mcp`) or the
source tree (`<workspace>\tools\pixinsight-mcp`). Do not hardcode either; ask the resolver:

```powershell
node "$env:DSH_HOME\pixinsight-mcp\scripts\resolve-toolkit.mjs" --check
```

If that file does not exist, use `<workspace>\tools\pixinsight-mcp\scripts\resolve-toolkit.mjs`.
`ok: true` means `pi-tool`, the watcher and the WBPP wrapper were all found; the JSON also
reports the resolved `toolkit` root. Every `<toolkit>\...` path below means that root.

## 1. Make sure the PixInsight-side script is loaded

The watcher script lives at:

| Install method | Watcher path |
|---|---|
| Installed as a DSH plugin | `%DSH_HOME%\pixinsight-mcp\pjsr\pixinsight-mcp-watcher.js` |
| Running from source | `<workspace>\tools\pixinsight-mcp\pjsr\pixinsight-mcp-watcher.js` |

Either way, `<toolkit>\pjsr\pixinsight-mcp-watcher.js` from Step 0 is the real file.

### Option A — headless auto-load (preferred)

```powershell
$pi = "C:\Program Files\PixInsight\bin\PixInsight.exe"
$w  = "<toolkit>\pjsr\pixinsight-mcp-watcher.js"
Start-Process $pi -ArgumentList '-n','--automation-mode',("-r=" + $w)
```

PixInsight takes ~20–40 s to boot and compile the watcher (it pulls in the AdP
ImageSolver libraries). Wait, then verify.

### Option B — manual load

1. Open PixInsight.
2. `Script > Run Script File…` → select the watcher `.js`.
3. Keep PixInsight open. The Process Console prints
   `PixInsight MCP Watcher v0.2.0 … Polling every 250ms`.

### Verify the bridge

```powershell
node "<toolkit>\scripts\pi-tool.mjs" list_open_images '{}'
```

- `[]` → bridge alive, go ahead.
- `PixInsight process not found` → PixInsight is not running or the watcher was not loaded.
  Fix that **before** any processing call.

---

## 2. How to drive processing

Read `skills/pixinsight-pipeline/SKILL.md`, then run **one step at a time** with `pi-tool`:

```powershell
$piTool = "<toolkit>\scripts\pi-tool.mjs"
node $piTool list_open_images '{}'
node $piTool get_image_stats '{"view_id":"MyTarget"}'
```

On Windows/PowerShell, always pass JSON via a file (`@<path>`), because PowerShell strips
inner double quotes:

```powershell
'{"view_id":"MyTarget","denoise":0.25,"detail":0.15}' | Set-Content "$env:TEMP\pi.json" -Encoding UTF8
node $piTool run_nxt "@$env:TEMP\pi.json"
```

Key pitfalls (full list in `reference/pjsr-gotchas.md`):

- `ImageWindow.open(path)` returns an **array** → use `wins[0].mainView`.
- PJSR is ECMAScript 5: no `let`/`const`/arrow functions inside `pjsr` code.
- PixelMath has no `pow()` → use `exp(exponent*ln(base))`.
- After heavy steps call `purge_undo` / `w.purge()` and close intermediates — PixInsight
  crashes under memory pressure.
- Use **forward slashes** in PJSR file paths (backslash `\U` etc. get eaten).

## 2b. Read the rig from the data — never hardcode equipment

Before SPCC / plate-solving, read the actual acquisition metadata from the input headers:

```powershell
node $piTool get_fits_keywords '{"view_id":"MyTarget"}'
```

Use `INSTRUME` / `TELESCOP` / `FOCALLEN` / `XPIXSZ` / `BAYERPAT` / `FILTER` to configure
SPCC curves and the ImageSolver plate scale (`206.265 * pixelSize_um / focal_mm`). Rigs
differ per user — do **not** assume a fixed camera or filter set; if the keywords are
missing, ask the user instead of inventing a profile.

## 3. WBPP preprocessing (headless, no watcher needed)

**Look for an existing master first** — do not ask the user whether to run WBPP before you
have checked the material folder:

```powershell
node "<toolkit>\scripts\find-masters.mjs" --dir "<素材文件夹>" --text
```

`verdict=ready` → use that master and skip WBPP. Only `none` / `only_calibration` justify
asking the user, and the question must name the folder and what was found.

`-OutputDir` is optional and defaults to `<InputDir>\wbpp`, i.e. inside the material folder:

```powershell
powershell -ExecutionPolicy Bypass -File "<toolkit>\run-wbpp.ps1" `
  -InputDir "<素材文件夹>" [-OutputDir "<素材文件夹>\wbpp"]
```

After a successful run, report the size of WBPP's scratch tree and **ask** before deleting it:

```powershell
node "<toolkit>\scripts\clean-wbpp-intermediates.mjs" --dir "<素材文件夹>\wbpp" --dry-run
```

`--dry-run` is the default; `--yes` deletes. It refuses (exit 2) without a light master to
protect and never touches `master/`.

Do not run WBPP while the watcher instance is busy — it starts a second PixInsight process.

## 4. Stopping the watcher

- Press `Ctrl+F11` in PixInsight, **or**
- write a `shutdown` sentinel into the bridge dir:
  ```powershell
  New-Item -ItemType File -Path "$env:USERPROFILE\.pixinsight-mcp\bridge\shutdown" -Force
  ```

## 5. Safety

- **Never upload** the user's raw frames, calibrated masters, or processed outputs anywhere.
- Ask before deleting user data; prefer moving to trash.
- Close images aggressively; keep the session image pool small (prefer `get_image_stats`
  over reading many previews).
