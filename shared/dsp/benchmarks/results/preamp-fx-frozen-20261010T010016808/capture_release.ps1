$ErrorActionPreference = 'Stop'
$base = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$repo = (Resolve-Path (Join-Path $base '..\..\..\..\..')).Path
$sourceRoot = Join-Path $base 'source'
$files = @(
  'shared/dsp/include/webrc/dsp/preamp_fx.hpp', 'shared/dsp/src/preamp_fx.cpp', 'shared/dsp/tests/preamp_fx_tests.cpp',
  'shared/dsp/include/webrc/dsp/nonlinear.hpp', 'shared/dsp/src/nonlinear.cpp',
  'shared/dsp/include/webrc/dsp/primitives.hpp', 'shared/dsp/src/primitives.cpp',
  'shared/dsp/include/webrc/dsp/spatial_temporal.hpp', 'shared/dsp/src/spatial_temporal.cpp',
  'shared/dsp/include/webrc/dsp/fft.hpp', 'shared/dsp/src/fft.cpp'
)
function Get-FileRecords([string]$root, [string[]]$paths) {
  $records = @()
  foreach ($path in $paths) {
    $native = $path.Replace('/', '\\')
    $file = Join-Path $root $native
    $records += [pscustomobject]@{ path = $path; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = (Get-Item -LiteralPath $file).Length }
  }
  return ,($records | Sort-Object path)
}
function Get-Fingerprint($records) {
  $content = (($records | ForEach-Object { "$($_.sha256)  $($_.path)" }) -join "`n") + "`n"
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($content)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
$pre = Get-FileRecords $sourceRoot $files
$preFingerprint = Get-Fingerprint $pre
$preManifest = [pscustomobject]@{ schemaVersion = 1; capturePhase = 'before-build'; sourceFingerprint = $preFingerprint; sourceFiles = $pre }
$preManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $base 'manifest.pre.json') -Encoding UTF8
$build = Join-Path $base 'build_release.cmd'
cmd /d /c $build
$buildExit = $LASTEXITCODE
$post = Get-FileRecords $sourceRoot $files
$postFingerprint = Get-Fingerprint $post
$live = @()
foreach ($record in $pre) {
  $livePath = Join-Path $repo $record.path.Replace('/', '\')
  $live += [pscustomobject]@{ path = $record.path; sha256 = (Get-FileHash -LiteralPath $livePath -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$sourceUnchanged = ($preFingerprint -eq $postFingerprint)
$liveMatchesSnapshot = $true
for ($i = 0; $i -lt $pre.Length; $i++) { if ($live[$i].sha256 -ne $pre[$i].sha256) { $liveMatchesSnapshot = $false } }
$testPath = Join-Path $base 'build\test-output.json'
$testOutput = if (Test-Path $testPath) { (Get-Content -Raw $testPath).Trim() } else { '' }
$compilerPath = 'C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\bin\HostX64\x64\cl.exe'
$linkerPath = 'C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\bin\HostX64\x64\link.exe'
$compilerVersion = (Get-Item -LiteralPath $compilerPath).VersionInfo.FileVersion
$linkerVersion = (Get-Item -LiteralPath $linkerPath).VersionInfo.FileVersion
$manifest = [pscustomobject]@{
  schemaVersion = 1
  suite = 'preamp-fx'
  component = 'PREAMP23 clean-room adapter'
  status = 'standalone-processor-tests-passed; integration-and-realtime-qualification-pending'
  build = [pscustomobject]@{ compiler = 'MSVC x64'; compilerPath = $compilerPath; compilerFileVersion = $compilerVersion; linkerPath = $linkerPath; linkerFileVersion = $linkerVersion; standard = 'C++17'; configuration = 'Release'; flags = '/std:c++17 /O2 /EHsc /W4 /permissive-'; exitCode = $buildExit; commandFile = 'build_release.cmd' }
  sourceFingerprintBefore = $preFingerprint
  sourceFingerprintAfter = $postFingerprint
  sourceUnchangedDuringBuild = $sourceUnchanged
  workspaceSourcesMatchSnapshot = $liveMatchesSnapshot
  sourceFiles = $pre
  testOutput = $testOutput
  limitations = @('No FX registry/CMake or factory integration in this snapshot.', 'Cabinet IRs are supplied as clean-room caller assets; no factory sample data is embedded.', 'No benchmark, WASM parity, host latency integration, or listening qualification is claimed.')
}
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $base 'manifest.json') -Encoding UTF8
if ($buildExit -ne 0 -or -not $sourceUnchanged -or -not $liveMatchesSnapshot) { throw "Build/provenance failed: exit=$buildExit unchanged=$sourceUnchanged liveMatch=$liveMatchesSnapshot" }
$all = Get-ChildItem -LiteralPath $base -File -Recurse | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | Sort-Object FullName
$lines = @()
foreach ($file in $all) {
  $relative = $file.FullName.Substring($base.Length + 1).Replace('\', '/')
  $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $lines += "$hash *$relative"
}
Set-Content -LiteralPath (Join-Path $base 'SHA256SUMS.txt') -Value $lines -Encoding Ascii
foreach ($line in Get-Content -LiteralPath (Join-Path $base 'SHA256SUMS.txt')) {
  $parts = $line.Split(' ', 2)
  $relative = $parts[1].Substring(1).Replace('/', '\\')
  $actual = (Get-FileHash -LiteralPath (Join-Path $base $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $parts[0]) { throw "Archive hash mismatch: $relative" }
}
Write-Output "BASE=$base"
Write-Output "SOURCE_FINGERPRINT=$preFingerprint"
Write-Output "SOURCE_UNCHANGED=$sourceUnchanged LIVE_MATCH=$liveMatchesSnapshot BUILD_EXIT=$buildExit"
Write-Output "ARCHIVE_FILES=$($lines.Count)"
Get-Content -Raw $testPath


