# run-wbpp.ps1 — drive PixInsight's WeightedBatchPreprocessing in CLI automation mode.
# Usage:
#   powershell -File run-wbpp.ps1 -InputDir "C:\path\lights" -OutputDir "C:\path\out" \
#       [-ExtraParams "imageRegistration=true,integrate=true,debayerOutputMethod=0"]
# Expected behavior: PixInsight launches, processes the frames, writes outputs and exits.

param(
    [Parameter(Mandatory = $true)][string]$InputDir,
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [string]$ExtraParams = "",
    [switch]$NoIntegrate
)

$pi   = "C:\Program Files\PixInsight\bin\PixInsight.exe"
$wbpp = "C:\Program Files\PixInsight\src\scripts\BatchPreprocessing\WBPP.js"

if (-not (Test-Path $InputDir)) { Write-Error "InputDir not found: $InputDir"; exit 1 }

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
Write-Host "PixInsight exited with code $LASTEXITCODE"
