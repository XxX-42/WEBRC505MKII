param(
    [string]$BuildRoot = (Join-Path $env:TEMP ("webrc-native-verify-" + [Guid]::NewGuid().ToString('N'))),
    [string]$VsInstallPath,
    [string]$VsWherePath,
    [string]$ToolsetVersion,
    [string]$CachedDependencyRoot
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'native-build-common.ps1')

$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\', '/') + '\'
$BuildRoot = [System.IO.Path]::GetFullPath($BuildRoot)
if (-not $BuildRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "BuildRoot must be under TEMP so compiler /Fo object files stay outside the workspace: $BuildRoot"
}
if ([string]::IsNullOrWhiteSpace($CachedDependencyRoot)) {
    $CachedDependencyRoot = Join-Path $repoRoot 'native-mvp\build-v145\_deps'
} else {
    $CachedDependencyRoot = [System.IO.Path]::GetFullPath($CachedDependencyRoot)
}

$toolchain = Resolve-NativeToolchain -VsInstallPath $VsInstallPath -VsWherePath $VsWherePath -ToolsetVersion $ToolsetVersion
$sourceDir = Join-Path $repoRoot 'native-mvp\engine-cpp'
$fetchContentDir = Join-Path $BuildRoot '_deps'
$fetchContent = Get-NativeFetchContentConfiguration -CachedDependencyRoot $CachedDependencyRoot -FetchContentBaseDir $fetchContentDir
$cmakeCommand = Get-Command cmake.exe -ErrorAction Stop | Select-Object -First 1
$cmake = $cmakeCommand.Source
$ctestPath = Join-Path (Split-Path $cmake -Parent) 'ctest.exe'
if (-not (Test-Path -LiteralPath $ctestPath -PathType Leaf)) {
    $ctestCommand = Get-Command ctest.exe -ErrorAction Stop | Select-Object -First 1
    $ctestPath = $ctestCommand.Source
}
$runner = Join-Path $BuildRoot 'run-verify.cmd'
New-Item -ItemType Directory -Force -Path $BuildRoot, $fetchContentDir | Out-Null

$lines = @('@echo off', 'setlocal')
if ($toolchain.VcvarsPath) {
    $activation = 'call "{0}" amd64' -f $toolchain.VcvarsPath
    if ($toolchain.VcvarsVersion) { $activation += " -vcvars_ver=$($toolchain.VcvarsVersion)" }
    $lines += $activation
    $lines += 'if errorlevel 1 exit /b %errorlevel%'
}
$configureArgs = @(
    '-S', $sourceDir,
    '-B', $BuildRoot,
    '-G', 'NMake Makefiles',
    "-DCMAKE_MAKE_PROGRAM=$($toolchain.NMakePath)",
    '-DCMAKE_BUILD_TYPE=Release'
) + $fetchContent.Arguments
$lines += '"{0}" {1}' -f $cmake, (ConvertTo-NativeCmdArguments $configureArgs)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$buildArgs = @('--build', $BuildRoot, '--target', 'native_bridge_host', 'looper_core_tests', 'native_looper_bench', 'dsp_primitives_tests', 'control_dynamics_tests', 'nonlinear_tests', 'spatial_temporal_tests', 'pitch_tests', 'native_dsp_primitives_bench')
$lines += '"{0}" {1}' -f $cmake, (ConvertTo-NativeCmdArguments $buildArgs)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$testArgs = @('--test-dir', $BuildRoot, '--output-on-failure', '-R', 'looper_core_tests|dsp_primitives_tests|control_dynamics_tests|nonlinear_tests|spatial_temporal_tests|pitch_tests')
$lines += '"{0}" {1}' -f $ctestPath, (ConvertTo-NativeCmdArguments $testArgs)
$lines += 'exit /b %errorlevel%'
[System.IO.File]::WriteAllLines($runner, $lines, [System.Text.Encoding]::ASCII)

Write-Output "MSVC toolchain: $($toolchain.VsInstallPath) / $($toolchain.ToolsetVersion) ($($toolchain.Source))"
if ($fetchContent.CachedDependenciesUsed.Count -gt 0) {
    Write-Output "Using cached FetchContent source(s): $($fetchContent.CachedDependenciesUsed -join ', ')"
}
if ($fetchContent.DependenciesFetchedIfNeeded.Count -gt 0) {
    Write-Output "CMake may fetch missing source(s) into TEMP: $($fetchContent.DependenciesFetchedIfNeeded -join ', ')"
}
Write-Output "CMake binary directory and MSVC /Fo object output stay under TEMP: $BuildRoot"
& $env:ComSpec /d /c "`"$runner`""
if ($LASTEXITCODE -ne 0) { throw "Native build or CTest failed with exit code $LASTEXITCODE. Build files: $BuildRoot" }
Write-Output "Native build and CTest passed. Build files and object outputs: $BuildRoot"
