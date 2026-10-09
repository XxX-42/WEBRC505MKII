param(
    [string]$OutputDirectory = "",
    [string]$TempDirectory = "",
    [ValidateRange(1000, 1000000)]
    [uint32]$CallbackCount = 50000
)

$ErrorActionPreference = "Stop"

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-InputSnapshot([string]$Root, [string[]]$RelativePaths) {
    $records = @(
        foreach ($relative in ($RelativePaths | Sort-Object -Unique)) {
            $path = Join-Path $Root $relative
            [ordered]@{ path = $relative.Replace("\", "/"); sha256 = Get-Sha256 $path; bytes = (Get-Item -LiteralPath $path).Length }
        }
    )
    $canonical = (($records | ForEach-Object { "$($_.path):$($_.sha256):$($_.bytes)`n" }) -join "")
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $sha = [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))).Replace("-", "").ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
    return [ordered]@{ aggregateSha256 = $sha; files = $records }
}

function Get-Quantile([long[]]$Values, [double]$Probability) {
    if ($Values.Length -eq 0) { return 0L }
    $sorted = [long[]]$Values.Clone()
    [Array]::Sort($sorted)
    $rank = [Math]::Max(0, [Math]::Min($sorted.Length - 1, [int][Math]::Ceiling($Probability * $sorted.Length) - 1))
    return $sorted[$rank]
}

