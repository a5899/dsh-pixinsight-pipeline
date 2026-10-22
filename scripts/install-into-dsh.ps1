<#
.SYNOPSIS
  把 pixinsight-pipeline 技能装到用户技能根（~/.dsh/skills），不走插件机制。
.DESCRIPTION
  适合不想改 profile bundles、或想手动控制的情况。做两件事：
    1) skills/pixinsight-pipeline  ->  %DSH_HOME%\skills\pixinsight-pipeline
    2) lib/pixinsight-mcp          ->  %DSH_HOME%\pixinsight-mcp
  注意：这与「插件安装」二选一；两边都装会出现同名技能两份。
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-into-dsh.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-into-dsh.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$DshHome = $env:DSH_HOME,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$pkg = Split-Path -Parent $PSScriptRoot
$skillName = 'pixinsight-pipeline'

function Info($m) { Write-Host "[skill] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[  ok ] $m" -ForegroundColor Green }
function Die($m)  { Write-Host "[fail ] $m" -ForegroundColor Red; exit 1 }

if (-not $DshHome) { Die '设置 DSH_HOME 环境变量，或用 -DshHome 指定' }
if (-not (Test-Path $DshHome)) { Die "DSH_HOME 不存在：$DshHome" }

$skillDst = Join-Path $DshHome "skills\$skillName"
$toolkitDst = Join-Path $DshHome 'pixinsight-mcp'

if ($Uninstall) {
  if (Test-Path $skillDst) { Remove-Item $skillDst -Recurse -Force; Ok "已移除 $skillDst" }
  if (Test-Path $toolkitDst) { Remove-Item $toolkitDst -Recurse -Force; Ok "已移除 $toolkitDst" }
  exit 0
}

if (Test-Path $skillDst) { Remove-Item $skillDst -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Split-Path $skillDst) | Out-Null
Copy-Item (Join-Path $pkg "skills\$skillName") $skillDst -Recurse -Force
Ok "已安装技能到 $skillDst"

if (Test-Path $toolkitDst) { Remove-Item $toolkitDst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $toolkitDst | Out-Null
Copy-Item (Join-Path $pkg 'lib\pixinsight-mcp\*') $toolkitDst -Recurse -Force
Ok "已部署桥接 CLI 到 $toolkitDst"

# --- ASTAP / star catalog ------------------------------------------------
# PixInsight's SPCC needs a star catalog. Gaia needs a PI account and ~40 GB, so ASTAP is
# the practical fallback. Only the headless astap_cli is usable from a script: the GUI
# astap.exe opens a window and blocks forever on any solve/convert call.
# The installer tries to fetch a headless solver, reuses an existing catalog, then
# re-verifies. It never downloads a catalog (400 MB - several GB) and never claims a
# success it cannot prove.
$ensure = Join-Path $toolkitDst 'scripts\ensure-astap.mjs'
if (Test-Path $ensure) {
    Info 'ASTAP: checking headless solver + star catalog...'
    try {
        $astap = (& node $ensure --json 2>$null | Out-String) | ConvertFrom-Json
        if ($astap.ok) {
            Ok "ASTAP 就绪：$($astap.summary)"
            $astap.steps | ForEach-Object { Write-Host "        $_" -ForegroundColor DarkGray }
        } else {
            Write-Host "[warn ] ASTAP 未就绪：$($astap.summary)" -ForegroundColor Yellow
            foreach ($s in $astap.steps) { Write-Host "        ok: $s" -ForegroundColor DarkGray }
            if ($astap.needsUserAction) {
                Write-Host "        需要手动完成：$($astap.needsUserAction.what)" -ForegroundColor Yellow
                $astap.needsUserAction.manualSteps | ForEach-Object { Write-Host "          - $_" -ForegroundColor DarkGray }
            }
            Write-Host "        复检：node `"$ensure`" --check --test-image <一张真实图像>" -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "[warn ] ASTAP 检测失败（不影响技能安装）：$($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Info '重启 DSH 后技能生效。'
