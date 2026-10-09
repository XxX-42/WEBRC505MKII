param([string]$VisualStudioInstallPath)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$resultRoot = Join-Path $repoRoot 'shared\dsp\benchmarks\results'
$resultBase = "native-performance-fx-eventburst-$stamp"
$archiveRoot = Join-Path $resultRoot "$resultBase.snapshot"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "webrc-performance-fx-eventburst-$stamp"
$inputPaths = @(
    'shared/dsp/benchmarks/native_performance_fx_eventburst_bench.cpp',
    'shared/dsp/benchmarks/capture_native_performance_fx_eventburst.ps1',
    'shared/dsp/src/performance_fx.cpp',
    'shared/dsp/include/webrc/dsp/performance_fx.hpp',
    'shared/dsp/src/primitives.cpp',
    'shared/dsp/include/webrc/dsp/primitives.hpp'
)
$flags = @('/nologo','/std:c++17','/O2','/EHsc','/MD','/W4','/DWEBRC_PERFORMANCE_FX_BENCHMARK=1')

function Get-Hash([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Fingerprint([string]$Root, [string[]]$Paths) {
    $records = @(
        foreach ($relative in ($Paths | Sort-Object -Unique)) {
            $path = Join-Path $Root $relative
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing fingerprint input: $relative" }
            [ordered]@{ path = $relative.Replace('\','/'); bytes = (Get-Item -LiteralPath $path).Length; sha256 = Get-Hash $path }
        }
    )
    $canonical = (($records | ForEach-Object { "$($_.path):$($_.sha256):$($_.bytes)`n" }) -join '')
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))
    } finally {
        $algorithm.Dispose()
    }
    $sha = [BitConverter]::ToString($digest).Replace('-','').ToLowerInvariant()
    return [ordered]@{ aggregateSha256 = $sha; files = $records }
}

if (-not $VisualStudioInstallPath) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $found = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($LASTEXITCODE -eq 0 -and $found) { $VisualStudioInstallPath = $found.Trim() }
    }
}
if (-not $VisualStudioInstallPath) { throw 'Visual Studio C++ Build Tools were not found.' }
$vcvars = Join-Path $VisualStudioInstallPath 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf)) { throw "Missing MSVC environment: $vcvars" }

