# run-wbpp.ps1 — drive PixInsight's WeightedBatchPreprocessing in CLI automation mode.
# Usage:
#   powershell -File run-wbpp.ps1 -InputDir "C:\path\素材" [-OutputDir "C:\path\out"] \
#       [-ExtraParams "imageRegistration=true,integrate=true,debayerOutputMethod=0"]
#
# OutputDir defaults to <InputDir>\wbpp — WBPP output lives in the material folder, right
# next to the frames, so the master-locator finds it on the next run without a search.
# Expected behavior: PixInsight launches, processes the frames, writes outputs and exits.

param(
    [Parameter(Mandatory = $true)][string]$InputDir,
    # Optional: defaults to <InputDir>\wbpp (material folder), not a scratch dir elsewhere.
    [string]$OutputDir = "",
    [string]$ExtraParams = "",
    [switch]$NoIntegrate,
    # Opt-in escape hatch: launch even though another PixInsight is already running.
    [switch]$Force
)

$pi   = "C:\Program Files\PixInsight\bin\PixInsight.exe"
$wbpp = "C:\Program Files\PixInsight\src\scripts\BatchPreprocessing\WBPP.js"

if (-not (Test-Path $InputDir)) { Write-Error "InputDir not found: $InputDir"; exit 1 }

if (-not $OutputDir) { $OutputDir = Join-Path (Resolve-Path $InputDir).Path "wbpp" }
if (-not (Test-Path $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null }

# --- single-instance guard -------------------------------------------------
# A second PixInsight — especially a second WBPP on the same files — does not just
# run slower: both instances block on the same dataset and the job looks hung.
# Measured on Sh2-129 (docs/pipeline-failures.md 17). Refuse by default.
$running = @(Get-Process PixInsight -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    $pids = ($running | ForEach-Object { $_.Id }) -join ', '
    if (-not $Force) {
        Write-Host "=== REFUSED: PixInsight is already running (pid $pids) ==="
        Write-Host "A second instance would block on the same files and look hung."
        Write-Host "Close it, wait for the running job, or use -Force only if you know why."
        exit 3
    }
    Write-Host "=== -Force given: starting anyway alongside pid $pids ==="
}

$params = "automationMode=true,dir=$InputDir,outputDirectory=$OutputDir"
if ($NoIntegrate) { $params += ",integrate=false" } else { $params += ",integrate=true,imageRegistration=true" }
if ($ExtraParams) { $params += ",$ExtraParams" }

$argList = @(
    "-n",
    "--automation-mode",
    "-r=$wbpp,$params",
    "--force-exit"
)

Write-Host "=== WBPP automation ==="
Write-Host "PixInsight : $pi"
Write-Host "Input      : $InputDir"
Write-Host "Output     : $OutputDir"
Write-Host "Params     : $params"
Write-Host "Launching..."

& $pi @argList
$code = $LASTEXITCODE

# The launcher can return while PixInsight is still working (WBPP prints nothing to
# stdout in automation mode and buffers the rest). Wait for the process to be gone
# before judging the output, then report.
$deadline = (Get-Date).AddMinutes(15)
while ((Get-Process PixInsight -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
}
Write-Host "PixInsight exited with code $code"

# --- output check -----------------------------------------------------------
# The automation exit code is not a result: WBPP can finish "successfully" having
# calibrated nothing (e.g. a truncated dark makes every flat fail, and then no
# light survives calibration). Look for the masters the job was asked to produce.
$masters = @(Get-ChildItem (Join-Path $OutputDir "master") -Filter "*.xisf" -ErrorAction SilentlyContinue)
$masters = @($masters | Where-Object { $_.Name -notmatch '^master(Dark|Bias|Flat)' })
if ($masters.Count -eq 0) {
    Write-Host "=== FAILED: no masterLight written to $OutputDir\master ==="
    $latestLog = Get-ChildItem (Join-Path $OutputDir "logs") -Filter "*.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime | Select-Object -Last 1
    if ($latestLog) {
        Write-Host "Last errors from $($latestLog.Name):"
        Select-String -Path $latestLog.FullName -Pattern '\*\*\* Error|!!! Error|Calibration failed' |
            Select-Object -First 10 | ForEach-Object { Write-Host "  $($_.Line)" }
    }
    exit 4
}
$masters | ForEach-Object { Write-Host "master: $($_.Name) ($([math]::Round($_.Length/1MB)) MB)" }

# --- intermediate cleanup prompt -------------------------------------------
# WBPP's work tree (registered/calibrated/debayer/cache/logs) dwarfs the masters and is
# rebuilt by any re-run. Report what it costs and let the caller ask the user — never
# delete here. --dry-run is the default, so this line is a read-only size report.
$cleaner = Join-Path $PSScriptRoot "scripts\clean-wbpp-intermediates.mjs"
if (Test-Path $cleaner) {
    $report = & node $cleaner --dir $OutputDir --dry-run 2>$null
    if ($LASTEXITCODE -eq 0) {
        try {
            $r = $report | ConvertFrom-Json
            Write-Host "intermediates: $($r.reclaim.mib) MiB in $($r.reclaim.files) files ($($r.targets.Count) target(s)); $($r.mastersPreserved.Count) master(s) kept"
            Write-Host "ASK THE USER before deleting. Then: node `"$cleaner`" --dir `"$OutputDir`" --yes"
        } catch { }
    }
}
exit $code
