# ════════════════════════════════════════════════════════════════════════════
# `tools\restart-agent.ps1` 界面判据与四态读数 —— 隔离验收（**一个窗口都不弹**）
#
# 钉三件事（上级 2026-10-08 的裁决）：
#   ① **备用安装不许被误杀**：另一个目录下**同名**的 exe 在跑 ⇒ 跑完必须**仍然活着**（正面断言）
#   ② **目标安装的界面照旧被停**（现有行为不变）
#   ③ **四种形态各自可分辨**：没出现 / 出现即退 / 出现但无窗口 / 出现且有窗口
#
# 替身是**现场编译的无窗口 exe**（`test\stand-in\sleeper.cs`，只忙等、不建窗口、不吃 stdin）。
# **绝不碰用户正在跑的界面**（它在 D:\IrmiaAgent\... 下，本脚本的沙盒在 %TEMP% 下）。
#
# 跑法：pwsh -NoProfile -File test\restart-gui-predicate.ps1
# ════════════════════════════════════════════════════════════════════════════
$ErrorActionPreference = 'Continue'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Script = Join-Path $Repo 'tools\restart-agent.ps1'

$Box = Join-Path $env:TEMP 'irmia-gui-predicate-test'
$DirA = Join-Path $Box 'install-a\gui'     # 目标安装
$DirB = Join-Path $Box 'install-b\gui'     # 备用安装（**同名** exe，不同目录）
$Logs = Join-Path $Box 'logs'
$passed = 0; $failed = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
  if ($Ok) { $script:passed++; Write-Host ("  OK   " + $Name + "  " + $Detail) }
  else { $script:failed++; Write-Host ("  FAIL " + $Name + "  " + $Detail) }
}
function Say([string]$T) { Write-Host $T }
function Is-Running([int]$ProcId) { return ($null -ne (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)) }
function Kill-Box {
  foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if ($p.ExecutablePath -and $p.ExecutablePath.ToLowerInvariant().StartsWith($Box.ToLowerInvariant())) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}
# 替身必须**真的是一个 exe**：`.cmd` 垫片由 cmd.exe 代跑，进程的 ExecutablePath 是 cmd.exe，
# 按全路径永远匹配不到——那样的替身会把四态全"假装"成"没出现"（第一版就这么踩了）。
function Build-Sleeper([string]$OutPath) {
  $src = Join-Path $PSScriptRoot 'stand-in\sleeper.cs'
  $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path $csc)) { $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
  & $csc /nologo /target:exe ("/out:" + $OutPath) $src 2>&1 | Out-Null
  return (Test-Path $OutPath)
}
function Wait-Running([int]$ProcId, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Is-Running $ProcId) { return $true }
    Start-Sleep -Milliseconds 100
  }
  return $false
}
function Start-Stand([string]$Path, [string]$ArgLine) {
  $a = @()
  if ($ArgLine -ne '') { $a = @($ArgLine) }
  $p = Start-Process -FilePath $Path -ArgumentList $a -PassThru -WindowStyle Hidden
  return $p.Id
}
function Run-Script([string]$GuiExe, [string]$Tag, [string]$GuiArgs) {
  $trace = Join-Path $Logs ($Tag + '-trace.log')
  $scriptLog = Join-Path $Logs ($Tag + '-script.log')
  Remove-Item $trace, $scriptLog -Force -ErrorAction SilentlyContinue
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script,
    '-Repo', $Box, '-GuiExe', $GuiExe, '-GuiOnly', '-DelaySeconds', '0',
    '-PortWaitSeconds', '2', '-WaitSeconds', '1', '-TraceLog', $trace, '-ScriptLog', $scriptLog)
  # `-GuiArgs` 是脚本本来就有的口子（"替身要按参数活多久"），替身靠它决定睡多久
  if ($GuiArgs -ne '') { $argv += @('-GuiArgs', $GuiArgs) }
  $out = & pwsh @argv 2>&1 | Out-String
  $code = $LASTEXITCODE
  $traceText = ''
  if (Test-Path $trace) { $traceText = (Get-Content $trace -Encoding UTF8 | Out-String) }
  return [pscustomobject]@{ Out = $out; Code = $code; Trace = $traceText }
}
function State-Of($run) {
  $s = ''
  if ($run.Trace -match '界面拉起=(not-appeared|appeared-then-exited|alive-no-window|alive)') { $s = $Matches[1] }
  return $s
}

# ── 准备沙盒 ────────────────────────────────────────────────────────────────
Kill-Box
Start-Sleep -Milliseconds 500
if (Test-Path $Box) { Remove-Item -Recurse -Force $Box -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $DirA, $DirB, $Logs | Out-Null
$GuiA = Join-Path $DirA 'irmia_gui.exe'    # 目标：活 60 秒
$GuiB = Join-Path $DirB 'irmia_gui.exe'    # 备用：**同名**、不同目录、活 60 秒
$okA = Build-Sleeper $GuiA
$okB = Build-Sleeper $GuiB
$BadExe = Join-Path $DirA 'irmia_bad.exe'  # 没出现：零字节，cmd 建不起来
[System.IO.File]::WriteAllBytes($BadExe, @())
$DieExe = Join-Path $DirA 'irmia_die.exe'  # 出现即退：只活 2 秒
$okD = Build-Sleeper $DieExe

Say ("沙盒：$Box")
Say ("目标安装替身：$GuiA（编译=$okA）")
Say ("备用安装替身：$GuiB（**同名**、不同目录，编译=$okB）")
Say ("出现即退替身：$DieExe（编译=$okD）")
$hostGui = @(Get-Process -Name 'irmia_gui' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -notlike ($Box + '*') } | ForEach-Object { $_.Id })
Say ("用户那个界面（本脚本绝不碰）：$($hostGui -join ',')")
Say ''

