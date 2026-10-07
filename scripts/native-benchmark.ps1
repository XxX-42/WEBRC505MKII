param(
    [string]$BeforeRef = '3738d94',
    [string]$OutputRoot = (Join-Path $env:TEMP ("webrc-native-bench-" + [Guid]::NewGuid().ToString('N'))),
    [string]$VsInstallPath,
    [string]$VsWherePath,
    [string]$ToolsetVersion,
    [string]$CachedDependencyRoot
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'native-build-common.ps1')

$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\', '/') + '\'
$OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
if (-not $OutputRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputRoot must be under TEMP so CMake files and compiler /Fo object files stay outside the workspace: $OutputRoot"
}
if ([string]::IsNullOrWhiteSpace($CachedDependencyRoot)) {
    $CachedDependencyRoot = Join-Path $repoRoot 'native-mvp\build-v145\_deps'
} else {
    $CachedDependencyRoot = [System.IO.Path]::GetFullPath($CachedDependencyRoot)
}

$toolchain = Resolve-NativeToolchain -VsInstallPath $VsInstallPath -VsWherePath $VsWherePath -ToolsetVersion $ToolsetVersion
$cmakeCommand = Get-Command cmake.exe -ErrorAction Stop | Select-Object -First 1
$cmake = $cmakeCommand.Source
$sourceDir = Join-Path $repoRoot 'native-mvp\engine-cpp'
$benchSourceRelative = 'native-mvp/engine-cpp/src/looper_core.cpp'
$beforeSource = Join-Path $OutputRoot 'looper_core_before.cpp'
$runner = Join-Path $OutputRoot 'run-benchmark.cmd'
$beforeBuild = Join-Path $OutputRoot 'before-build'
$afterBuild = Join-Path $OutputRoot 'after-build'
$beforeFetchContent = Join-Path $beforeBuild '_deps'
$afterFetchContent = Join-Path $afterBuild '_deps'
$beforeCsv = Join-Path $OutputRoot 'before.csv'
$afterCsv = Join-Path $OutputRoot 'after.csv'
$comparisonCsv = Join-Path $OutputRoot 'comparison.csv'

New-Item -ItemType Directory -Force -Path $OutputRoot, $beforeBuild, $afterBuild, $beforeFetchContent, $afterFetchContent | Out-Null
$baselineText = & git -C $repoRoot show "${BeforeRef}:$benchSourceRelative"
if ($LASTEXITCODE -ne 0 -or -not $baselineText) { throw "Could not read baseline source from ${BeforeRef}:$benchSourceRelative" }
[System.IO.File]::WriteAllText($beforeSource, ($baselineText -join "`n"), [System.Text.UTF8Encoding]::new($false))

$beforeFetch = Get-NativeFetchContentConfiguration -CachedDependencyRoot $CachedDependencyRoot -FetchContentBaseDir $beforeFetchContent
$afterFetch = Get-NativeFetchContentConfiguration -CachedDependencyRoot $CachedDependencyRoot -FetchContentBaseDir $afterFetchContent
$lines = @('@echo off', 'setlocal')
if ($toolchain.VcvarsPath) {
    $activation = 'call "{0}" amd64' -f $toolchain.VcvarsPath
    if ($toolchain.VcvarsVersion) { $activation += " -vcvars_ver=$($toolchain.VcvarsVersion)" }
    $lines += $activation
    $lines += 'if errorlevel 1 exit /b %errorlevel%'
}

$configureBeforeArgs = @(
    '-S', $sourceDir,
    '-B', $beforeBuild,
    '-G', 'NMake Makefiles',
    "-DCMAKE_MAKE_PROGRAM=$($toolchain.NMakePath)",
    '-DCMAKE_BUILD_TYPE=Release',
    "-DNATIVE_BENCH_LOOPER_SOURCE=$beforeSource"
) + $beforeFetch.Arguments
$lines += '"{0}" {1}' -f $cmake, (ConvertTo-NativeCmdArguments $configureBeforeArgs)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$buildBeforeArgs = @('--build', $beforeBuild, '--target', 'native_looper_bench')
$lines += '"{0}" {1}' -f $cmake, (ConvertTo-NativeCmdArguments $buildBeforeArgs)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$lines += '"{0}" > "{1}"' -f (Join-Path $beforeBuild 'native_looper_bench.exe'), $beforeCsv
$lines += 'if errorlevel 1 exit /b %errorlevel%'