New-Item -ItemType Directory -Force -Path $tempRoot,$archiveRoot | Out-Null
foreach ($relative in $inputPaths) {
    $source = Join-Path $repoRoot $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing benchmark input: $relative" }
    $destination = Join-Path $tempRoot $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
}
$buildRoot = Join-Path $tempRoot 'build'
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
$beforeTemp = Get-Fingerprint $tempRoot $inputPaths
$beforeRepo = Get-Fingerprint $repoRoot $inputPaths
$includePath = Join-Path $tempRoot 'shared\dsp\include'
$objects = @(
    @{ source = 'shared/dsp/benchmarks/native_performance_fx_eventburst_bench.cpp'; object = 'bench.obj' },
    @{ source = 'shared/dsp/src/performance_fx.cpp'; object = 'performance_fx.obj' },
    @{ source = 'shared/dsp/src/primitives.cpp'; object = 'primitives.obj' }
)
$logPath = Join-Path $tempRoot 'build.log'
$versionPath = Join-Path $tempRoot 'compiler-version.txt'
$exePath = Join-Path $buildRoot 'native_performance_fx_eventburst_bench.exe'
$rawPath = Join-Path $tempRoot 'eventburst-raw.json'
$runLog = Join-Path $tempRoot 'run.log'
$commandPath = Join-Path $tempRoot 'build-and-run.cmd'
$commands = [System.Collections.Generic.List[string]]::new()
$commands.Add('@echo off')
$commands.Add(('call "{0}" >nul' -f $vcvars))
$commands.Add('if errorlevel 1 exit /b 1')
$commands.Add(('cd /d "{0}"' -f $tempRoot))
$commands.Add(('cl /Bv > "{0}" 2>&1' -f $versionPath))
foreach ($item in $objects) {
    $sourcePath = Join-Path $tempRoot $item.source
    $objectPath = Join-Path $buildRoot $item.object
    $commands.Add(('cl {0} /c /I"{1}" "{2}" /Fo"{3}" >> "{4}" 2>&1' -f `
        ($flags -join ' '),$includePath,$sourcePath,$objectPath,$logPath))
    $commands.Add('if errorlevel 1 exit /b 1')
}
$objectArgs = ($objects | ForEach-Object { '"' + (Join-Path $buildRoot $_.object) + '"' }) -join ' '
$commands.Add(('cl /nologo /O2 /MD /Fe:"{0}" {1} >> "{2}" 2>&1' -f $exePath,$objectArgs,$logPath))
$commands.Add('if errorlevel 1 exit /b 1')
$commands.Add(('"{0}" > "{1}" 2> "{2}"' -f $exePath,$rawPath,$runLog))
$commands.Add('exit /b %ERRORLEVEL%')
[System.IO.File]::WriteAllLines($commandPath,$commands.ToArray(),[Text.Encoding]::ASCII)
& $env:ComSpec /d /c $commandPath
if ($LASTEXITCODE -ne 0) {
    $buildLog = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { '(no build log)' }
    $runOutput = if (Test-Path -LiteralPath $runLog) { Get-Content -LiteralPath $runLog -Raw } else { '(no run log)' }
    throw "Isolated eventburst capture failed with exit code $LASTEXITCODE.`n$buildLog`n$runOutput"
}
$afterTemp = Get-Fingerprint $tempRoot $inputPaths
$afterRepo = Get-Fingerprint $repoRoot $inputPaths
if ($beforeTemp.aggregateSha256 -ne $afterTemp.aggregateSha256) { throw 'The copied benchmark source changed during build/run.' }
if ($beforeRepo.aggregateSha256 -ne $afterRepo.aggregateSha256) { throw 'A repository benchmark input changed during build/run.' }

$os = Get-CimInstance Win32_OperatingSystem
$cpuRegistryKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('HARDWARE\DESCRIPTION\System\CentralProcessor\0')
$cpuName = if ($cpuRegistryKey) { [string]$cpuRegistryKey.GetValue('ProcessorNameString') } else { $null }
if ($cpuRegistryKey) { $cpuRegistryKey.Close() }
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed
foreach ($relative in $inputPaths) {
    $from = Join-Path $tempRoot $relative
    $to = Join-Path $archiveRoot $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
    Copy-Item -LiteralPath $from -Destination $to
}
foreach ($name in @('compiler-version.txt','build.log','run.log','build-and-run.cmd','eventburst-raw.json')) {
    Copy-Item -LiteralPath (Join-Path $tempRoot $name) -Destination (Join-Path $archiveRoot $name)
}
$archivedFingerprint = Get-Fingerprint $archiveRoot $inputPaths
if ($archivedFingerprint.aggregateSha256 -ne $beforeTemp.aggregateSha256) { throw 'Archived source files do not match the built source snapshot.' }
$rawDestination = Join-Path $resultRoot "$resultBase.json"
Copy-Item -LiteralPath $rawPath -Destination $rawDestination
$rawJson = Get-Content -LiteralPath $rawDestination -Raw | ConvertFrom-Json
$manifest = [ordered]@{
    schemaVersion = 'webrc-performance-fx-eventburst-manifest-v1'
    capturedUtc = [DateTime]::UtcNow.ToString('o')
    gitHead = (& git -C $repoRoot rev-parse HEAD).Trim()
    gitBranch = (& git -C $repoRoot branch --show-current).Trim()
    qualification = 'Isolated native BeatRepeat 64-event, 64-frame callback capture; not whole-graph realtime qualification.'
    os = [ordered]@{ caption = $os.Caption; version = $os.Version; buildNumber = $os.BuildNumber }
    cpu = [ordered]@{ registryName = $cpuName; wmi = $cpu }
    processPriorityClass = 'Normal; no affinity or realtime-priority change'
    compilerVersionOutput = Get-Content -LiteralPath $versionPath -Raw
    compileFlags = $flags
    copiedInputFingerprintBefore = $beforeTemp
    copiedInputFingerprintAfter = $afterTemp
    originalInputFingerprintBefore = $beforeRepo
    originalInputFingerprintAfter = $afterRepo
    archivedInputFingerprint = $archivedFingerprint
    sourceSnapshotUnchanged = $beforeTemp.aggregateSha256 -eq $afterTemp.aggregateSha256
    repositoryInputsUnchangedDuringCapture = $beforeRepo.aggregateSha256 -eq $afterRepo.aggregateSha256
    archivedSourcesMatchBuiltCopy = $archivedFingerprint.aggregateSha256 -eq $beforeTemp.aggregateSha256
    rawResultPath = $rawDestination
    rawResultSha256 = Get-Hash $rawDestination
    callbackP99Ns = $rawJson.wallTimingSummary.p99Ns
    callbackP999Ns = $rawJson.wallTimingSummary.p999Ns
    callbackMaxNs = $rawJson.wallTimingSummary.maxNs
    over60PercentBudget = $rawJson.wallTimingSummary.over60PercentBudget
    over80PercentBudget = $rawJson.wallTimingSummary.over80PercentBudget
    over100PercentBudget = $rawJson.wallTimingSummary.over100PercentBudget
    repeatFramesCopiedPerCallbackMax = $rawJson.maximumRepeatFramesCopiedPerCallback
    timerMethod = 'std::chrono::steady_clock; raw wall durations retained without overhead subtraction; an independent empty clock-pair series is retained.'
    archivedSourceDirectory = $archiveRoot
}
$manifestPath = Join-Path $resultRoot "$resultBase.manifest.json"
$manifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
foreach ($file in Get-ChildItem -LiteralPath $archiveRoot -File -Recurse) { $file.IsReadOnly = $true }
Write-Output "RAW_JSON: $rawDestination"
Write-Output "MANIFEST: $manifestPath"
Write-Output "SOURCE_ARCHIVE: $archiveRoot"
Write-Output "SOURCE_SNAPSHOT_SHA256: $($beforeTemp.aggregateSha256)"
Write-Output "TIMING: n=$($rawJson.callbackCount) p99=$($rawJson.wallTimingSummary.p99Ns) p99.9=$($rawJson.wallTimingSummary.p999Ns) max=$($rawJson.wallTimingSummary.maxNs) over60=$($rawJson.wallTimingSummary.over60PercentBudget) over80=$($rawJson.wallTimingSummary.over80PercentBudget) over100=$($rawJson.wallTimingSummary.over100PercentBudget)"
