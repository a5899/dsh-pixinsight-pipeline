# AGENTS.md — operating instructions for AI agents

This repository packages the **`pixinsight-pipeline`** skill as a DSH plugin. If you are an
agent asked to process deep-sky astro images with it, read this file first, then read
`skills/pixinsight-pipeline/SKILL.md` for the pipeline order and parameter guide.

The plugin is only the **director**. PixInsight itself does the work, and PixInsight must be
running **with the bundled watcher script loaded** — otherwise every `pi-tool` call fails
with `PixInsight process not found`.

---

## 1. Make sure the PixInsight-side script is loaded

The watcher script lives at one of:

| Install method | Watcher path |
|---|---|
| Installed as a DSH plugin | `%DSH_HOME%\pixinsight-mcp\pjsr\pixinsight-mcp-watcher.js` |
| Running from source | `lib/pixinsight-mcp/pjsr/pixinsight-mcp-watcher.js` |

### Option A — headless auto-load (preferred)

```powershell
$pi = "C:\Program Files\PixInsight\bin\PixInsight.exe"
$w  = "$env:DSH_HOME\pixinsight-mcp\pjsr\pixinsight-mcp-watcher.js"
Start-Process $pi -ArgumentList '-n','--automation-mode',("-r=" + $w)
```

PixInsight takes ~20–40 s to boot and compile the watcher (it pulls in the AdP
ImageSolver libraries). Wait, then verify.

### Option B — manual load

1. Open PixInsight.
2. `Script > Run Script File…` → select the watcher `.js`.
3. Keep PixInsight open. The Process Console prints
   `PixInsight MCP Watcher v0.1.0 … Polling every 1000ms`.

### Verify the bridge

```powershell
node "$env:DSH_HOME\pixinsight-mcp\scripts\pi-tool.mjs" list_open_images '{}'
```

- `[]` → bridge alive, go ahead.
- `PixInsight process not found` → PixInsight is not running or the watcher was not loaded.
  Fix that **before** any processing call.

---

## 2. How to drive processing

Read `skills/pixinsight-pipeline/SKILL.md`, then run **one step at a time** with `pi-tool`:

```powershell
$piTool = "$env:DSH_HOME\pixinsight-mcp\scripts\pi-tool.mjs"
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

```powershell
powershell -ExecutionPolicy Bypass -File "$env:DSH_HOME\pixinsight-mcp\run-wbpp.ps1" `
  -InputDir "<lights dir>" -OutputDir "<out dir>"
```

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
