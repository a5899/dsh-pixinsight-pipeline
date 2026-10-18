<#
.SYNOPSIS
    Run PixInsight WeightedBatchPreprocessing (WBPP) headlessly from the command line.

.DESCRIPTION
    Wraps the fragile WBPP automation invocation so callers do not have to get the
    quoting right. Three rules are baked in, because each was learned from a run that
    silently processed nothing:

      1. All WBPP parameters are joined with commas and placed INSIDE a single -r=
         value. Passed as separate arguments they are interpreted as files to open,
         producing "No such file: .../automationMode=true" and "No files were opened".
      2. The whole -r= value is wrapped in one pair of double quotes, because the
         PixInsight install path contains a space.
      3. WBPP.js is copied to a space-free directory first. PixInsight splits the
         script path at the space in "C:\Program Files\..." otherwise, and the
         arguments after it are discarded.

.PARAMETER InputDir
    One or more directories holding the frames to preprocess. Repeatable.

.PARAMETER OutputDir
    Directory for masters and working frames. Created if missing.

.PARAMETER ExtraParams
    Additional WBPP parameters, e.g. "debayerOutputMethod=0,integrate=true".
    Must be comma-separated with no spaces.

.PARAMETER StagingDir
    Space-free directory for the copied WBPP scripts. Defaults to C:\temp\pi_wbpp.

.EXAMPLE
    .\run-wbpp.ps1 -InputDir "C:\data\lights","C:\data\calib" -OutputDir "C:\data\out"

.NOTES
    The run is synchronous and can take a long time. WBPP exits by itself thanks to
    --force-exit. Read <OutputDir>\logs\<timestamp>.log afterwards: a run that
    "completes" may still have skipped a group (see wbpp-automation.md).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]] $InputDir,

    [Parameter(Mandatory = $true)]
    [string] $OutputDir,

    [string] $ExtraParams = '',

    [string] $StagingDir = 'C:\temp\pi_wbpp'
)

$ErrorActionPreference = 'Stop'

# --- locate PixInsight -----------------------------------------------------
$exe = Join-Path $env:ProgramFiles 'PixInsight\bin\PixInsight.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    throw "PixInsight not found at '$exe'."
}

$srcScripts = Join-Path $env:ProgramFiles 'PixInsight\src\scripts\BatchPreprocessing'
if (-not (Test-Path -LiteralPath $srcScripts)) {
    throw "WBPP scripts not found at '$srcScripts'."
}

# --- validate inputs before doing anything slow ----------------------------
foreach ($d in $InputDir) {
    if (-not (Test-Path -LiteralPath $d)) {
        throw "Input directory does not exist: $d"
    }
    if ($d -match ',') {
        throw "Input directory contains a comma, which WBPP's parameter syntax cannot express: $d"
    }
}

if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

# --- stage the scripts at a space-free path --------------------------------
if (-not (Test-Path -LiteralPath $StagingDir)) {
    New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null
}
if ($StagingDir -match '\s') {
    throw "StagingDir must contain no spaces (PixInsight splits the script path at the space): $StagingDir"
}

$stagedScripts = Join-Path $StagingDir 'BatchPreprocessing'
Copy-Item -LiteralPath $srcScripts -Destination $stagedScripts -Recurse -Force
$wbpp = Join-Path $stagedScripts 'WBPP.js'
if (-not (Test-Path -LiteralPath $wbpp)) {
    throw "WBPP.js missing after copy: $wbpp"
}

# --- build the single -r= value -------------------------------------------
$parts = @($wbpp, 'automationMode=true')
foreach ($d in $InputDir) { $parts += "dir=$d" }
$parts += "outputDirectory=$OutputDir"

if ($ExtraParams) {
    if ($ExtraParams -match '\s') {
        throw "ExtraParams must be comma-separated with no spaces: '$ExtraParams'"
    }
    $parts += $ExtraParams
}

$rValue = '-r=' + ($parts -join ',')
$quoted = '"' + $rValue + '"'

Write-Host "PixInsight : $exe"
Write-Host "WBPP.js    : $wbpp"
Write-Host "Output     : $OutputDir"
Write-Host "Args       : $quoted"
Write-Host ''

# --- run -------------------------------------------------------------------
# Use Start-Process with a single argument string: PowerShell would otherwise
# re-quote the whole thing and the comma-joined value would be split again.
$arguments = "-n --automation-mode $quoted --force-exit"

$proc = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru -Wait -NoNewWindow

if ($proc.ExitCode -ne 0) {
    Write-Warning "PixInsight exited with code $($proc.ExitCode)."
}

# --- summarise -------------------------------------------------------------
$logs = Get-ChildItem -Path (Join-Path $OutputDir 'logs') -Filter '*.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending

if (-not $logs) {
    throw "No log was written under '$OutputDir\logs' — the run did not start. Check the quoting."
}

$log = $logs[0].FullName
Write-Host ''
Write-Host "Log: $log"

$problems = Select-String -Path $log -Pattern 'No image could be registered|Error registering light frames|Unable to find an initial linear transformation' -ErrorAction SilentlyContinue
if ($problems) {
    Write-Warning 'Registration failures detected — the resulting master may be missing or empty:'
    $problems | Select-Object -First 5 | ForEach-Object { Write-Warning "  $($_.Line)" }
    Write-Host ''
    Write-Host 'Common cause: calibration frames filed as lights because their IMAGETYP header is wrong.'
    Write-Host 'Check the "Group of N Light frames" line against the frames you supplied.'
}
else {
    Write-Host 'No registration failures detected in the log.'
}

$masters = Get-ChildItem -Path (Join-Path $OutputDir 'master') -ErrorAction SilentlyContinue
if ($masters) {
    Write-Host ''
    Write-Host 'Masters produced:'
    $masters | Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } |
        Format-Table -AutoSize | Out-String | Write-Host
}
else {
    Write-Warning "No masters in '$OutputDir\master'."
}
