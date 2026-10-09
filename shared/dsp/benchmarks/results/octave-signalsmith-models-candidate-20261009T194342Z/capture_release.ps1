$ErrorActionPreference = 'Stop'
$archiveRoot = $PSScriptRoot
$sourceRoot = Join-Path $archiveRoot 'source'
$buildRoot = Join-Path $archiveRoot 'build'
$dataRoot = Join-Path $archiveRoot 'data'
function Get-TreeHashMap([string]$root) {
    $map = [ordered]@{}
    foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object { $_.FullName.Substring($root.Length + 1) }) {
        $relative = $file.FullName.Substring($root.Length + 1).Replace('\','/')
        $map[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $map
}
$started = [DateTime]::UtcNow.ToString('o')
$sourceBefore = Get-TreeHashMap $sourceRoot
$buildScriptSha = (Get-FileHash -LiteralPath (Join-Path $archiveRoot 'build_release.cmd') -Algorithm SHA256).Hash.ToLowerInvariant()
$captureScriptSha = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
& cmd.exe /d /c "`"$(Join-Path $archiveRoot 'build_release.cmd')`""
$buildExit = $LASTEXITCODE
$ended = [DateTime]::UtcNow.ToString('o')
$sourceAfter = Get-TreeHashMap $sourceRoot
$changed = @()
foreach ($key in $sourceBefore.Keys) { if (!$sourceAfter.Contains($key) -or $sourceBefore[$key] -ne $sourceAfter[$key]) { $changed += $key } }
foreach ($key in $sourceAfter.Keys) { if (!$sourceBefore.Contains($key)) { $changed += $key } }
if ($buildExit -ne 0) { throw "Build/test command failed with exit $buildExit" }
if ($changed.Count -ne 0) { throw "Copied source changed during build: $($changed -join ', ')" }
$test = Get-Content -LiteralPath (Join-Path $buildRoot 'test-output.json') -Raw | ConvertFrom-Json
$sidecars = @()
foreach ($file in Get-ChildItem -LiteralPath $dataRoot -File | Sort-Object Name) {
    $relative = $file.FullName.Substring($archiveRoot.Length + 1).Replace('\','/')
    $entry = [ordered]@{
        path = $relative
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        bytes = $file.Length
        encoding = 'float32-le-interleaved-stereo'
        frames = [long]($file.Length / 8)
        channels = 2
    }
    $sidecars += $entry
}
$os = $null
$cpu = $null
try { $os = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 Caption,Version,BuildNumber,OSArchitecture } catch { $os = @{ unavailable = $_.Exception.Message } }
try { $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,Architecture,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed } catch { $cpu = @{ unavailable = $_.Exception.Message } }
$artifacts = @()
foreach ($file in Get-ChildItem -LiteralPath $buildRoot -File | Sort-Object Name) {
    $artifacts += [ordered]@{
        path = ('build/' + $file.Name)
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        bytes = $file.Length
    }
}
$manifest = [ordered]@{
    schemaVersion = 1
    candidate = 'octave-signalsmith-models'
    disposition = 'standalone experimental functional candidate; not final-quality, runtime-integrated, cross-runtime qualified, deadline qualified, or hardware tested'
    capturedAtUtc = $ended
    build = [ordered]@{
        command = 'build_release.cmd'
        startedUtc = $started
        endedUtc = $ended
        exitCode = $buildExit
        compilerVersionLog = 'build/compiler-version.log'
        compilerVersionSha256 = (Get-FileHash -LiteralPath (Join-Path $buildRoot 'compiler-version.log') -Algorithm SHA256).Hash.ToLowerInvariant()
        flags = @('/std:c++17','/O2','/EHsc','/W4','/permissive-')
        translationUnits = @('octave_signalsmith_models.cpp','signalsmith_adapter.cpp','primitives.cpp','octave_signalsmith_models_tests.cpp')
        buildScriptSha256 = $buildScriptSha
        captureScriptSha256 = $captureScriptSha
        sourceHashCount = $sourceBefore.Count
        sourceChangedDuringBuild = @()
        sourceHashesBefore = $sourceBefore
        sourceHashesAfter = $sourceAfter
        artifacts = $artifacts
    }
    environment = [ordered]@{ os = $os; cpu = $cpu; hardwareAudio = 'not accessed or tested' }
    algorithm = [ordered]@{
        wrapper = 'two continuously-running pinned Signalsmith branches, stereo, equal input/output frames'
        factors = @{ downOne = 0.5; downTwo = 0.25 }
        wrapperSettings = @{ sampleRate = 48000; maxCallbackFrames = 256; blockSamples = 8192; intervalSamples = 1024; splitComputation = $false; seed = '0x05aa1234'; controlSmoothingMs = 8 }
        highResolutionDirectProbe = @{ blockSamples = 16384; intervalSamples = 2048; seed = '0x05aa1234'; scope = 'diagnostic direct upstream engine only; not wrapper adapter setting' }
    }
    test = $test
    sidecars = $sidecars
    upstream = @(
        @{ name = 'Signalsmith Stretch'; pin = 'a670068d9aeb64913331d5cc29337b19a457a7df'; path = 'source/third_party/signalsmith-stretch'; license = 'MIT' },
        @{ name = 'Signalsmith Linear'; pin = 'de55e6a50ffcf6f8f43f649692d94691c7025151'; path = 'source/third_party/signalsmith-linear'; license = 'MIT' }
    )
}
$manifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $archiveRoot 'manifest.json') -Encoding utf8
$sumLines = @()
foreach ($file in Get-ChildItem -LiteralPath $archiveRoot -Recurse -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | Sort-Object { $_.FullName.Substring($archiveRoot.Length + 1) }) {
    $relative = $file.FullName.Substring($archiveRoot.Length + 1).Replace('\','/')
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $sumLines += "$hash  $relative"
}
Set-Content -LiteralPath (Join-Path $archiveRoot 'SHA256SUMS.txt') -Value $sumLines -Encoding ascii
