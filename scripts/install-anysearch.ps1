<#
.SYNOPSIS
  安装 anysearch skill 到 skills/<name>/（Irmia Agent，design.md §4.18「Skill 目录即装」）。

.DESCRIPTION
  anysearch-ai/anysearch-skill 的 release 没有上传二进制资产，其「发布包」就是 GitHub 的
  tag 源码归档（zipball）。因此本脚本的流程是：解析最新 tag → 下归档 → 解压 → 校验 SKILL.md
  → 落到 skills/<frontmatter.name>/ → 写安装记录 .installed.json。

  三项刻意保留的纪律：
    1. **目录名取 frontmatter 的 name**（官方规范要求两者同名），不靠猜；
    2. **不踩信任门**：装完只是文件到位，skill 仍需人类确认（skill/installed{by:'human'}）
       才进 catalog——外部来源的目录默认不可信（design.md §4.19）；
    3. **留安装记录**：.installed.json 记版本、来源与 SKILL.md 的 sha256，
       升级与复核都有据可查（与信任门的 contentHash 变更检测同源）。

.PARAMETER Tag
  要安装的 tag，默认取最新 release（GitHub API 可达时），否则回落到 v3.1.1。

.PARAMETER Destination
  安装父目录，默认 <仓库根>/skills。最终路径是 <Destination>/<skill 名>。

.PARAMETER Force
  目标目录已存在时覆盖（默认拒绝覆盖，避免把人工改过的内容冲掉）。

.EXAMPLE
  pwsh -File scripts/install-anysearch.ps1
  pwsh -File scripts/install-anysearch.ps1 -Tag v3.1.1 -Force
#>
[CmdletBinding()]
param(
  [string] $Tag = '',
  [string] $Destination = '',
  [switch] $Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Destination)) {
  $Destination = Join-Path $repoRoot 'skills'
}
$owner = 'anysearch-ai'
$repo = 'anysearch-skill'
$fallbackTag = 'v3.1.1'

function Write-Step([string] $Message) { Write-Host "[anysearch] $Message" }

# ── 1. 解析 tag：优先最新 release，网络不通则回落固定版本 ──
if ([string]::IsNullOrWhiteSpace($Tag)) {
  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repo/releases/latest" `
      -Headers @{ 'User-Agent' = 'irmia-agent' } -TimeoutSec 25
    $Tag = [string] $release.tag_name
    Write-Step "最新 release：$Tag"
  } catch {
    $Tag = $fallbackTag
    Write-Step "无法查询最新 release（$($_.Exception.Message)），回落到 $Tag"
  }
}

$archiveUrl = "https://github.com/$owner/$repo/archive/refs/tags/$Tag.zip"
$work = Join-Path ([System.IO.Path]::GetTempPath()) "irmia-anysearch-$Tag"
$zip = "$work.zip"
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zip -Force -ErrorAction SilentlyContinue

# ── 2. 下载 + 解压 ──
Write-Step "下载 $archiveUrl"
Invoke-WebRequest -Uri $archiveUrl -OutFile $zip -TimeoutSec 180
Expand-Archive -Path $zip -DestinationPath $work -Force

$inner = Get-ChildItem -Path $work -Directory | Select-Object -First 1
if ($null -eq $inner) { throw "归档结构异常：解压后没有顶层目录（$work）" }
$skillMd = Join-Path $inner.FullName 'SKILL.md'
if (-not (Test-Path $skillMd)) { throw "归档内没有 SKILL.md：$($inner.FullName)" }

# ── 3. 从 frontmatter 取 name（官方规范：name 必须与目录同名）──
$head = Get-Content -Path $skillMd -TotalCount 40
$name = $null
foreach ($line in $head) {
  if ($line -match '^\s*name\s*:\s*(.+?)\s*$') {
    $name = $Matches[1].Trim().Trim('"').Trim("'")
    break
  }
}
if ([string]::IsNullOrWhiteSpace($name)) { throw "SKILL.md 的 frontmatter 里没有 name：$skillMd" }
if ($name -notmatch '^[a-z0-9]+(-[a-z0-9]+)*$') { throw "skill 名不合规（只允许小写与连字符）：$name" }

$target = Join-Path $Destination $name
if ((Test-Path $target) -and (-not $Force)) {
  throw "目标已存在：$target（要覆盖请加 -Force；已确认过的技能被静默覆盖会绕过信任门）"
}

# ── 4. 落盘：复制归档内容，跳过 .github（上游 CI 定义对本地 skill 无意义）──
New-Item -ItemType Directory -Force -Path $target | Out-Null
Get-ChildItem -Path $inner.FullName -Force | Where-Object { $_.Name -ne '.github' } | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination $target -Recurse -Force
}
Write-Step "已安装到 $target"

# ── 5. 写安装记录（版本 + 来源 + SKILL.md 哈希）──
$hash = (Get-FileHash -Path (Join-Path $target 'SKILL.md') -Algorithm SHA256).Hash.ToLowerInvariant()
$record = [ordered]@{
  name        = $name
  version     = $Tag.TrimStart('v')
  source      = "https://github.com/$owner/$repo"
  tag         = $Tag
  archive     = $archiveUrl
  installedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  skillMdSha256 = $hash
}
$record | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $target '.installed.json') -Encoding utf8
Write-Step "SKILL.md sha256：$hash"

Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zip -Force -ErrorAction SilentlyContinue

# ── 6. 信任门提示：装好不等于生效 ──
Write-Host ''
Write-Step "安装完成。注意：外部来源的 skill 默认不进 catalog（design.md §4.19 信任门）。"
Write-Step "确认方式：由人在宿主侧记录一条 skill/installed { by: 'human' } 事件（SkillManager.confirm('$name')）。"
Write-Step "确认前模型仍可用 read_file 读 $name/SKILL.md，但它不会出现在技能索引里。"
