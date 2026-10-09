$ErrorActionPreference = 'Stop'
$base = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$repo = (Resolve-Path (Join-Path $base '..\..\..\..\..')).Path
$sourceRoot = Join-Path $base 'source'
$files = @(
  'shared/dsp/include/webrc/dsp/octave_fx.hpp', 'shared/dsp/include/webrc/dsp/pitch.hpp',
  'shared/dsp/include/webrc/dsp/fft.hpp', 'shared/dsp/include/webrc/dsp/primitives.hpp',
  'shared/dsp/src/octave_fx.cpp', 'shared/dsp/src/octave_fx_probe.cpp', 'shared/dsp/src/pitch.cpp',
  'shared/dsp/src/fft.cpp', 'shared/dsp/src/primitives.cpp', 'shared/dsp/benchmarks/octave_impulse_audit.cpp'
)
$worktreeFiles = @(
  'shared/dsp/include/webrc/dsp/octave_fx.hpp', 'shared/dsp/include/webrc/dsp/pitch.hpp',
  'shared/dsp/include/webrc/dsp/fft.hpp', 'shared/dsp/include/webrc/dsp/primitives.hpp',
  'shared/dsp/src/octave_fx.cpp', 'shared/dsp/src/pitch.cpp', 'shared/dsp/src/fft.cpp',
  'shared/dsp/src/primitives.cpp', 'shared/dsp/benchmarks/octave_impulse_audit.cpp'
)
function Get-FileRecords([string]$root, [string[]]$paths) {
  $records = @()
  foreach ($path in $paths) {
    $native = $path.Replace('/', '\')
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
([pscustomobject]@{schemaVersion=1;capturePhase='before-build';sourceFingerprint=$preFingerprint;sourceFiles=$pre}) | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $base 'manifest.pre.json') -Encoding UTF8
cmd /d /c (Join-Path $base 'build_release.cmd')
$buildExit = $LASTEXITCODE
$post = Get-FileRecords $sourceRoot $files
$postFingerprint = Get-Fingerprint $post
$liveMatches = $true
$probeInfo = @()
foreach ($path in $worktreeFiles) {
  $livePath = Join-Path $repo $path.Replace('/', '\')
  $liveHash = (Get-FileHash -LiteralPath $livePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $snapshotRecord = $pre | Where-Object { $_.path -eq $path } | Select-Object -First 1
  if ($path -eq 'shared/dsp/src/octave_fx.cpp') { $probeInfo = [pscustomobject]@{derivedFrom=$path;canonicalSha256=$liveHash;instrumentedSha256=($pre | Where-Object {$_.path -eq 'shared/dsp/src/octave_fx_probe.cpp'}).sha256;patch='captures raw OLA wet values immediately before boundedSample; output computation retained unchanged'} }
  elseif ($liveHash -ne $snapshotRecord.sha256) { $liveMatches = $false }
}
$compilerPath = 'C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\bin\HostX64\x64\cl.exe'
$linkerPath = 'C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\bin\HostX64\x64\link.exe'
$compilerVersion = (Get-Item -LiteralPath $compilerPath).VersionInfo.FileVersion
$linkerVersion = (Get-Item -LiteralPath $linkerPath).VersionInfo.FileVersion
$auditPath = Join-Path $base 'build\audit.json'
$auditOutput = if (Test-Path $auditPath) { Get-Content -Raw $auditPath } else { '' }
$manifest = [pscustomobject]@{
  schemaVersion=1; suite='octave-impulse-transient-audit'; processorSource='frozen OCTAVE adapter with isolated non-behavioral raw-wet probe';
  build=[pscustomobject]@{compilerPath=$compilerPath;compilerFileVersion=$compilerVersion;linkerPath=$linkerPath;linkerFileVersion=$linkerVersion;standard='C++17';configuration='Release';flags='/std:c++17 /O2 /EHsc /W4 /permissive-';exitCode=$buildExit;commandFile='build_release.cmd'};
  sourceFingerprintBefore=$preFingerprint;sourceFingerprintAfter=$postFingerprint;sourceUnchangedDuringBuild=($preFingerprint -eq $postFingerprint);workspaceCanonicalSourcesMatchSnapshot=$liveMatches;
  instrumentation=$probeInfo;sourceFiles=$pre;testOutput=$auditOutput;
  limitations=@('Instrumentation runs from an archived source copy with only a raw-wet observation inserted before the production clamp.', 'No listening or final transient-quality qualification is implied.')
}
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $base 'manifest.json') -Encoding UTF8
if ($buildExit -ne 0 -or $preFingerprint -ne $postFingerprint -or -not $liveMatches) { throw "Build/provenance failed: exit=$buildExit sourceUnchanged=$($preFingerprint -eq $postFingerprint) liveMatch=$liveMatches" }
$all = Get-ChildItem -LiteralPath $base -File -Recurse | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | Sort-Object FullName
$lines = @()
foreach ($file in $all) { $relative=$file.FullName.Substring($base.Length+1).Replace('\','/'); $hash=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); $lines += "$hash *$relative" }
Set-Content -LiteralPath (Join-Path $base 'SHA256SUMS.txt') -Value $lines -Encoding Ascii
foreach ($line in Get-Content -LiteralPath (Join-Path $base 'SHA256SUMS.txt')) { $parts=$line.Split(' ',2); $relative=$parts[1].Substring(1).Replace('/','\'); $actual=(Get-FileHash -LiteralPath (Join-Path $base $relative) -Algorithm SHA256).Hash.ToLowerInvariant(); if($actual -ne $parts[0]){throw "Archive hash mismatch $relative"} }
Write-Output "BASE=$base`nSOURCE_FINGERPRINT=$preFingerprint`nSOURCE_UNCHANGED=$($preFingerprint -eq $postFingerprint) WORKTREE_MATCH=$liveMatches BUILD_EXIT=$buildExit ARCHIVE_FILES=$($lines.Count)"
Get-Content -Raw $auditPath
