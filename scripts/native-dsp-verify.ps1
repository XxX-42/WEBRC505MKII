param(
    [string]$BuildRoot = (Join-Path $env:TEMP ("webrc-native-dsp-verify-" + [Guid]::NewGuid().ToString('N'))),
    [string]$VsInstallPath,
    [string]$VsWherePath,
    [string]$ToolsetVersion
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'native-build-common.ps1')

$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\', '/') + '\'
$BuildRoot = [System.IO.Path]::GetFullPath($BuildRoot)
if (-not $BuildRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "BuildRoot must be under TEMP so compiler /Fo object files stay outside the workspace: $BuildRoot"
}

$toolchain = Resolve-NativeToolchain -VsInstallPath $VsInstallPath -VsWherePath $VsWherePath -ToolsetVersion $ToolsetVersion
$sourceDir = Join-Path $repoRoot 'shared\dsp'
$resultsDirectory = Join-Path $repoRoot 'bench\results'
$runId = [Guid]::NewGuid().ToString('N')
$pendingBenchOutput = Join-Path $BuildRoot ("native_primitives_{0}.json" -f $runId)
$pendingNonlinearOutput = Join-Path $BuildRoot ("native_nonlinear_{0}.json" -f $runId)
$pendingRhythmOutput = Join-Path $BuildRoot ("native_rhythm_{0}.json" -f $runId)
$sourceRevision = (& git -C $repoRoot rev-parse HEAD).Trim()