$configureAfterArgs = @(
    '-S', $sourceDir,
    '-B', $afterBuild,
    '-G', 'NMake Makefiles',
    "-DCMAKE_MAKE_PROGRAM=$($toolchain.NMakePath)",
    '-DCMAKE_BUILD_TYPE=Release',
    "-DNATIVE_BENCH_LOOPER_SOURCE=$(Join-Path $sourceDir 'src\looper_core.cpp')"
) + $afterFetch.Arguments
$lines += '"{0}" {1}' -f $cmake, (ConvertTo-NativeCmdArguments $configureAfterArgs)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$buildAfterArgs = @('--build', $afterBuild, '--target', 'native_looper_bench')
$lines += '"{0}" {1}' -f $cmake, (ConvertTo-NativeCmdArguments $buildAfterArgs)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$lines += '"{0}" > "{1}"' -f (Join-Path $afterBuild 'native_looper_bench.exe'), $afterCsv
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$lines += 'exit /b 0'
[System.IO.File]::WriteAllLines($runner, $lines, [System.Text.Encoding]::ASCII)

Write-Output "MSVC toolchain: $($toolchain.VsInstallPath) / $($toolchain.ToolsetVersion) ($($toolchain.Source))"
if ($beforeFetch.CachedDependenciesUsed.Count -gt 0) {
    Write-Output "Using cached FetchContent source(s): $($beforeFetch.CachedDependenciesUsed -join ', ')"
}
if ($beforeFetch.DependenciesFetchedIfNeeded.Count -gt 0) {
    Write-Output "CMake may fetch missing source(s) into TEMP: $($beforeFetch.DependenciesFetchedIfNeeded -join ', ')"
}
Write-Output "Both CMake build trees and MSVC /Fo object outputs stay under TEMP: $OutputRoot"
& $env:ComSpec /d /c "`"$runner`""
if ($LASTEXITCODE -ne 0) { throw "Native before/after benchmark failed with exit code $LASTEXITCODE. Details: $OutputRoot" }

$beforeRows = Import-Csv -LiteralPath $beforeCsv
$afterRows = Import-Csv -LiteralPath $afterCsv
$beforeIndex = @{}
foreach ($row in $beforeRows | Where-Object { $_.kind -ne 'lag' }) {
    $key = '{0}|{1}|{2}|{3}' -f $row.kind, $row.scenario, $row.sample_rate, $row.block_frames
    $beforeIndex[$key] = $row
}
$comparison = foreach ($row in $afterRows | Where-Object { $_.kind -ne 'lag' }) {
    $key = '{0}|{1}|{2}|{3}' -f $row.kind, $row.scenario, $row.sample_rate, $row.block_frames
    $before = $beforeIndex[$key]
    [pscustomobject]@{
        kind = $row.kind
        scenario = $row.scenario
        sample_rate = $row.sample_rate
        block_frames = $row.block_frames
        block_budget_ms = $row.block_budget_ms
        samples = $row.samples
        before_p50_us = $before.p50_us
        after_p50_us = $row.p50_us
        before_p95_us = $before.p95_us
        after_p95_us = $row.p95_us
        before_p99_us = $before.p99_us
        after_p99_us = $row.p99_us
        before_max_us = $before.max_us
        after_max_us = $row.max_us
    }
}
$comparison | Export-Csv -LiteralPath $comparisonCsv -NoTypeInformation

$focus = $comparison | Where-Object { $_.kind -eq 'command_apply' -and $_.sample_rate -eq '48000' }
Write-Output "P50/P95/P99/Max comparison CSV: $comparisonCsv"
Write-Output "Raw benchmark CSVs: $beforeCsv and $afterCsv"
Write-Output "This CPU-only LooperCore benchmark does not certify native callback P99, device XRUNs, physical RTL, or 96 kHz eligibility."
$focus | Format-Table scenario, samples, before_p50_us, after_p50_us, before_p95_us, after_p95_us, before_p99_us, after_p99_us, before_max_us, after_max_us -AutoSize | Out-String | Write-Output