if (-not ($okA -and $okB -and $okD)) {
  Say '替身编译失败，后面不用跑了'
  exit 2
}

# ════════════════ ①② 判据：只停目标全路径，备用安装不许被误杀 ════════════════
Say '════ ①② 判据：全路径匹配（备用安装不许被误杀 · 目标照旧被停） ════'
$pidA = Start-Stand $GuiA ''
$pidB = Start-Stand $GuiB ''
$aUp = Wait-Running $pidA 8
$bUp = Wait-Running $pidB 8
Say ("  起好两个替身：目标 pid=$pidA（活=$aUp）· 备用 pid=$pidB（活=$bUp）")
if ($aUp -and $bUp) {
  $r = Run-Script $GuiA 'case12'
  Start-Sleep -Seconds 1
  $aliveA = Is-Running $pidA
  $aliveB = Is-Running $pidB
  Check '① 备用安装（同名、不同目录）**没被误杀**' ($aliveB -eq $true) ("备用 pid=$pidB 跑完仍在=" + $aliveB)
  Check '② 目标安装的界面**被停掉**' ($aliveA -eq $false) ("目标 pid=$pidA 跑完仍在=" + $aliveA)
  Check '① 留痕提到目标路径、不提备用路径' `
    (($r.Trace -match [regex]::Escape($GuiA)) -and ($r.Trace -notmatch [regex]::Escape($GuiB))) `
    '留痕按全路径写'
  $stopLine = @($r.Trace -split "`n" | Where-Object { $_ -match '停界面 PID' })
  if ($stopLine.Count -gt 0) { Say ('    停界面留痕：' + $stopLine[0].Trim()) }
} else {
  Check '替身起得来（测试前置）' $false ('目标活=' + $aUp + ' 备用活=' + $bUp)
}
Kill-Box
Start-Sleep -Milliseconds 500
Say ''

# ════════════════ ③ 四态可分辨 ════════════════
Say '════ ③ 四种形态各自可分辨（替身一律无窗口） ════'

# (a) 没出现：零字节坏 exe
$ra = Run-Script $BadExe 'case-a'
$sa = State-Of $ra
Check '(a) 没出现 ⇒ not-appeared' ($sa -eq 'not-appeared') ("State=" + $sa + " 退出码=" + $ra.Code)

# (b) 出现即退：活 2 秒的替身（活过采样、活不过 3 秒复看 ⇒ 必须被看见过）
#     参数从脚本本来就有的 `-GuiArgs` 进去（替身靠它决定睡多久）
$rb = Run-Script $DieExe 'case-b' '2000'
$sb = State-Of $rb
Check '(b) 出现即退 ⇒ appeared-then-exited' ($sb -eq 'appeared-then-exited') ("State=" + $sb + " 退出码=" + $rb.Code)

# (c) 出现但无窗口：活 60 秒的无窗口替身
Kill-Box
Start-Sleep -Milliseconds 500
$rc = Run-Script $GuiA 'case-c'
$sc = State-Of $rc
Check '(c) 活着但无窗口 ⇒ alive-no-window' ($sc -eq 'alive-no-window') ("State=" + $sc + " 退出码=" + $rc.Code)

Say ''
Say '──────── 四态留痕原文（证据） ────────'
foreach ($t in @(@('a 没出现', $ra), @('b 出现即退', $rb), @('c 出现但无窗口', $rc))) {
  Say ("  [" + $t[0] + "]")
  $hit = @($t[1].Trace -split "`n" | Where-Object { $_ -match '界面读数|窗口读数|拉起失败读数' } | Select-Object -First 2)
  if ($hit.Count -eq 0) { Say '    （没抓到行）' } else { $hit | ForEach-Object { Say ('    ' + $_.Trim()) } }
}
Say ''
Say '──────── 结尾行（`[结束]`：四态与失败原因都写在这里） ────────'
foreach ($t in @(@('a', $ra), @('b', $rb), @('c', $rc))) {
  $end = @($t[1].Trace -split "`n" | Where-Object { $_ -match '\[结束\]' } | Select-Object -First 1)
  if ($end.Count -gt 0) { Say ('  [' + $t[0] + '] ' + $end[0].Trim()) }
}

Kill-Box
Start-Sleep -Milliseconds 500
Say ''
Say ("════ 结果：通过 $passed · 失败 $failed ════")
$hostGui2 = @(Get-Process -Name 'irmia_gui' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -notlike ($Box + '*') } | ForEach-Object { $_.Id })
Say ("用户那个界面（必须仍在跑）：$($hostGui2 -join ',')")
if ($failed -eq 0) { exit 0 } else { exit 1 }
