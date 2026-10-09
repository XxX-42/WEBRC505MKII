param(
  [Parameter(Mandatory=$true)][string]$CachedDependencyRoot,
  [string]$BuildRoot = (Join-Path $env:TEMP 'webrc-native-psola-ratio-fix-reproduction')
)
$ErrorActionPreference='Stop'
$archiveRoot=Split-Path -Parent $PSScriptRoot
$sourceRoot=Join-Path $archiveRoot 'source-snapshot'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $sourceRoot 'scripts/native-verify.ps1') -BuildRoot $BuildRoot -CachedDependencyRoot $CachedDependencyRoot
if($LASTEXITCODE -ne 0){throw "Native verification failed with exit $LASTEXITCODE"}
