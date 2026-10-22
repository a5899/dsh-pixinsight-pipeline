<#
.SYNOPSIS
  把 dsh-pixinsight-pipeline 作为 DSH 插件安装进 profile（推荐方式）。
.DESCRIPTION
  做四件事：
    1) 备份 profile 的 package.json / pnpm-lock.yaml
    2) 把本包复制进 profile 的 node_modules
    3) 把包内 lib/pixinsight-mcp 部署到 %DSH_HOME%\pixinsight-mcp（技能里引用的稳定路径）
    4) 把包名写进 profile package.json 的 dsh.profile.bundles —— 插件与包内技能由 DSH 自己加载
  装完需要重启 DSH（完全退出后重新打开）才会加载新插件。
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-as-plugin.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-as-plugin.ps1 -Profile desktop
  powershell -ExecutionPolicy Bypass -File scripts\install-as-plugin.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$DshHome = $env:DSH_HOME,
  [string]$Profile = 'desktop',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$pkg = Split-Path -Parent $PSScriptRoot
$pkgName = 'dsh-pixinsight-pipeline'
$toolkitName = 'pixinsight-mcp'

function Info($m) { Write-Host "[plugin] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[   ok ] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[ warn ] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[ fail ] $m" -ForegroundColor Red; exit 1 }

if (-not $DshHome) { Die '设置 DSH_HOME 环境变量，或用 -DshHome 指定（例如 C:\Users\you\.dsh）' }
if (-not (Test-Path $DshHome)) { Die "DSH_HOME 不存在：$DshHome" }

$profileDir = Join-Path $DshHome "profiles\$Profile"
$profileJson = Join-Path $profileDir 'package.json'
if (-not (Test-Path $profileJson)) { Die "找不到 profile：$profileJson（先运行一次 DSH，或用 -Profile 指定）" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ---------------------------------------------------------------- 卸载
if ($Uninstall) {
  Copy-Item $profileJson "$profileJson.bak-$stamp" -Force
  $text = Get-Content $profileJson -Raw -Encoding UTF8
  $text = [regex]::Replace($text, "(\s*`"$pkgName`",\r?\n)", "`n")
  [System.IO.File]::WriteAllText($profileJson, $text, (New-Object System.Text.UTF8Encoding($false)))
  $target = Join-Path $profileDir "node_modules\$pkgName"
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  Ok "已从 bundles 与 node_modules 移除 $pkgName（备份：package.json.bak-$stamp）"
  Info '重启 DSH 后生效。%DSH_HOME%\pixinsight-mcp 未删除（如无其他用途可手动删）。'
  exit 0
}

# ---------------------------------------------------------------- 备份
Copy-Item $profileJson "$profileJson.bak-$stamp" -Force
if (Test-Path (Join-Path $profileDir 'pnpm-lock.yaml')) {
  Copy-Item (Join-Path $profileDir 'pnpm-lock.yaml') (Join-Path $profileDir "pnpm-lock.yaml.bak-$stamp") -Force
}
Ok "已备份 profile 配置（后缀 $stamp）"

# ---------------------------------------------------------------- 安装本体（复制模式，不依赖 pnpm）
$target = Join-Path $profileDir "node_modules\$pkgName"
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $target | Out-Null
foreach ($item in @('lib', 'skills', 'scripts', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE')) {
  $src = Join-Path $pkg $item
  if (Test-Path $src) { Copy-Item $src $target -Recurse -Force }
}
Ok "已复制插件到 $target"

# ---------------------------------------------------------------- 部署桥接工具到稳定路径
$toolkitDst = Join-Path $DshHome $toolkitName
if (Test-Path $toolkitDst) { Remove-Item $toolkitDst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $toolkitDst | Out-Null
Copy-Item (Join-Path $pkg 'lib\pixinsight-mcp\*') $toolkitDst -Recurse -Force
Ok "已部署桥接 CLI 到 $toolkitDst"

# ---------------------------------------------------------------- ASTAP / 星表
# SPCC 需要星表。Gaia 要 PI 账号且约 40GB，所以用 ASTAP 替代。这一步检测 ASTAP、
# 核对星表文件、并修正让所有解析静默失败的 ref_database 错配。
# 不下载星表（400MB~数GB）：只报告，由调用者问用户。
$ensure = Join-Path $toolkitDst 'scripts\ensure-astap.mjs'
if (Test-Path $ensure) {
    Info '检查 ASTAP / 星表...'
    try {
        $astap = (& node $ensure --json 2>$null | Out-String) | ConvertFrom-Json
        if ($astap.ok) {
            Ok "ASTAP 就绪：$($astap.summary)"
            if ($astap.fixes -and $astap.fixes.Count -gt 0) {
                $astap.fixes | ForEach-Object { Write-Host "       已修复: $_" -ForegroundColor Yellow }
            }
        } else {
            Write-Host "[warn ] ASTAP 未就绪：$($astap.summary)" -ForegroundColor Yellow
            if ($astap.installHint) { Write-Host "        $($astap.installHint)" -ForegroundColor DarkGray }
            if ($astap.needsCatalogDownload) {
                Write-Host "        星表下载：$($astap.downloadUrl)  （D20 约 400 MB）" -ForegroundColor DarkGray
            }
            Write-Host "        装好后重跑：node `"$ensure`"" -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "[warn ] ASTAP 检测失败（不影响插件安装）：$($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------- 登记 bundles（保留文件格式的定点插入）
$text = Get-Content $profileJson -Raw -Encoding UTF8
if ($text -notmatch [regex]::Escape("`"$pkgName`"")) {
  $pattern = '(?s)("bundles"\s*:\s*\[)(.*?)(\s*\])'
  $m = [regex]::Match($text, $pattern)
  if (-not $m.Success) { Die 'profile package.json 里找不到 dsh.profile.bundles，请手工添加 ' + $pkgName }
  $inner = $m.Groups[2].Value.TrimEnd()
  $sep = if ($inner.Trim().Length -gt 0) { ',' } else { '' }
  $replacement = $m.Groups[1].Value + $inner + $sep + "`n        `"$pkgName`"" + $m.Groups[3].Value
  $text = $text.Remove($m.Index, $m.Length).Insert($m.Index, $replacement)
  [System.IO.File]::WriteAllText($profileJson, $text, (New-Object System.Text.UTF8Encoding($false)))
  Ok '已写入 dsh.profile.bundles'
} else {
  Ok 'bundles 里已存在，跳过'
}

# ---------------------------------------------------------------- 校验
try {
  Get-Content $profileJson -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
  Ok 'profile package.json JSON 合法'
} catch {
  Copy-Item "$profileJson.bak-$stamp" $profileJson -Force
  Die "写入后 JSON 非法，已回滚：$($_.Exception.Message)"
}

Write-Host ''
Info '完成。请完全退出 DSH 后重新打开，插件与 pixinsight-pipeline 技能会在启动时加载。'
Info '首次使用前：打开 PixInsight，Script > Run Script File… 选'
Write-Host "        $toolkitDst\pjsr\pixinsight-mcp-watcher.js" -ForegroundColor DarkGray
