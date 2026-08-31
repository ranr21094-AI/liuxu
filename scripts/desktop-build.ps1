$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$projectDrive = [System.IO.Path]::GetPathRoot($projectRoot).TrimEnd('\')
if ($projectDrive -ne 'C:') {
  throw "C 盘客户端必须从 C 盘项目构建，当前目录：$projectRoot"
}

$cacheDrive = [System.IO.DriveInfo]::new('D')
$minimumFreeBytes = 5GB
if ($cacheDrive.AvailableFreeSpace -lt $minimumFreeBytes) {
  $freeGB = [math]::Round($cacheDrive.AvailableFreeSpace / 1GB, 2)
  throw "D 盘构建缓存空间不足：剩余 ${freeGB} GB，至少需要 5 GB。"
}

$projectDisk = [System.IO.DriveInfo]::new('C')
$minimumProjectFreeBytes = 800MB
if ($projectDisk.AvailableFreeSpace -lt $minimumProjectFreeBytes) {
  $freeMB = [math]::Round($projectDisk.AvailableFreeSpace / 1MB)
  throw "C 盘项目输出空间不足：剩余 ${freeMB} MB，至少需要 800 MB。"
}

$buildRoot = 'D:\Temp\work-log-build-c'
$tempDir = Join-Path $buildRoot 'temp'
$npmCache = Join-Path $buildRoot 'npm-cache'
$electronCache = Join-Path $buildRoot 'electron-cache'
$electronBuilderCache = Join-Path $buildRoot 'electron-builder-cache'
foreach ($directory in @($buildRoot, $tempDir, $npmCache, $electronCache, $electronBuilderCache)) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$env:TEMP = $tempDir
$env:TMP = $tempDir
$env:npm_config_cache = $npmCache
$env:ELECTRON_CACHE = $electronCache
$env:ELECTRON_BUILDER_CACHE = $electronBuilderCache
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'

function Invoke-NativeStep {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )
  Write-Host "`n==> $Name"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Name 失败，退出码 $LASTEXITCODE"
  }
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
  } finally {
    $stream.Dispose()
    $algorithm.Dispose()
  }
}

function Invoke-TestsWithTimeout {
  param([int]$TimeoutMinutes = 15)
  Write-Host "`n==> 运行全量测试（最长 $TimeoutMinutes 分钟）"
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $buildRoot "tests-$stamp.out.log"
  $stderr = Join-Path $buildRoot "tests-$stamp.err.log"
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $env:ComSpec
  $startInfo.Arguments = "/d /s /c `"`"$npm`" test`""
  $startInfo.WorkingDirectory = $projectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw '无法启动 npm test'
  }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutMinutes * 60 * 1000)) {
    & taskkill.exe /PID $process.Id /T /F | Out-Null
    throw "全量测试超过 $TimeoutMinutes 分钟，已终止进程树。日志：$stdout / $stderr"
  }
  $process.WaitForExit()
  $exitCode = $process.ExitCode
  $stdoutText = $stdoutTask.Result
  $stderrText = $stderrTask.Result
  $stdoutText | Set-Content -LiteralPath $stdout -Encoding utf8
  $stderrText | Set-Content -LiteralPath $stderr -Encoding utf8
  if ($stdoutText) { Write-Host $stdoutText }
  if ($stderrText) { Write-Host $stderrText }
  if ($exitCode -ne 0) {
    throw "全量测试失败，退出码 $exitCode。日志：$stdout / $stderr"
  }
}

Push-Location $projectRoot
try {
  $runningDesktop = Get-Process -Name 'Work Log', 'LiuXu' -ErrorAction SilentlyContinue
  if ($runningDesktop) {
    throw '检测到正在运行的留序（或旧版 Work Log）。请先退出客户端再构建。'
  }

  Invoke-NativeStep -Name '安装锁定依赖（跳过第三方安装脚本和未使用的可选原生模块）' -Command { npm ci --ignore-scripts --omit=optional }
  Invoke-NativeStep -Name '下载锁定的 Electron 运行时' -Command { node node_modules/electron/install.js }
  $sqlitePrebuild = Join-Path $projectRoot 'node_modules\better-sqlite3\prebuilds\win32-x64.node'
  if (-not (Test-Path -LiteralPath $sqlitePrebuild -PathType Leaf)) {
    throw "缺少 better-sqlite3 Windows x64 预编译文件：$sqlitePrebuild"
  }
  Write-Host "已验证 SQLite 原生模块：$sqlitePrebuild"
  Invoke-NativeStep -Name '构建前端资源' -Command { npm run build }
  Invoke-TestsWithTimeout
  $desktopOutput = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist\desktop'))
  $expectedOutput = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist')) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $desktopOutput.StartsWith($expectedOutput, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝清理项目外的输出目录：$desktopOutput"
  }
  if (Test-Path -LiteralPath $desktopOutput) {
    Remove-Item -LiteralPath $desktopOutput -Recurse -Force
  }
  Invoke-NativeStep -Name '生成 Windows NSIS 安装包' -Command { npx electron-builder --win nsis --x64 }

  $package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
  $artifact = Join-Path $projectRoot "dist\desktop\LiuXu-Setup-$($package.version)-x64.exe"
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
    throw "安装包未生成：$artifact"
  }
  $hash = Get-Sha256Hex -Path $artifact
  $checksumPath = "$artifact.sha256"
  "$hash *$([System.IO.Path]::GetFileName($artifact))" | Set-Content -LiteralPath $checksumPath -Encoding ascii
  $artifactInfo = Get-Item -LiteralPath $artifact
  $summary = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    productName = '留序 LiuXu'
    version = [string]$package.version
    platform = 'win32'
    arch = 'x64'
    artifact = $artifactInfo.Name
    sizeBytes = $artifactInfo.Length
    sha256 = $hash
    electron = '43.4.1'
    electronBuilder = '26.15.3'
    optionalDependencies = 'omitted'
    tests = 'passed'
    signed = $false
    notarized = $false
  }
  $summaryPath = Join-Path $projectRoot 'dist\desktop\desktop-build-summary.json'
  $summary | ConvertTo-Json | Set-Content -LiteralPath $summaryPath -Encoding utf8

  $generatedCleanup = @(
    (Join-Path $desktopOutput 'win-unpacked'),
    (Join-Path $desktopOutput '.icon-ico'),
    (Join-Path $desktopOutput 'builder-debug.yml'),
    (Join-Path $desktopOutput 'latest.yml'),
    "$artifact.blockmap"
  )
  foreach ($cleanupTarget in $generatedCleanup) {
    $fullCleanupTarget = [System.IO.Path]::GetFullPath($cleanupTarget)
    $allowedCleanupPrefix = $desktopOutput + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullCleanupTarget.StartsWith($allowedCleanupPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "拒绝清理输出目录外的构建文件：$fullCleanupTarget"
    }
    if (Test-Path -LiteralPath $fullCleanupTarget) {
      Remove-Item -LiteralPath $fullCleanupTarget -Recurse -Force
    }
  }

  Write-Host "`n安装包：$artifact"
  Write-Host "SHA-256：$hash"
  Write-Host "校验文件：$checksumPath"
  Write-Host "构建摘要：$summaryPath"
} finally {
  Pop-Location
}
