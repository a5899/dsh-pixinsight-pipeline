# dsh-pixinsight-pipeline

**A DeepSeek Harness (DSH) plugin that packages the `pixinsight-pipeline` skill** — automated
deep-sky astrophotography processing driven from DSH through a file-based IPC bridge into a
running PixInsight 1.9.4.

It bundles three things so it works as a normal DSH plugin:

1. the **skill** (`skills/pixinsight-pipeline/SKILL.md` + `reference/` knowledge base),
2. the **bridge CLI** (`lib/pixinsight-mcp/scripts/pi-tool.mjs`) and its ops modules,
3. the **PJSR watcher** (`lib/pixinsight-mcp/pjsr/pixinsight-mcp-watcher.js`) plus the
   headless **WBPP** wrapper (`lib/pixinsight-mcp/run-wbpp.ps1`).

```
DSH agent ── pi-tool.mjs ──> ~/.pixinsight-mcp/bridge/commands/{id}.json
                                   │
       PixInsight ── pixinsight-mcp-watcher.js (PJSR poll loop)
                                   │  reads command, runs PJSR, writes result
                                   ▼
                           ~/.pixinsight-mcp/bridge/results/{id}.json
```

## For AI agents (read me first)

This package is only the **director** side. Before calling `pi-tool`, PixInsight must be
running with the bundled **watcher script** loaded, otherwise every call fails with
`PixInsight process not found`. The exact launch / verify / drive / shutdown steps are in
**[AGENTS.md](AGENTS.md)** — start there, then read `skills/pixinsight-pipeline/SKILL.md`
for the processing order.

## Requirements

| Item | Notes |
|---|---|
| PixInsight | 1.9.4+ with **BXT / NXT / SXT** installed (RC Astro modules) |
| Node.js | ≥ 20 |
| DSH | profile with `dsh.profile.bundles` (desktop/web) |
| OS | Windows primarily (watcher `#include` paths point at `C:/Program Files/PixInsight/src/scripts/AdP/*`). macOS/Linux: adjust those paths. |

## Install

### A. As a DSH plugin (recommended)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-as-plugin.ps1 -Profile desktop
```

It backs up the profile `package.json`, copies the package into the profile `node_modules`,
deploys the bridge toolkit to `%DSH_HOME%\pixinsight-mcp`, and appends the package to
`dsh.profile.bundles`. Then **fully restart DSH**.

Uninstall: `... -Uninstall`.

### B. As a plain skill-root install

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-into-dsh.ps1
```

Copies the skill to `%DSH_HOME%\skills\pixinsight-pipeline` and the toolkit to
`%DSH_HOME%\pixinsight-mcp`. Use **one** of A / B, not both (otherwise the skill appears twice).

## First run

The toolkit lives either at `%DSH_HOME%\pixinsight-mcp` (installed) or in the source tree at
`<workspace>\tools\pixinsight-mcp`. Resolve it once instead of guessing:

```powershell
node "$env:DSH_HOME\pixinsight-mcp\scripts\resolve-toolkit.mjs" --check
```

If that path is missing, run `<workspace>\tools\pixinsight-mcp\scripts\resolve-toolkit.mjs`
instead. It prints the resolved `toolkit` root and per-file checks; every `<toolkit>\...`
below means that root.

1. Open PixInsight and load the watcher:
   `Script > Run Script File…` → `<toolkit>\pjsr\pixinsight-mcp-watcher.js`.
   Keep PixInsight open. The watcher logs `PixInsight MCP Watcher v0.2.0` and polls every 250 ms.
2. Verify the bridge:
   ```powershell
   node "<toolkit>\scripts\pi-tool.mjs" list_open_images '{}'
   ```
   `[]` means alive.

## Usage

The agent reads `skills/pixinsight-pipeline/SKILL.md` for the processing order and parameter
guide, then drives each step. Prefer the `@<file>` JSON form on Windows (PowerShell mangles
inner double quotes):

```powershell
$args = Join-Path $env:TEMP 'piargs.json'
'{"view_id":"MyTarget","denoise":0.25,"detail":0.15}' | Set-Content $args -Encoding UTF8
node "<toolkit>\scripts\pi-tool.mjs" run_nxt "@$args"
```

Headless WBPP (preprocessing) does not need the watcher — run the official automation mode.
The wrapper in this package encodes the quoting rules that make it work (all parameters
comma-joined inside one quoted `-r=` value, `WBPP.js` staged at a space-free path).
`-OutputDir` is optional and defaults to `<first InputDir>\wbpp`, i.e. inside the material folder:

```powershell
powershell -ExecutionPolicy Bypass -File "<toolkit>\run-wbpp.ps1" `
  -InputDir "C:\data\lights"[,"C:\data\calib"] [-OutputDir "C:\data\lights\wbpp"] `
  [-ExtraParams "debayerOutputMethod=0"] [-StagingDir "C:\temp\pi_wbpp"]
```

It also reads the resulting log and warns about the registration failures a "successful"
run can hide. See `skills/pixinsight-pipeline/reference/wbpp-automation.md`.

### Look for a master before running WBPP

WBPP is the fallback, not the opening move. `<toolkit>\scripts\find-masters.mjs` scans a
material folder recursively and reports `ready` / `only_calibration` / `none`, so an existing
master is used instead of stacking the frames again:

```powershell
node "<toolkit>\scripts\find-masters.mjs" --dir "C:\data\lights" --text
```

When WBPP does run, `<toolkit>\scripts\clean-wbpp-intermediates.mjs` reports (and, with
`--yes`, deletes) its scratch tree while preserving `master/`:

```powershell
node "<toolkit>\scripts\clean-wbpp-intermediates.mjs" --dir "C:\data\lights\wbpp" --dry-run
```

## Layout

```
package.json                 # dsh.bundle.patch -> cordis.patch.yml
cordis.patch.yml             # - insert: id: pixinsight-pipeline, name: dsh-pixinsight-pipeline
AGENTS.md                    # step-by-step PixInsight watcher setup for AI agents
lib/index.js                 # registers the bundled skill via ctx.skills.registerProvider()
lib/pixinsight-mcp/          # bridge toolkit (pi-tool CLI, PJSR watcher, WBPP wrapper)
lib/pixinsight-mcp/scripts/  # find-masters, clean-wbpp-intermediates, resolve-toolkit
skills/pixinsight-pipeline/  # SKILL.md + reference/*.md
scripts/                     # install-*.ps1, sync-skill.mjs (keeps the two skill copies in step)
scripts/                     # install-as-plugin.ps1, install-into-dsh.ps1
```

## Notes / gotchas

- `pi-tool`'s `save_preview` / `save_variant` use **forward-slash** paths; Windows backslash
  paths get their `\U` etc. eaten inside PJSR strings.
- `ImageWindow.open()` returns an **array**; use `wins[0].mainView`.
- PixInsight is memory-hungry — call `w.purge()` between heavy steps and close intermediates.
- The watcher runs in PixInsight's PJSR engine; `Ctrl+F11` (or a `shutdown` sentinel file in
  the bridge dir) stops it.
- Data processed with this plugin is **local-only**; never upload the user's raw frames.

## Credits

- Bridge design adapted from [aescaffre/pixinsight-mcp](https://github.com/aescaffre/pixinsight-mcp) (MIT).
- Star-stretch / Seti method: [Seti Astro](https://www.setiastro.com) (Bill Blanshan).
- GHS: [GHS Script](https://ghsastro.co.uk) (Mike Cranfield & Mark Shelley).
- BXT / NXT / SXT are commercial PixInsight modules by RC Astro (not redistributed).

## License

MIT — see [LICENSE](LICENSE).
