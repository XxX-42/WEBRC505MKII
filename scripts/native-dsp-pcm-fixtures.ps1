param(
    [string]$BuildRoot = (Join-Path $env:TEMP ("webrc-native-dsp-pcm-" + [Guid]::NewGuid().ToString('N'))),
    [string]$VsInstallPath,
    [string]$VsWherePath,
    [string]$ToolsetVersion,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'native-build-common.ps1')

$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\', '/') + '\'
$BuildRoot = [System.IO.Path]::GetFullPath($BuildRoot)
if (-not $BuildRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "BuildRoot must be under TEMP so compiler object files stay outside the workspace: $BuildRoot"
}
if (Test-Path -LiteralPath $BuildRoot) {
    throw "Refusing to reuse a Native PCM build root: $BuildRoot"
}

$sourceDir = Join-Path $repoRoot 'shared\dsp'
$resultsRoot = Join-Path $repoRoot 'bench\results\dsp_pcm_parity_v2'
$runId = [Guid]::NewGuid().ToString('N')
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$sourceCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sourceCommit)) {
    throw 'Could not determine the repository HEAD for the Native PCM run.'
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $resultsRoot ("native_signalsmith_pitch_parity_v2_{0}_{1}" -f $stamp, $runId.Substring(0, 8))
} else {
    $OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
}
if (-not $OutputDirectory.StartsWith(
    [System.IO.Path]::GetFullPath($resultsRoot).TrimEnd('\', '/') + '\',
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw "OutputDirectory must stay under $resultsRoot"
}
if (Test-Path -LiteralPath $OutputDirectory) {
    throw "Refusing to overwrite an existing PCM evidence directory: $OutputDirectory"
}

function Get-DspSourceSnapshot {
    $extensions = @('.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.ipp', '.inl', '.cmake')
    $roots = @($sourceDir)
    foreach ($vendorRoot in @(
        (Join-Path $repoRoot 'third_party\signalsmith-stretch'),
        (Join-Path $repoRoot 'third_party\signalsmith-linear')
    )) {
        if (Test-Path -LiteralPath $vendorRoot -PathType Container) { $roots += $vendorRoot }
    }
    $files = New-Object 'System.Collections.Generic.List[string]'
    foreach ($rootPath in $roots) {
        foreach ($file in (Get-ChildItem -LiteralPath $rootPath -File -Recurse -ErrorAction Stop)) {
            if ($extensions -contains $file.Extension.ToLowerInvariant() -or $file.Name -eq 'CMakeLists.txt') {
                $files.Add($file.FullName)
            }
        }
    }
    foreach ($relativePath in @('scripts/native-dsp-pcm-fixtures.ps1', 'scripts/native-build-common.ps1')) {
        $files.Add((Join-Path $repoRoot ($relativePath -replace '/', '\')))
    }
    foreach ($relativePath in @(
        'third_party/SIGNALSMITH_PINS.md',
        'third_party/signalsmith-stretch/LICENSE.txt',
        'third_party/signalsmith-linear/LICENSE.txt'
    )) {
        $candidate = Join-Path $repoRoot ($relativePath -replace '/', '\')
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $files.Add($candidate) }
    }
    $entries = @()
    foreach ($filePath in ($files | Sort-Object -Unique)) {
        $relativePath = $filePath.Substring($repoRoot.Length).TrimStart('\', '/').Replace('\', '/')
        $item = Get-Item -LiteralPath $filePath
        $entries += [ordered]@{
            path = $relativePath
            bytes = $item.Length
            sha256 = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $hashParts = foreach ($entry in $entries) { "$($entry.path)=$($entry.sha256)" }
    $hashText = [string]::Join(([string][char]10), $hashParts)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $fingerprint = [System.BitConverter]::ToString(
            $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($hashText))
        ).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
    return [pscustomobject]@{ Hash = $fingerprint; FileCount = $entries.Count; Files = $entries }
}

$snapshotBefore = Get-DspSourceSnapshot
$toolchain = Resolve-NativeToolchain -VsInstallPath $VsInstallPath -VsWherePath $VsWherePath -ToolsetVersion $ToolsetVersion
$cmake = (Get-Command cmake.exe -ErrorAction Stop | Select-Object -First 1).Source
$ctestPath = Join-Path (Split-Path $cmake -Parent) 'ctest.exe'
if (-not (Test-Path -LiteralPath $ctestPath -PathType Leaf)) {
    $ctestPath = (Get-Command ctest.exe -ErrorAction Stop | Select-Object -First 1).Source
}

New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
$generatedDirectory = Join-Path $BuildRoot 'generated-fixtures'
$runner = Join-Path $BuildRoot 'run-native-pcm-fixtures.cmd'
$configureOut = Join-Path $BuildRoot 'cmake-configure.stdout.log'
$configureErr = Join-Path $BuildRoot 'cmake-configure.stderr.log'
$buildOut = Join-Path $BuildRoot 'cmake-build.stdout.log'
$buildErr = Join-Path $BuildRoot 'cmake-build.stderr.log'
$ctestOut = Join-Path $BuildRoot 'ctest.stdout.log'
$ctestErr = Join-Path $BuildRoot 'ctest.stderr.log'
$generatorOut = Join-Path $BuildRoot 'fixture-generator.stdout.log'
$generatorErr = Join-Path $BuildRoot 'fixture-generator.stderr.log'

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
)
$configureCommand = '"{0}" {1}' -f $cmake, (ConvertTo-NativeCmdArguments $configureArgs)
$lines += ('{0} >"{1}" 2>"{2}"' -f $configureCommand, $configureOut, $configureErr)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$buildArgs = @(
    '--build', $BuildRoot, '--target',
    'dsp_primitives_tests',
    'control_dynamics_tests',
    'nonlinear_tests',
    'spatial_temporal_tests',
    'pitch_tests',
    'native_dsp_pcm_fixture_generator'
)
$buildCommand = '"{0}" {1}' -f $cmake, (ConvertTo-NativeCmdArguments $buildArgs)
$lines += ('{0} >"{1}" 2>"{2}"' -f $buildCommand, $buildOut, $buildErr)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$testArgs = @(
    '--test-dir', $BuildRoot,
    '--output-on-failure',
    '-R', '^(dsp_primitives_tests|control_dynamics_tests|nonlinear_tests|spatial_temporal_tests|pitch_tests)$'
)
$testCommand = '"{0}" {1}' -f $ctestPath, (ConvertTo-NativeCmdArguments $testArgs)
$lines += ('{0} >"{1}" 2>"{2}"' -f $testCommand, $ctestOut, $ctestErr)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$generatorExe = Join-Path $BuildRoot 'native_dsp_pcm_fixture_generator.exe'
$lines += ('"{0}" "{1}" >"{2}" 2>"{3}"' -f $generatorExe, $generatedDirectory, $generatorOut, $generatorErr)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$lines += 'exit /b 0'
[System.IO.File]::WriteAllLines($runner, $lines, [System.Text.Encoding]::ASCII)

Write-Output "Native DSP source fingerprint $($snapshotBefore.Hash) covers $($snapshotBefore.FileCount) source, vendored, and verifier files."
Write-Output "Configuring, building, running shared CTest, and generating PCM in TEMP: $BuildRoot"
$cmdArguments = @('/d', '/c', ('"' + $runner + '"'))
& $env:ComSpec @cmdArguments
if ($LASTEXITCODE -ne 0) {
    throw "Native PCM fixture build/run failed with exit code $LASTEXITCODE. Build files: $BuildRoot"
}
$snapshotAfter = Get-DspSourceSnapshot
if ($snapshotAfter.Hash -ne $snapshotBefore.Hash) {
    throw "DSP sources changed during the PCM run; results are stale. Before=$($snapshotBefore.Hash), after=$($snapshotAfter.Hash). Build files: $BuildRoot"
}

$draftPath = Join-Path $generatedDirectory 'manifest.draft.json'
if (-not (Test-Path -LiteralPath $draftPath -PathType Leaf)) {
    throw "Native fixture generator did not write its manifest draft: $draftPath"
}
$strictEncoding = New-Object System.Text.UTF8Encoding($false, $true)
$draft = [System.IO.File]::ReadAllText($draftPath, $strictEncoding) | ConvertFrom-Json -AsHashtable -ErrorAction Stop
if ($draft.schemaVersion -ne 2 -or $draft.fixtures.Count -ne 100 -or $draft.partitionProfiles.Count -ne 5) {
    throw 'Native PCM draft manifest has an unexpected schema, fixture count, or partition profile count.'
}

$profileMap = @{}
foreach ($profile in $draft.partitionProfiles) { $profileMap[$profile.id] = $profile }
foreach ($fixture in $draft.fixtures) {
    if ($fixture.module -ne 'F10-F13' -or $fixture.primitive -ne 'SignalsmithStretchAdapter' -or
        $fixture.settings.mode -ne $fixture.mode -or $fixture.settings.channels -ne $fixture.channels -or
        $fixture.settings.transposeRatio -ne $fixture.settings.transposeFactor) {
        throw "Fixture metadata consistency check failed for $($fixture.fixtureId)"
    }
    $profileId = $fixture.partitions.profileId
    if (-not $profileMap.ContainsKey($profileId)) { throw "Unknown partition profile $profileId" }
    $expectedSchedule = @($profileMap[$profileId].callbackFrames)
    $actualSchedule = @($fixture.partitions.callbackFrames)
    if ([string]::Join(',', $expectedSchedule) -ne [string]::Join(',', $actualSchedule) -or
        (($actualSchedule | Measure-Object -Sum).Sum -ne $fixture.frames)) {
        throw "Exact callback schedule does not cover fixture frames: $($fixture.fixtureId)"
    }

    foreach ($reference in @($fixture.inputPcm, $fixture.nativeOutputPcm)) {
        if ($reference.encoding -ne 'float32-le-interleaved' -or
            $reference.frames -ne $fixture.frames -or $reference.channels -ne $fixture.channels) {
            throw "PCM sidecar descriptor mismatch for $($fixture.fixtureId)"
        }
        $payloadPath = Join-Path $generatedDirectory ($reference.path -replace '/', '\')
        if (-not (Test-Path -LiteralPath $payloadPath -PathType Leaf)) {
            throw "Fixture payload missing: $payloadPath"
        }
        $file = Get-Item -LiteralPath $payloadPath
        $expectedBytes = [long]$reference.frames * [long]$reference.channels * 4L
        if ($file.Length -ne $expectedBytes) {
            throw "Fixture payload byte length mismatch for $($reference.path): expected $expectedBytes, got $($file.Length)"
        }
        $reference.bytes = $file.Length
        $reference.sha256 = (Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

$signalsmithPinPath = Join-Path $repoRoot 'third_party\SIGNALSMITH_PINS.md'
$signalsmithPinHash = if (Test-Path -LiteralPath $signalsmithPinPath -PathType Leaf) {
    (Get-FileHash -LiteralPath $signalsmithPinPath -Algorithm SHA256).Hash.ToLowerInvariant()
} else { $null }
$cpuModel = 'unknown'
try { $cpuModel = (Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1 -ExpandProperty Name).Trim() } catch { }
$osDescription = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
$sourceState = @(& git -C $repoRoot status --short -- 'shared/dsp' 'third_party/signalsmith-stretch' 'third_party/signalsmith-linear' 'scripts/native-dsp-pcm-fixtures.ps1' 'scripts/native-build-common.ps1')
$manifest = [ordered]@{
    schemaVersion = 2
    producer = $draft.producer
    purpose = $draft.purpose
    createdUtc = [DateTime]::UtcNow.ToString('o')
    sampleRateHz = $draft.sampleRateHz
    framesPerFixture = $draft.framesPerFixture
    fixtureCount = $draft.fixtures.Count
    partitionProfileCount = $draft.partitionProfiles.Count
    source = [ordered]@{
        gitHead = $sourceCommit
        sourceTreeSha256 = $snapshotBefore.Hash
        sourceFileCount = $snapshotBefore.FileCount
        fileManifest = 'source-files.manifest.json'
        sourceScope = 'shared/dsp, pinned Signalsmith source trees and licenses, native-build-common.ps1, this fixture verifier'
        sourceWasStableAcrossRun = $true
        sourceStatusSnapshot = $sourceState
    }
    nativeToolchain = [ordered]@{
        compiler = "MSVC $($toolchain.ToolsetVersion)"
        visualStudio = $toolchain.VsInstallPath
        cmakePath = $cmake
        cmakeGenerator = 'NMake Makefiles'
        buildType = 'Release'
        compileFlags = "MSVC $($toolchain.ToolsetVersion) Release /O2 /Ob2 /DNDEBUG /MD /std:c++17; default precise floating point; no /fp:fast"
        cpuModel = $cpuModel
        os = $osDescription
    }
    wasmToolchainAtNativeGeneration = [ordered]@{
        status = 'separate browser build; identity and parity result are supplied by the paired Node comparator'
        emscriptenBuildHash = $null
    }
    vendorPins = @(
        [ordered]@{ name='signalsmith-stretch'; versionTag='v1.4.0'; commit='a670068d9aeb64913331d5cc29337b19a457a7df'; license='MIT' },
        [ordered]@{ name='signalsmith-linear'; versionTag='v0.6.4'; commit='de55e6a50ffcf6f8f43f649692d94691c7025151'; license='MIT' }
    )
    vendorPinDocumentSha256 = $signalsmithPinHash
    nativeTests = [ordered]@{ status='PASS'; testsPassed=5; testsFailed=0; outputLog='logs/ctest.stdout.log' }
    fixtureGenerator = [ordered]@{ status='PASS'; outputLog='logs/fixture-generator.stdout.log'; framesPerFixture=$draft.framesPerFixture }
    browserComparison = [ordered]@{ status='pending'; resultPath=$null }
    partitionProfiles = $draft.partitionProfiles
    fixtures = $draft.fixtures
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
foreach ($directory in @('inputs','pcm')) {
    Copy-Item -LiteralPath (Join-Path $generatedDirectory $directory) -Destination $OutputDirectory -Recurse
}
Copy-Item -LiteralPath $draftPath -Destination (Join-Path $OutputDirectory 'manifest.draft.json')
$sourceManifestPath = Join-Path $OutputDirectory 'source-files.manifest.json'
$sourceManifestJson = [ordered]@{
    schema = 'webrc.dsp-source-files.v1'
    gitHead = $sourceCommit
    sourceTreeSha256 = $snapshotBefore.Hash
    fileCount = $snapshotBefore.FileCount
    files = @($snapshotBefore.Files)
} | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText(
    $sourceManifestPath,
    $sourceManifestJson + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
)
$manifest.source.sourceFileManifestSha256 = (Get-FileHash -LiteralPath $sourceManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()

$logDirectory = Join-Path $OutputDirectory 'logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
foreach ($logPath in @(
    $runner, $configureOut, $configureErr, $buildOut, $buildErr,
    $ctestOut, $ctestErr, $generatorOut, $generatorErr
)) {
    Copy-Item -LiteralPath $logPath -Destination $logDirectory
}
$logEntries = @()
foreach ($file in (Get-ChildItem -LiteralPath $logDirectory -File | Sort-Object Name)) {
    $logEntries += [ordered]@{
        path = 'logs/' + $file.Name
        bytes = $file.Length
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$manifest.logs = $logEntries
$manifestPath = Join-Path $OutputDirectory 'manifest.json'
$manifestJson = $manifest | ConvertTo-Json -Depth 20
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, $manifestJson + [Environment]::NewLine, $utf8NoBom)
$manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$strict = New-Object System.Text.UTF8Encoding($false, $true)
$null = [System.IO.File]::ReadAllText($manifestPath, $strict) | ConvertFrom-Json -ErrorAction Stop
Write-Output "Native PCM fixture manifest: $manifestPath"
Write-Output "Manifest SHA256: $manifestHash"
Write-Output "Source tree SHA256: $($snapshotBefore.Hash)"
Write-Output "Native Signalsmith fixture records: $($draft.fixtures.Count); partition profiles: $($draft.partitionProfiles.Count); frames per run: $($draft.framesPerFixture)."