function Get-Distribution([long[]]$Values, [long]$P99Target, [long]$P999Target, [long]$Budget) {
    if ($Values.Length -eq 0) {
        return [ordered]@{ count = 0; p99Ns = 0; p999Ns = 0; maxNs = 0; over60PercentBudget = 0; over80PercentBudget = 0; over100PercentBudget = 0 }
    }
    return [ordered]@{
        count = $Values.Length
        p99Ns = Get-Quantile $Values 0.99
        p999Ns = Get-Quantile $Values 0.999
        maxNs = ($Values | Measure-Object -Maximum).Maximum
        over60PercentBudget = @($Values | Where-Object { $_ -gt $P99Target }).Count
        over80PercentBudget = @($Values | Where-Object { $_ -gt $P999Target }).Count
        over100PercentBudget = @($Values | Where-Object { $_ -gt $Budget }).Count
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$stamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot "shared\dsp\benchmarks\results" }
if (-not $TempDirectory) { $TempDirectory = $env:TEMP }
$snapshotRoot = Join-Path $TempDirectory "webrc-rhythm-capture-$stamp"
$repoInputFiles = @(
    "shared/dsp/benchmarks/capture_native_rhythm_bench.ps1",
    "shared/dsp/benchmarks/native_rhythm_bench.cpp",
    "shared/dsp/include/webrc/dsp/rhythm.hpp",
    "shared/dsp/include/webrc/dsp/cleanroom_rhythm_data.hpp",
    "shared/dsp/src/rhythm.cpp",
    "shared/dsp/src/cleanroom_rhythm_data.cpp",
    "shared/dsp/src/primitives.cpp",
    "shared/dsp/src/fft.cpp",
    "shared/dsp/src/spatial_temporal.cpp",
    "shared/dsp/tests/rhythm_tests.cpp",
    "dsp/spec/build_cleanroom_rhythm.py",
    "dsp/spec/cleanroom_rhythm_patterns.json",
    "dsp/spec/cleanroom_kit_profiles.json"
)
$repoInputFiles += Get-ChildItem -LiteralPath (Join-Path $repoRoot "shared\dsp\include\webrc\dsp") -File -Recurse |
    ForEach-Object { $_.FullName.Substring($repoRoot.Length + 1).Replace("\", "/") }

New-Item -ItemType Directory -Path $snapshotRoot | Out-Null
foreach ($relative in ($repoInputFiles | Sort-Object -Unique)) {
    $source = Join-Path $repoRoot $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing capture input: $relative" }
    $destination = Join-Path $snapshotRoot $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
}

$cmakeScript = @'
cmake_minimum_required(VERSION 3.20)
project(webrc_native_rhythm_capture LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")
enable_testing()
set(WEBRC_SHARED_DSP "${CMAKE_CURRENT_SOURCE_DIR}/shared/dsp")
set(WEBRC_RHYTHM_COMMON
  "${WEBRC_SHARED_DSP}/src/rhythm.cpp"
  "${WEBRC_SHARED_DSP}/src/cleanroom_rhythm_data.cpp"
  "${WEBRC_SHARED_DSP}/src/primitives.cpp"
  "${WEBRC_SHARED_DSP}/src/fft.cpp"
  "${WEBRC_SHARED_DSP}/src/spatial_temporal.cpp")
add_executable(rhythm_tests "${WEBRC_SHARED_DSP}/tests/rhythm_tests.cpp" ${WEBRC_RHYTHM_COMMON})
target_include_directories(rhythm_tests PRIVATE "${WEBRC_SHARED_DSP}/include")
add_test(NAME rhythm_tests COMMAND rhythm_tests)
add_executable(native_rhythm_bench "${WEBRC_SHARED_DSP}/benchmarks/native_rhythm_bench.cpp" ${WEBRC_RHYTHM_COMMON})
target_include_directories(native_rhythm_bench PRIVATE "${WEBRC_SHARED_DSP}/include")
if(MSVC)
  target_compile_options(rhythm_tests PRIVATE /W4)
  target_compile_options(native_rhythm_bench PRIVATE /W4)
endif()
'@
$cmakePath = Join-Path $snapshotRoot "CMakeLists.txt"
Set-Content -LiteralPath $cmakePath -Value $cmakeScript -Encoding ASCII
$relativeInputs = @($repoInputFiles | Sort-Object -Unique) + "CMakeLists.txt"
$before = Get-InputSnapshot $snapshotRoot $relativeInputs

$vsInstall = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools"
$vcvars = Join-Path $vsInstall "VC\Auxiliary\Build\vcvarsall.bat"
if (-not (Test-Path -LiteralPath $vcvars)) {
    $vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vswhere)) { throw "VS 2019 Build Tools or vswhere.exe is required for this capture." }
    $install = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $vcvars = Join-Path $install "VC\Auxiliary\Build\vcvarsall.bat"
}
if (-not (Test-Path -LiteralPath $vcvars)) { throw "Could not locate vcvarsall.bat." }

$runnerPath = Join-Path $snapshotRoot "run-capture.cmd"
$runner = @"
@echo off
setlocal
call "$vcvars" amd64 -vcvars_ver=14.29
if errorlevel 1 exit /b %errorlevel%
cl /Bv > "$snapshotRoot\compiler-version.txt" 2>&1
cmake -S "$snapshotRoot" -B "$snapshotRoot\build" -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
if errorlevel 1 exit /b %errorlevel%
cmake --build "$snapshotRoot\build" --target rhythm_tests native_rhythm_bench --config Release
if errorlevel 1 exit /b %errorlevel%
ctest --test-dir "$snapshotRoot\build" --output-on-failure > "$snapshotRoot\ctest-output.txt" 2>&1
if errorlevel 1 exit /b %errorlevel%
set "WEBRC_RHYTHM_BENCH_JSON=$snapshotRoot\rhythm-bench.json"
set "WEBRC_RHYTHM_CALLBACK_COUNT=$CallbackCount"
"$snapshotRoot\build\native_rhythm_bench.exe"
if errorlevel 1 exit /b %errorlevel%
exit /b 0
"@
Set-Content -LiteralPath $runnerPath -Value $runner -Encoding ASCII
& cmd.exe /d /c $runnerPath
if ($LASTEXITCODE -ne 0) { throw "Fresh isolated rhythm capture failed with exit code $LASTEXITCODE" }

$after = Get-InputSnapshot $snapshotRoot $relativeInputs
if ($before.aggregateSha256 -ne $after.aggregateSha256) { throw "Copied source fingerprint changed during capture." }
$benchPath = Join-Path $snapshotRoot "rhythm-bench.json"
$bench = Get-Content -LiteralPath $benchPath -Raw | ConvertFrom-Json
$timingSummaries = @(
    foreach ($timing in $bench.timingScenarios) {
        $samples = @($timing.samplesChronological)
        $durations = [long[]]@($samples | ForEach-Object { [long]$_.durationNs })
        $wall = Get-Distribution $durations ([long]$timing.p99TargetNs) ([long]$timing.p999TargetNs) ([long]$timing.deadlineBudgetNs)
        if ($durations.Length -ne [int]$timing.callbacks -or
            [long]$wall.p99Ns -ne [long]$timing.p99Ns -or
            [long]$wall.p999Ns -ne [long]$timing.p999Ns -or
            [long]$wall.maxNs -ne [long]$timing.maxNs -or
            [long]$wall.over60PercentBudget -ne [long]$timing.over60PercentBudget -or
            [long]$wall.over80PercentBudget -ne [long]$timing.over80PercentBudget -or
            [long]$wall.over100PercentBudget -ne [long]$timing.over100PercentBudget) {
            throw "Raw chronological wall-time array does not match $($timing.scenario)/$($timing.blockFrames) summary."
        }
        $cpuSamples = @($samples | Where-Object { $_.threadCpuTimingValid })
        $cpuDurations = [long[]]@($cpuSamples | ForEach-Object { [long]$_.threadCpuNs })
        $cpu = Get-Distribution $cpuDurations ([long]$timing.p99TargetNs) ([long]$timing.p999TargetNs) ([long]$timing.deadlineBudgetNs)
        if ($cpuDurations.Length -ne [int]$timing.threadCpuValidSamples -or
            $cpuDurations.Length + [int]$timing.threadCpuTimingFailures -ne [int]$timing.callbacks -or
            [long]$cpu.p99Ns -ne [long]$timing.threadCpuP99Ns -or
            [long]$cpu.p999Ns -ne [long]$timing.threadCpuP999Ns -or
            [long]$cpu.maxNs -ne [long]$timing.threadCpuMaxNs) {
            throw "Raw thread CPU/cycle arrays do not match $($timing.scenario)/$($timing.blockFrames) summary."
        }
        if ($bench.cycleCalibration.valid -and $timing.threadCpuValidSamples -gt 0) {
            foreach ($sample in $cpuSamples) {
                $estimated = [long][Math]::Floor(([double]$sample.threadCpuCycles * [double]$bench.cycleCalibration.nsPerCycle) + 0.5)
                if ($estimated -ne [long]$sample.threadCpuNs) { throw "Per-callback cycle estimate mismatch in $($timing.scenario)." }
            }
        }
        $classes = [ordered]@{}
        foreach ($className in @("barBoundary", "eventCollision", "commandBoundary", "startup")) {
            $subset = @($samples | Where-Object { $_.$className })
            $classDurations = [long[]]@($subset | ForEach-Object { [long]$_.durationNs })
            $classes[$className] = Get-Distribution $classDurations ([long]$timing.p99TargetNs) ([long]$timing.p999TargetNs) ([long]$timing.deadlineBudgetNs)
        }
        [ordered]@{
            scenario = $timing.scenario
            blockFrames = [int]$timing.blockFrames
            callbackCount = [int]$timing.callbacks
            eventCollisionMaximumInOneCallback = [int]$timing.maxEventsTriggeredInOneCallback
            maxActiveDrumVoices = [int]$timing.maxActiveDrumVoices
            maxActiveBrushVoices = [int]$timing.maxActiveBrushVoices
            maxRetiringBrushVoices = [int]$timing.maxRetiringBrushVoices
            commandBoundaries = [long]$timing.commandBoundaries
            fillCommands = [long]$timing.fillCommands
            wall = $wall
            wallClasses = $classes
            threadCpuOrCalibratedCycleEstimate = $cpu
            threadCpuTimingFailures = [long]$timing.threadCpuTimingFailures
        }
    }
)
$compileCommandsPath = Join-Path $snapshotRoot "build\compile_commands.json"
$compileCommands = Get-Content -LiteralPath $compileCommandsPath -Raw | ConvertFrom-Json
$compileFlags = @($compileCommands | ForEach-Object { $_.command } | Sort-Object -Unique)
$resultsDirectory = (New-Item -ItemType Directory -Path $OutputDirectory -Force).FullName
$artifactBase = "native-rhythm-$stamp"
$rawDestination = Join-Path $resultsDirectory "$artifactBase.json"
$manifestDestination = Join-Path $resultsDirectory "$artifactBase.manifest.json"
Copy-Item -LiteralPath $benchPath -Destination $rawDestination
$archiveRoot = Join-Path $resultsDirectory "$artifactBase.snapshot"
New-Item -ItemType Directory -Path $archiveRoot | Out-Null
foreach ($relative in $relativeInputs) {
    $source = Join-Path $snapshotRoot $relative
    $destination = Join-Path $archiveRoot $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
}
foreach ($relative in @("run-capture.cmd", "compiler-version.txt", "ctest-output.txt", "rhythm-bench.json", "build\compile_commands.json")) {
    $source = Join-Path $snapshotRoot $relative
    $destination = Join-Path $archiveRoot "capture\$relative"
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
}
$archivedInputs = Get-InputSnapshot $archiveRoot $relativeInputs
if ($archivedInputs.aggregateSha256 -ne $before.aggregateSha256) { throw "Archived source copies do not match the built snapshot fingerprint." }
$legacyCpuEvidencePath = Join-Path $resultsDirectory "native-rhythm-20261009T131006435Z.json"
$legacyCpuEvidenceSha = if (Test-Path -LiteralPath $legacyCpuEvidencePath) { Get-Sha256 $legacyCpuEvidencePath } else { $null }
$totalTimingSamples = 0L
foreach ($summary in $timingSummaries) { $totalTimingSamples += [long]$summary.callbackCount }
$manifest = [ordered]@{
    schemaVersion = "webrc-native-rhythm-capture-manifest-v2"
    capturedUtc = [DateTime]::UtcNow.ToString("o")
    gitHead = (& git -C $repoRoot rev-parse HEAD).Trim()
    gitBranch = (& git -C $repoRoot branch --show-current).Trim()
    qualification = "isolated shared RhythmRenderer native reference; not product realtime Gate 1/7"
    snapshotDirectory = $snapshotRoot
    archivedSourceDirectory = $archiveRoot
    archivedSourceFingerprint = $archivedInputs
    sourceArchiveMatchesBuiltSnapshot = $archivedInputs.aggregateSha256 -eq $before.aggregateSha256
    snapshotFingerprintBeforeBuild = $before
    snapshotFingerprintAfterRun = $after
    sourceSnapshotUnchanged = $before.aggregateSha256 -eq $after.aggregateSha256
    compilerVersionOutput = Get-Content -LiteralPath (Join-Path $snapshotRoot "compiler-version.txt") -Raw
    compilerFlags = $compileFlags
    buildCommand = "cmake -S <snapshot> -B <snapshot>/build -G NMake Makefiles -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON; cmake --build --target rhythm_tests native_rhythm_bench; ctest --output-on-failure"
    ctestOutput = Get-Content -LiteralPath (Join-Path $snapshotRoot "ctest-output.txt") -Raw
    rawResultPath = $rawDestination
    rawResultSha256 = Get-Sha256 $rawDestination
    rawChronologicalTimingSampleCount = $totalTimingSamples
    timingRecomputedByScenario = $timingSummaries
    cycleCalibration = $bench.cycleCalibration
    earlierWindowsCpuResolutionEvidence = [ordered]@{
        rawResultPath = $legacyCpuEvidencePath
        rawResultSha256 = $legacyCpuEvidenceSha
        disposition = "Preserved only as evidence: per-callback GetThreadTimes deltas were observed in 15.625 ms steps, so that run is invalid for callback CPU quantiles."
    }
    kitSingleEventFeatureProxyMinima = @($bench.kitSingleEventFeatures | ForEach-Object {
        [ordered]@{ instrument = $_.instrument; frames = $_.frames; minNormalizedFeatureDistance = $_.minNormalizedFeatureDistance }
    })
    kitSustainedPolyphony = $bench.kitSustainedPolyphony
    brushOverlapQuality = $bench.brushOverlap
    realtimeInterpretation = "Wall-clock maxima and exceedances remain authoritative. Calibrated cycle-time CPU estimates are diagnostic only and subject to per-run calibration error and DVFS/turbo/thermal/power-state variation. This isolated benchmark does not qualify hardware E2E or product Gate 1/7."
    audioMetricLimitation = "numeric spectral/envelope/transient proxies only; no perceptual or listening evaluation"
}
$manifest | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $manifestDestination -Encoding UTF8
foreach ($file in (Get-ChildItem -LiteralPath $snapshotRoot -File -Recurse | Where-Object { $_.FullName -notmatch "\\build\\" })) {
    $file.IsReadOnly = $true
}
foreach ($file in (Get-ChildItem -LiteralPath $archiveRoot -File -Recurse)) { $file.IsReadOnly = $true }
Write-Output "PASS: fresh isolated rhythm Release build and CTest; before/after snapshot $($before.aggregateSha256)"
Write-Output "RAW_JSON: $rawDestination"
Write-Output "MANIFEST: $manifestDestination"
Write-Output "SOURCE_ARCHIVE: $archiveRoot"
foreach ($summary in $timingSummaries) {
    Write-Output "TIMING: $($summary.scenario) block=$($summary.blockFrames) callbacks=$($summary.callbackCount) P99=$($summary.wall.p99Ns) P99.9=$($summary.wall.p999Ns) max=$($summary.wall.maxNs) over60=$($summary.wall.over60PercentBudget) over80=$($summary.wall.over80PercentBudget) over100=$($summary.wall.over100PercentBudget)"
}