function Get-DspSourceFingerprint {
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
    foreach ($relativePath in @('scripts/native-dsp-verify.ps1', 'scripts/native-build-common.ps1')) {
        $files.Add((Join-Path $repoRoot ($relativePath -replace '/', '\')))
    }
    $hashParts = foreach ($filePath in ($files | Sort-Object -Unique)) {
        $relativePath = $filePath.Substring($repoRoot.Length).TrimStart('\', '/').Replace('\', '/')
        $fileHash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
        "$relativePath=$fileHash"
    }
    $hashText = [string]::Join("`n", $hashParts)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $fingerprint = [System.BitConverter]::ToString(
            $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($hashText))
        ).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
    return [pscustomobject]@{ Hash = $fingerprint; FileCount = @($files | Sort-Object -Unique).Count }
}

$fingerprintBeforeBuild = Get-DspSourceFingerprint
$sourceHash = $fingerprintBeforeBuild.Hash
$cpuModel = 'unknown'
try { $cpuModel = (Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1 -ExpandProperty Name).Trim() } catch { }
$osDescription = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
$buildFlags = "MSVC $($toolchain.ToolsetVersion) Release /O2 /Ob2 /DNDEBUG /MD /std:c++17; default precise floating point; no /fp:fast"
New-Item -ItemType Directory -Force -Path $resultsDirectory | Out-Null
$cmakeCommand = Get-Command cmake.exe -ErrorAction Stop | Select-Object -First 1
$cmake = $cmakeCommand.Source
$ctestPath = Join-Path (Split-Path $cmake -Parent) 'ctest.exe'
if (-not (Test-Path -LiteralPath $ctestPath -PathType Leaf)) {
    $ctestPath = (Get-Command ctest.exe -ErrorAction Stop | Select-Object -First 1).Source
}
$runner = Join-Path $BuildRoot 'run-dsp-verify.cmd'
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null

$lines = @('@echo off', 'setlocal')
if ($toolchain.VcvarsPath) {
    $activation = 'call "{0}" amd64' -f $toolchain.VcvarsPath
    if ($toolchain.VcvarsVersion) { $activation += " -vcvars_ver=$($toolchain.VcvarsVersion)" }
    $lines += $activation
    $lines += 'if errorlevel 1 exit /b %errorlevel%'
}
$configureArgs = @('-S', $sourceDir, '-B', $BuildRoot, '-G', 'NMake Makefiles',
    "-DCMAKE_MAKE_PROGRAM=$($toolchain.NMakePath)", '-DCMAKE_BUILD_TYPE=Release')
$lines += '"{0}" {1}' -f $cmake, (ConvertTo-NativeCmdArguments $configureArgs)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$buildArgs = @('--build', $BuildRoot, '--target', 'dsp_primitives_tests', 'control_dynamics_tests', 'nonlinear_tests', 'spatial_temporal_tests', 'pitch_tests', 'pitch_profiles_tests', 'fx_registry_tests', 'rhythm_tests', 'musical_fx_adapter_tests', 'musical_fx_registry_bridge_tests', 'voice_fx_tests', 'vocoder_fx_tests', 'synthesis_pitch_fx_tests', 'native_dsp_primitives_bench', 'native_rhythm_bench', 'dsp_primitives_golden')
$lines += '"{0}" {1}' -f $cmake, (ConvertTo-NativeCmdArguments $buildArgs)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$lines += 'set "WEBRC_DSP_BENCH_JSON={0}"' -f $pendingBenchOutput
$lines += 'set "WEBRC_DSP_NONLINEAR_JSON={0}"' -f $pendingNonlinearOutput
$lines += 'set "WEBRC_RHYTHM_BENCH_JSON={0}"' -f $pendingRhythmOutput
$lines += 'set "WEBRC_DSP_SOURCE_REV={0}"' -f $sourceRevision
$lines += 'set "WEBRC_DSP_SOURCE_HASH={0}"' -f $sourceHash
$lines += 'set "WEBRC_DSP_BUILD_FLAGS={0}"' -f $buildFlags
$lines += 'set "WEBRC_DSP_CPU={0}"' -f $cpuModel
$lines += 'set "WEBRC_DSP_OS={0}"' -f $osDescription
$testArgs = @('--test-dir', $BuildRoot, '--output-on-failure', '-R', '^(dsp_primitives_tests|control_dynamics_tests|nonlinear_tests|spatial_temporal_tests|pitch_tests|pitch_profiles_tests|fx_registry_tests|rhythm_tests|musical_fx_adapter_tests|musical_fx_registry_bridge_tests|voice_fx_tests|vocoder_fx_tests|synthesis_pitch_fx_tests)$')
$lines += '"{0}" {1}' -f $ctestPath, (ConvertTo-NativeCmdArguments $testArgs)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$benchExecutable = Join-Path $BuildRoot 'native_dsp_primitives_bench.exe'
$lines += '"{0}"' -f $benchExecutable
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$rhythmExecutable = Join-Path $BuildRoot 'native_rhythm_bench.exe'
$lines += '"{0}"' -f $rhythmExecutable
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$goldenExecutable = Join-Path $BuildRoot 'dsp_primitives_golden.exe'
$goldenDirectory = Join-Path $repoRoot 'shared\dsp\benchmarks\results'
$goldenOutput = Join-Path $goldenDirectory 'native_primitives_golden.json'
New-Item -ItemType Directory -Force -Path $goldenDirectory | Out-Null
$lines += '"{0}" "{1}"' -f $goldenExecutable, $goldenOutput
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$lines += 'exit /b %errorlevel%'
[System.IO.File]::WriteAllLines($runner, $lines, [System.Text.Encoding]::ASCII)

Write-Output "MSVC toolchain: $($toolchain.VsInstallPath) / $($toolchain.ToolsetVersion) ($($toolchain.Source))"
Write-Output "DSP-only build and CTest run in TEMP: $BuildRoot"
Write-Output "Fingerprint includes $($fingerprintBeforeBuild.FileCount) C++/CMake inputs, this verifier, and the shared build helper."
& $env:ComSpec /d /c "`"$runner`""
if ($LASTEXITCODE -ne 0) { throw "Native DSP verification failed with exit code $LASTEXITCODE. Build files: $BuildRoot" }
$fingerprintAfterBuild = Get-DspSourceFingerprint
if ($fingerprintAfterBuild.Hash -ne $fingerprintBeforeBuild.Hash) {
    throw "DSP sources changed during this build/test run; its results are stale and were not promoted. Before=$($fingerprintBeforeBuild.Hash), after=$($fingerprintAfterBuild.Hash). Build files: $BuildRoot"
}
if (-not (Test-Path -LiteralPath $pendingBenchOutput -PathType Leaf) -or
    -not (Test-Path -LiteralPath $pendingNonlinearOutput -PathType Leaf) -or
    -not (Test-Path -LiteralPath $pendingRhythmOutput -PathType Leaf)) {
    throw "DSP, nonlinear, or rhythm measurement JSON is missing; results were not promoted. Build files: $BuildRoot"
}
$benchProvenance = Get-Content -LiteralPath $pendingBenchOutput -Raw | ConvertFrom-Json
$nonlinearReport = Get-Content -LiteralPath $pendingNonlinearOutput -Raw | ConvertFrom-Json
$rhythmReport = Get-Content -LiteralPath $pendingRhythmOutput -Raw | ConvertFrom-Json
if ($rhythmReport.schemaVersion -ne 'webrc-native-rhythm-bench-v1') {
    throw "Unexpected rhythm benchmark schema '$($rhythmReport.schemaVersion)'."
}
foreach ($propertyName in @('sourceCommit', 'sourceFingerprintSha256', 'compiler', 'compilerFlags', 'cpuModel', 'os')) {
    if (-not $benchProvenance.PSObject.Properties[$propertyName]) {
        throw "Primitive benchmark JSON lacks required provenance field '$propertyName'; nonlinear report was not promoted."
    }
    $nonlinearReport | Add-Member -MemberType NoteProperty -Name $propertyName `
        -Value $benchProvenance.$propertyName -Force
    $rhythmReport | Add-Member -MemberType NoteProperty -Name $propertyName `
        -Value $benchProvenance.$propertyName -Force
}
$nonlinearJson = $nonlinearReport | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($pendingNonlinearOutput, $nonlinearJson + "`n",
    [System.Text.UTF8Encoding]::new($false))
$rhythmJson = $rhythmReport | ConvertTo-Json -Depth 16
[System.IO.File]::WriteAllText($pendingRhythmOutput, $rhythmJson + "`n",
    [System.Text.UTF8Encoding]::new($false))
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$benchOutput = Join-Path $resultsDirectory ("native_primitives_{0}_{1}.json" -f $stamp, $sourceHash.Substring(0, 12))
$nonlinearOutput = Join-Path $resultsDirectory ("native_nonlinear_{0}_{1}.json" -f $stamp, $sourceHash.Substring(0, 12))
$rhythmOutput = Join-Path $resultsDirectory ("native_rhythm_{0}_{1}.json" -f $stamp, $sourceHash.Substring(0, 12))
if ((Test-Path -LiteralPath $benchOutput) -or (Test-Path -LiteralPath $nonlinearOutput) -or (Test-Path -LiteralPath $rhythmOutput)) {
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '_' + $runId.Substring(0, 8)
    $benchOutput = Join-Path $resultsDirectory ("native_primitives_{0}_{1}.json" -f $stamp, $sourceHash.Substring(0, 12))
    $nonlinearOutput = Join-Path $resultsDirectory ("native_nonlinear_{0}_{1}.json" -f $stamp, $sourceHash.Substring(0, 12))
    $rhythmOutput = Join-Path $resultsDirectory ("native_rhythm_{0}_{1}.json" -f $stamp, $sourceHash.Substring(0, 12))
}
Move-Item -LiteralPath $pendingBenchOutput -Destination $benchOutput
Move-Item -LiteralPath $pendingNonlinearOutput -Destination $nonlinearOutput
Move-Item -LiteralPath $pendingRhythmOutput -Destination $rhythmOutput
Write-Output "Native DSP CTest and software benchmarks passed with a stable source fingerprint. Build files: $BuildRoot; primitive benchmark JSON: $benchOutput; nonlinear JSON: $nonlinearOutput; rhythm JSON: $rhythmOutput"
