param(
    [string]$BuildRoot = (Join-Path $env:TEMP ("webrc-dsp-parity-v21-" + [Guid]::NewGuid().ToString('N'))),
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
    throw "BuildRoot must be under TEMP: $BuildRoot"
}
if (Test-Path -LiteralPath $BuildRoot) { throw "Refusing to reuse parity v2.1 build root: $BuildRoot" }

$sourceDir = Join-Path $repoRoot 'shared\dsp'
$resultsRoot = Join-Path $repoRoot 'bench\results\dsp_pcm_parity_v2_1'
$runId = [Guid]::NewGuid().ToString('N')
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$gitHead = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitHead)) { throw 'Could not read git HEAD.' }
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $resultsRoot ("native_dsp_parity_v21_{0}_{1}" -f $stamp, $runId.Substring(0, 8))
} else { $OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory) }
$resultsRootFull = [System.IO.Path]::GetFullPath($resultsRoot).TrimEnd('\', '/') + '\'
if (-not $OutputDirectory.StartsWith($resultsRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDirectory must be inside $resultsRoot"
}
if (Test-Path -LiteralPath $OutputDirectory) { throw "Refusing to overwrite immutable evidence: $OutputDirectory" }

function Get-SourceSnapshot {
    $extensions = @('.c','.cc','.cpp','.cxx','.h','.hh','.hpp','.hxx','.ipp','.inl','.cmake')
    $roots = @($sourceDir)
    foreach ($vendor in @((Join-Path $repoRoot 'third_party\signalsmith-stretch'),
                          (Join-Path $repoRoot 'third_party\signalsmith-linear'))) {
        if (Test-Path -LiteralPath $vendor -PathType Container) { $roots += $vendor }
    }
    $paths = New-Object 'System.Collections.Generic.List[string]'
    foreach ($root in $roots) {
        foreach ($file in (Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction Stop)) {
            if ($extensions -contains $file.Extension.ToLowerInvariant() -or $file.Name -eq 'CMakeLists.txt') {
                $paths.Add($file.FullName)
            }
        }
    }
    foreach ($relative in @('scripts/native-dsp-parity-v21.ps1','scripts/native-build-common.ps1',
                            'third_party/SIGNALSMITH_PINS.md','third_party/signalsmith-stretch/LICENSE.txt',
                            'third_party/signalsmith-linear/LICENSE.txt')) {
        $candidate = Join-Path $repoRoot ($relative -replace '/', '\')
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $paths.Add($candidate) }
    }
    $entries = @()
    foreach ($filePath in ($paths | Sort-Object -Unique)) {
        $relativePath = $filePath.Substring($repoRoot.Length).TrimStart('\','/').Replace('\','/')
        $item = Get-Item -LiteralPath $filePath
        $entries += [ordered]@{ path=$relativePath; bytes=$item.Length; sha256=(Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $hashParts = foreach ($entry in $entries) { "$($entry.path)=$($entry.sha256)" }
    $hashText = [string]::Join(([string][char]10), $hashParts)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $treeHash = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($hashText))).Replace('-','').ToLowerInvariant()
    } finally { $sha.Dispose() }
    return [pscustomobject]@{ Hash=$treeHash; Count=$entries.Count; Files=$entries }
}

$before = Get-SourceSnapshot
$toolchain = Resolve-NativeToolchain -VsInstallPath $VsInstallPath -VsWherePath $VsWherePath -ToolsetVersion $ToolsetVersion
$cmake = (Get-Command cmake.exe -ErrorAction Stop | Select-Object -First 1).Source
$ctest = Join-Path (Split-Path $cmake -Parent) 'ctest.exe'
if (-not (Test-Path -LiteralPath $ctest -PathType Leaf)) { $ctest = (Get-Command ctest.exe -ErrorAction Stop | Select-Object -First 1).Source }
New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
$generated = Join-Path $BuildRoot 'generated'
$runner = Join-Path $BuildRoot 'run-v21.cmd'
$configureOut = Join-Path $BuildRoot 'configure.stdout.log'
$configureErr = Join-Path $BuildRoot 'configure.stderr.log'
$buildOut = Join-Path $BuildRoot 'build.stdout.log'
$buildErr = Join-Path $BuildRoot 'build.stderr.log'
$testOut = Join-Path $BuildRoot 'ctest.stdout.log'
$testErr = Join-Path $BuildRoot 'ctest.stderr.log'
$generatorOut = Join-Path $BuildRoot 'generator.stdout.log'
$generatorErr = Join-Path $BuildRoot 'generator.stderr.log'

$lines = @('@echo off','setlocal')
if ($toolchain.VcvarsPath) {
    $activate = 'call "{0}" amd64' -f $toolchain.VcvarsPath
    if ($toolchain.VcvarsVersion) { $activate += " -vcvars_ver=$($toolchain.VcvarsVersion)" }
    $lines += $activate
    $lines += 'if errorlevel 1 exit /b %errorlevel%'
}
$configureArgs = @('-S',$sourceDir,'-B',$BuildRoot,'-G','NMake Makefiles',
    "-DCMAKE_MAKE_PROGRAM=$($toolchain.NMakePath)",'-DCMAKE_BUILD_TYPE=Release')
$lines += ('"{0}" {1} >"{2}" 2>"{3}"' -f $cmake,(ConvertTo-NativeCmdArguments $configureArgs),$configureOut,$configureErr)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$buildArgs = @('--build',$BuildRoot,'--target','dsp_primitives_tests','control_dynamics_tests',
    'nonlinear_tests','spatial_temporal_tests','pitch_tests','fx_registry_tests','rhythm_tests','native_dsp_parity_v21_generator')
$lines += ('"{0}" {1} >"{2}" 2>"{3}"' -f $cmake,(ConvertTo-NativeCmdArguments $buildArgs),$buildOut,$buildErr)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$testArgs = @('--test-dir',$BuildRoot,'--output-on-failure','-R',
    '^(dsp_primitives_tests|control_dynamics_tests|nonlinear_tests|spatial_temporal_tests|pitch_tests|fx_registry_tests|rhythm_tests)$')
$lines += ('"{0}" {1} >"{2}" 2>"{3}"' -f $ctest,(ConvertTo-NativeCmdArguments $testArgs),$testOut,$testErr)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$generator = Join-Path $BuildRoot 'native_dsp_parity_v21_generator.exe'
$lines += ('"{0}" "{1}" >"{2}" 2>"{3}"' -f $generator,$generated,$generatorOut,$generatorErr)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$lines += 'exit /b 0'
[System.IO.File]::WriteAllLines($runner,$lines,[System.Text.Encoding]::ASCII)

Write-Output "Source snapshot $($before.Hash) covers $($before.Count) C++/vendor/build/verifier files."
Write-Output "Building shared DSP, CTest, and v2.1 fixture producer in TEMP: $BuildRoot"
& $env:ComSpec /d /c ('"' + $runner + '"')
if ($LASTEXITCODE -ne 0) { throw "v2.1 build/test/generation failed ($LASTEXITCODE); inspect $BuildRoot" }
$after = Get-SourceSnapshot
if ($before.Hash -ne $after.Hash) { throw "Sources changed during run; results are stale. Before=$($before.Hash) After=$($after.Hash)" }

$draftPath = Join-Path $generated 'manifest.draft.json'
$strictUtf8 = New-Object System.Text.UTF8Encoding($false,$true)
$draft = [System.IO.File]::ReadAllText($draftPath,$strictUtf8) | ConvertFrom-Json -AsHashtable -ErrorAction Stop
if ($draft.schemaVersion -ne 3 -or $draft.fixtures.Count -ne 114) { throw 'Unexpected v2.1 draft schema or fixture count.' }

$seen = @{}
$counts = @{}
foreach ($fixture in $draft.fixtures) {
    if ([string]::IsNullOrWhiteSpace($fixture.operation) -or $fixture.wasmKindId -lt 1) { throw 'Every fixture needs explicit operation and stable WASM kind.' }
    if ($seen.ContainsKey($fixture.fixtureId)) { throw "Duplicate fixture id $($fixture.fixtureId)" }
    $seen[$fixture.fixtureId] = $true
    if (-not $counts.ContainsKey($fixture.operation)) { $counts[$fixture.operation] = 0 }
    $counts[$fixture.operation]++
    foreach ($seedField in @('seedState','seedSequence')) {
        if ($fixture.ContainsKey($seedField)) {
            $seedText = $fixture[$seedField]
            if ($seedText -isnot [string]) { throw "$seedField must be encoded as a decimal string in $($fixture.fixtureId)." }
            [void][UInt64]::Parse($seedText,[System.Globalization.CultureInfo]::InvariantCulture)
        }
    }
    if ($fixture.module -eq 'Pcg32') {
        foreach ($seedField in @('seedState','seedSequence')) {
            $topLevelSeed = $fixture[$seedField]
            $settingsSeed = $fixture.settings[$seedField]
            if ($topLevelSeed -isnot [string] -or $settingsSeed -isnot [string]) {
                throw "PCG32 $seedField must be a decimal string at top level and in settings."
            }
            [void][UInt64]::Parse($settingsSeed,[System.Globalization.CultureInfo]::InvariantCulture)
            if ($topLevelSeed -cne $settingsSeed) {
                throw "PCG32 top-level/settings $seedField differ in $($fixture.fixtureId)."
            }
        }
    }
}
foreach ($expected in @{ 'base-biquad-stream'=25; 'base-smoother-stream'=5; 'base-svf-stream'=5; 'base-allpass-stream'=5;
    'base-lagrange-delay-stream'=5; 'base-lfo-stream'=5; 'base-polyblep-stream'=5; 'base-adaa-stream'=5;
    'base-compressor-stereo-stream'=5; 'base-delay-matrix-stereo-stream'=5; 'base-pcg32-stream'=5;
    'yin-analyze'=1; 'psola-buffer'=5; 'streaming-psola'=25; 'phase-vocoder-frame-stream'=3; 'multiband-vocoder'=5 }.GetEnumerator()) {
    if ($counts[$expected.Key] -ne $expected.Value) { throw "Fixture matrix count mismatch for $($expected.Key)" }
}

function Complete-Ref($reference) {
    if ($null -eq $reference) { return }
    $payload = Join-Path $generated ($reference.path -replace '/', '\')
    if (-not (Test-Path -LiteralPath $payload -PathType Leaf)) { throw "Missing sidecar $($reference.path)" }
    $expectedBytes = if ($reference.encoding -eq 'float32-le-interleaved-complex') {
        [long]$reference.frames * [long]$reference.fftFrames * [long]$reference.channels * 8L
    } else { [long]$reference.frames * [long]$reference.channels * 4L }
    $file = Get-Item -LiteralPath $payload
    if ($file.Length -ne $expectedBytes) { throw "Sidecar shape mismatch $($reference.path): expected $expectedBytes got $($file.Length)" }
    $reference.bytes = $file.Length
    $reference.sha256 = (Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant()
}
foreach ($fixture in $draft.fixtures) {
    Complete-Ref $fixture.inputPcm
    Complete-Ref $fixture.nativeOutputPcm
    Complete-Ref $fixture.inputComplex
    Complete-Ref $fixture.nativeOutputComplex
    foreach ($setup in $fixture.setupPayloads) { Complete-Ref $setup.pcm }
    if ($fixture.events) {
        $previous = -1
        foreach ($event in $fixture.events) {
            if ($event.frameOffset -lt $previous -or $event.frameOffset -ge $fixture.frames) { throw "Unordered/out-of-range event in $($fixture.fixtureId)" }
            $previous = $event.frameOffset
        }
    }
}

$cpu = 'unknown'
try { $cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name).Trim() } catch { }
$sourceState = @(& git -C $repoRoot status --short -- 'shared/dsp' 'third_party/signalsmith-stretch' 'third_party/signalsmith-linear' 'scripts/native-dsp-parity-v21.ps1' 'scripts/native-build-common.ps1')
$sourceManifest = [ordered]@{ schema='webrc.dsp-source-files.v1'; gitHead=$gitHead; sourceTreeSha256=$before.Hash; fileCount=$before.Count; files=@($before.Files) }
$sourceManifestJson = $sourceManifest | ConvertTo-Json -Depth 20
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
foreach ($dir in @('inputs','pcm')) { Copy-Item -LiteralPath (Join-Path $generated $dir) -Destination $OutputDirectory -Recurse }
Copy-Item -LiteralPath $draftPath -Destination (Join-Path $OutputDirectory 'manifest.draft.json')
$sourceManifestPath = Join-Path $OutputDirectory 'source-files.manifest.json'
[System.IO.File]::WriteAllText($sourceManifestPath,$sourceManifestJson + [Environment]::NewLine,(New-Object System.Text.UTF8Encoding($false)))
$sourceManifestHash = (Get-FileHash -LiteralPath $sourceManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()

$logsDir = Join-Path $OutputDirectory 'logs'
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
foreach ($file in @($runner,$configureOut,$configureErr,$buildOut,$buildErr,$testOut,$testErr,$generatorOut,$generatorErr)) {
    Copy-Item -LiteralPath $file -Destination $logsDir
}
$logs = @()
foreach ($file in (Get-ChildItem -LiteralPath $logsDir -File | Sort-Object Name)) {
    $logs += [ordered]@{ path='logs/'+$file.Name; bytes=$file.Length; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$manifest = [ordered]@{
    schemaVersion=3; producer=$draft.producer; purpose=$draft.purpose; createdUtc=[DateTime]::UtcNow.ToString('o')
    sampleRateHz=48000; pcmFramesPerFixture=$draft.framesPerFixture; fixtureCount=$draft.fixtures.Count
    source=[ordered]@{ gitHead=$gitHead; sourceTreeSha256=$before.Hash; sourceFileCount=$before.Count; fileManifest='source-files.manifest.json'; sourceFileManifestSha256=$sourceManifestHash; sourceWasStableAcrossRun=$true; sourceStatusSnapshot=$sourceState }
    nativeToolchain=[ordered]@{ compiler="MSVC $($toolchain.ToolsetVersion)"; visualStudio=$toolchain.VsInstallPath; cmakePath=$cmake; cmakeGenerator='NMake Makefiles'; buildType='Release'; compileFlags="MSVC $($toolchain.ToolsetVersion) Release /O2 /Ob2 /DNDEBUG /MD /std:c++17; precise FP; no /fp:fast"; cpuModel=$cpu; os=[System.Runtime.InteropServices.RuntimeInformation]::OSDescription }
    nativeTests=[ordered]@{ status='PASS'; testsPassed=7; testsFailed=0; outputLog='logs/ctest.stdout.log' }
    fixtureGenerator=[ordered]@{ status='PASS'; outputLog='logs/generator.stdout.log'; baseKindMatrix='WASM kinds 1-11'; pitchKindMatrix='WASM extended kinds 108-112' }
    vendorPins=@(
        [ordered]@{ name='signalsmith-stretch'; versionTag='v1.4.0'; commit='a670068d9aeb64913331d5cc29337b19a457a7df'; license='MIT' },
        [ordered]@{ name='signalsmith-linear'; versionTag='v0.6.4'; commit='de55e6a50ffcf6f8f43f649692d94691c7025151'; license='MIT' }
    )
    partitionProfiles=$draft.partitionProfiles; fixtures=$draft.fixtures; logs=$logs
}
$manifestPath = Join-Path $OutputDirectory 'manifest.json'
$manifestJson = $manifest | ConvertTo-Json -Depth 50
[System.IO.File]::WriteAllText($manifestPath,$manifestJson + [Environment]::NewLine,(New-Object System.Text.UTF8Encoding($false)))
$null = [System.IO.File]::ReadAllText($manifestPath,$strictUtf8) | ConvertFrom-Json -ErrorAction Stop
$manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "Native parity v2.1 manifest: $manifestPath"
Write-Output "Manifest SHA256: $manifestHash"
Write-Output "Source tree SHA256: $($before.Hash), files: $($before.Count); fixtures: $($draft.fixtures.Count)."
