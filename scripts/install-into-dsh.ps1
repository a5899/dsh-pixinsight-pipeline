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

# --- Gaia star catalog ---------------------------------------------------
# ImageSolver and SPCC both need a star catalog, and both fail SILENTLY
# without one (clean return, not a single pixel changed). The catalog itself
# is only distributed behind the PixInsight login and cannot be registered
# from a script, so this step detects the state and prints the manual steps.
$ensureGaia = Join-Path $toolkitDst 'scripts\ensure-gaia.mjs'
if (Test-Path $ensureGaia) {
    Info 'Gaia: checking star catalog...'
    try {
        $gaia = (& node $ensureGaia --json 2>$null | Out-String) | ConvertFrom-Json
        if ($gaia.detection.ok -and $gaia.detection.pi.databaseFilePaths.Count -gt 0) {
            Ok "Gaia 星表已配置（$($gaia.detection.pi.databaseFilePaths.Count) 个文件）"
        } else {
            Write-Host "[warn ] Gaia 星表未配置：SPCC 会静默失效，ImageSolver 仍可用内置星表" -ForegroundColor Yellow
            Write-Host "        手动安装：Processes > Star Catalogs > Gaia > Preferences" -ForegroundColor DarkGray
            Write-Host "                  > Data Release: Gaia DR3/SP > Select 选择 .xpsd 文件" -ForegroundColor DarkGray
            Write-Host "        复检：node `"$ensureGaia`" --verify" -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "[warn ] Gaia 检测失败（不影响技能安装）：$($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Info '重启 DSH 后技能生效。'
