$ErrorActionPreference = 'Stop'
$archive = $PSScriptRoot
$sourceRoot = Join-Path $archive 'upstream-source'
function Get-HashMap([string]$root) {
    $map = [ordered]@{}
    foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object { $_.FullName.Substring($root.Length + 1) }) {
        $rel = $file.FullName.Substring($root.Length + 1).Replace('\','/')
        $map[$rel] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $map
}
$started = [DateTime]::UtcNow.ToString('o')
$sourceBefore = Get-HashMap $sourceRoot
$compilerFiles = @(
    'C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\bin\Hostx64\x64\cl.exe',
    'C:\Users\user1000\AppData\Local\Temp\webrc-rubberband-tools-a8df618f854b42dcb24f590ed3661a84\bin\meson.exe',
    'C:\Users\user1000\AppData\Local\Temp\webrc-rubberband-tools-a8df618f854b42dcb24f590ed3661a84\bin\ninja.exe'
)
$compilerHashes = [ordered]@{}
foreach ($path in $compilerFiles) {
    if (Test-Path -LiteralPath $path) { $compilerHashes[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
}
& (Join-Path $archive 'build_release.cmd')
$exitCode = $LASTEXITCODE
$ended = [DateTime]::UtcNow.ToString('o')
if ($exitCode -ne 0) { throw "Build/evaluation failed with exit $exitCode; preserve build logs and repair in a new archive." }
$sourceAfter = Get-HashMap $sourceRoot
$changed = @()
foreach ($key in $sourceBefore.Keys) {
    if (!$sourceAfter.Contains($key) -or $sourceBefore[$key] -ne $sourceAfter[$key]) { $changed += $key }
}
foreach ($key in $sourceAfter.Keys) { if (!$sourceBefore.Contains($key)) { $changed += $key } }
if ($changed.Count) { throw "Pinned copied upstream source changed during build: $($changed -join ', ')" }
$os = $null
$cpu = $null
try { $os = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 Caption,Version,BuildNumber,OSArchitecture } catch { $os = @{ unavailable = $_.Exception.Message } }
try { $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,Architecture,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed } catch { $cpu = @{ unavailable = $_.Exception.Message } }
$results = Join-Path $archive 'results'
$runs = @()
foreach ($line in Get-Content -LiteralPath (Join-Path $results 'results.jsonl')) { $runs += ($line | ConvertFrom-Json) }
$timingRows = Import-Csv -LiteralPath (Join-Path $results 'callback-timing.csv')
$timingSummary = @{}
foreach ($group in ($timingRows | Group-Object runId)) {
    $ordered = @($group.Group | ForEach-Object { [long]$_.elapsedNs } | Sort-Object)
    $n = $ordered.Count
    if (!$n) { continue }
    $timingSummary[$group.Name] = [ordered]@{
        callbackCount = $n
        p50Ns = $ordered[[Math]::Max(0,[Math]::Ceiling(.50*$n)-1)]
        p99Ns = $ordered[[Math]::Max(0,[Math]::Ceiling(.99*$n)-1)]
        p999Ns = $ordered[[Math]::Max(0,[Math]::Ceiling(.999*$n)-1)]
        maxNs = $ordered[-1]
        over60 = @($group.Group | Where-Object { [long]$_.elapsedNs -gt [long]$_.budgetNs * .6 }).Count
        over80 = @($group.Group | Where-Object { [long]$_.elapsedNs -gt [long]$_.budgetNs * .8 }).Count
        over100 = @($group.Group | Where-Object { [long]$_.elapsedNs -gt [long]$_.budgetNs }).Count
    }
}
$files = @()
foreach ($file in Get-ChildItem -LiteralPath $archive -Recurse -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' -and $_.Name -ne 'manifest.json' } | Sort-Object { $_.FullName.Substring($archive.Length + 1) }) {
    $rel = $file.FullName.Substring($archive.Length + 1).Replace('\','/')
    $files += [ordered]@{ path = $rel; bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$manifest = [ordered]@{
    schemaVersion = 1
    evaluator = 'standalone Rubber Band v4.0.0 R2/R3 real-time Stretcher comparison'
    disposition = 'independent software evaluation; no product or registry integration; no hardware audio test; no real-time or final-quality qualification'
    upstream = [ordered]@{
        project = 'Rubber Band Library'
        version = '4.0.0'
        commit = '1d95888bec3ae0a17c0c4af791810d5a63f6bc35'
        license = 'GPL-2.0-or-later; separate commercial license offered by upstream'
        sourceTarSha256 = (Get-FileHash -LiteralPath (Join-Path $archive 'rubberband-v4.0.0-source.tar') -Algorithm SHA256).Hash.ToLowerInvariant()
        builtEngines = @(2,3)
        buildFeatures = @{ mode='RealTime'; FFT='built-in'; resampler='built-in'; staticLibrary=$true; threads='ThreadingNever' }
    }
    build = [ordered]@{
        startedUtc = $started
        endedUtc = $ended
        exitCode = $exitCode
        commandScript = 'build_release.cmd'
        commandScriptSha256 = (Get-FileHash -LiteralPath (Join-Path $archive 'build_release.cmd') -Algorithm SHA256).Hash.ToLowerInvariant()
        captureScriptSha256 = (Get-FileHash -LiteralPath (Join-Path $archive 'capture.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
        harness = 'eval-src/rubberband_r2r3_eval.cpp'
        harnessSha256 = (Get-FileHash -LiteralPath (Join-Path $archive 'eval-src\rubberband_r2r3_eval.cpp') -Algorithm SHA256).Hash.ToLowerInvariant()
        sourceFileCount = $sourceBefore.Count
        sourceHashesBefore = $sourceBefore
        sourceHashesAfter = $sourceAfter
        sourceChangedDuringBuild = @()
        compilerBinaryHashes = $compilerHashes
        flags = @('Rubber Band Meson release: project defaults, MSVC 19.29.30159 x64, static, built-in FFT/resampler, tests/cmdline/plugins disabled','Evaluator: /std:c++17 /O2 /EHsc /MD /D RUBBERBAND_STATIC')
        externalBuildTools = @{ python='3.13.14'; meson='1.12.1'; ninja='1.13.2.git.kitware.jobserver-pipe-1'; visualStudio='2019 Build Tools'; msvc='19.29.30159'; linker='14.29.30159.0' }
    }
    environment = [ordered]@{ os=$os; cpu=$cpu; hardwareAudio='not accessed'; timer='std::chrono::steady_clock, wall-clock duration; scheduler delays retained in maxima' }
    scope = [ordered]@{
        sampleRate = 48000
        channels = 2
        inputFrames = 144000
        blockFrames = @(64,128,256)
        pitchScales = @(1.0,0.5,0.25)
        engines = @('R2','R3')
        scenes = @('archived Signalsmith 55/110/220/880 Hz independent stereo tones','220/275 Hz identity','stereo impulse identity latency','deterministic gated two-note transient and clicks')
        fixedOptions = @('OptionProcessRealTime','OptionThreadingNever','OptionTransientsMixed','OptionDetectorCompound','OptionPhaseLaminar','OptionWindowStandard','OptionPitchHighQuality','OptionChannelsApart')
        inputPad = 'Per-run getPreferredStartPad zero frames prepended; raw PCM preserved; analysis alignment removes reported getStartDelay'
        allocationProbe = 'Global C++ new/delete operators only around process plus all available/retrieve calls on the calling thread; malloc/OS heap and lock calls are not intercepted'
        timing = 'Per process callback includes Rubber Band process and retrieval, records every chronological duration and actual block budget; final callback is retained; no scheduler spikes excluded'
        signalsmithComparison = 'Exact archived tone input/output sidecars; only archived 0.5x candidate output is available for paired comparison; its prior archive does not include callback timing distributions'
    }
    runCount = $runs.Count
    results = $runs
    independentlyRecomputedTiming = $timingSummary
    artifacts = $files
}
$manifest | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $archive 'manifest.json') -Encoding utf8
$sum = @()
foreach ($file in Get-ChildItem -LiteralPath $archive -Recurse -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | Sort-Object { $_.FullName.Substring($archive.Length + 1) }) {
    $rel = $file.FullName.Substring($archive.Length + 1).Replace('\','/')
    $sum += "$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $rel"
}
Set-Content -LiteralPath (Join-Path $archive 'SHA256SUMS.txt') -Value $sum -Encoding ascii
Write-Output ('RUNS=' + $runs.Count + ' CALLBACKS=' + $timingRows.Count + ' FILES=' + $sum.Count)
