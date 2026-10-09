param(
    [string]$BuildRoot = (Join-Path $env:TEMP ("webrc-native-dsp-sustained-" + [Guid]::NewGuid().ToString('N'))),
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
    throw "BuildRoot must be under TEMP so compiler /Fo outputs stay outside the workspace: $BuildRoot"
}

$toolchain = Resolve-NativeToolchain -VsInstallPath $VsInstallPath -VsWherePath $VsWherePath -ToolsetVersion $ToolsetVersion
$sourceDir = Join-Path $repoRoot 'shared\dsp'
$resultsDirectory = Join-Path $repoRoot 'bench\results'
$runId = [Guid]::NewGuid().ToString('N')
$pendingOutput = Join-Path $BuildRoot ("native_dsp_sustained_{0}.json" -f $runId)
$sourceRevision = 'unavailable-no-git-metadata'
try {
    $revisionOutput = & git -C $repoRoot rev-parse HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $revisionOutput) { $sourceRevision = $revisionOutput.Trim() }
} catch { }

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
    foreach ($relativePath in @('scripts/native-dsp-sustained-bench.ps1', 'scripts/native-build-common.ps1')) {
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

$fingerprintBefore = Get-DspSourceFingerprint
$cpuModel = 'unknown'
try { $cpuModel = (Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1 -ExpandProperty Name).Trim() } catch { }
$osDescription = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
$buildFlags = "MSVC $($toolchain.ToolsetVersion) Release /O2 /Ob2 /DNDEBUG /MD /std:c++17; default precise floating point; no /fp:fast"
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
New-Item -ItemType Directory -Force -Path $resultsDirectory | Out-Null

$cmakeCommand = Get-Command cmake.exe -ErrorAction Stop | Select-Object -First 1
$cmake = $cmakeCommand.Source
$configureStdout = Join-Path $BuildRoot 'configure.stdout.log'
$configureStderr = Join-Path $BuildRoot 'configure.stderr.log'
$buildStdout = Join-Path $BuildRoot 'build.stdout.log'
$buildStderr = Join-Path $BuildRoot 'build.stderr.log'
$runStdout = Join-Path $BuildRoot 'run.stdout.log'
$runStderr = Join-Path $BuildRoot 'run.stderr.log'
$runner = Join-Path $BuildRoot 'run-sustained-bench.cmd'

$lines = @('@echo off', 'setlocal')
if ($toolchain.VcvarsPath) {
    $activation = 'call "{0}" amd64' -f $toolchain.VcvarsPath
    if ($toolchain.VcvarsVersion) { $activation += " -vcvars_ver=$($toolchain.VcvarsVersion)" }
    $lines += $activation
    $lines += 'if errorlevel 1 exit /b %errorlevel%'
}
$configureArgs = @('-S', $sourceDir, '-B', $BuildRoot, '-G', 'NMake Makefiles',
    "-DCMAKE_MAKE_PROGRAM=$($toolchain.NMakePath)", '-DCMAKE_BUILD_TYPE=Release')
$configureCommand = '"{0}" {1}' -f $cmake, (ConvertTo-NativeCmdArguments $configureArgs)
$lines += ('{0} >"{1}" 2>"{2}"' -f $configureCommand, $configureStdout, $configureStderr)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$buildArgs = @('--build', $BuildRoot, '--target', 'native_dsp_sustained_bench')
$buildCommand = '"{0}" {1}' -f $cmake, (ConvertTo-NativeCmdArguments $buildArgs)
$lines += ('{0} >"{1}" 2>"{2}"' -f $buildCommand, $buildStdout, $buildStderr)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$lines += 'set "WEBRC_DSP_SUSTAINED_JSON={0}"' -f $pendingOutput
$lines += 'set "WEBRC_DSP_SOURCE_REV={0}"' -f $sourceRevision
$lines += 'set "WEBRC_DSP_SOURCE_HASH={0}"' -f $fingerprintBefore.Hash
$lines += 'set "WEBRC_DSP_BUILD_FLAGS={0}"' -f $buildFlags
$lines += 'set "WEBRC_DSP_CPU={0}"' -f $cpuModel
$lines += 'set "WEBRC_DSP_OS={0}"' -f $osDescription
$executable = Join-Path $BuildRoot 'native_dsp_sustained_bench.exe'
$lines += '"{0}" >"{1}" 2>"{2}"' -f $executable, $runStdout, $runStderr
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$lines += 'exit /b 0'
[System.IO.File]::WriteAllLines($runner, $lines, [System.Text.Encoding]::ASCII)

Write-Output "Native per-module 64-frame benchmark buildRoot=$BuildRoot"
Write-Output "Source fingerprint $($fingerprintBefore.Hash) over $($fingerprintBefore.FileCount) inputs"
& $env:ComSpec /d /c "`"$runner`""
if ($LASTEXITCODE -ne 0) { throw "Native sustained benchmark build/run failed with exit code $LASTEXITCODE. Logs: $BuildRoot" }
$fingerprintAfter = Get-DspSourceFingerprint
if ($fingerprintAfter.Hash -ne $fingerprintBefore.Hash) {
    throw "DSP sources changed during benchmark; captured output is stale. Before=$($fingerprintBefore.Hash) After=$($fingerprintAfter.Hash)"
}
if (-not (Test-Path -LiteralPath $pendingOutput -PathType Leaf)) { throw "Benchmark JSON missing: $pendingOutput" }
$jsonEncoding = New-Object System.Text.UTF8Encoding($false, $true)
$jsonText = [System.IO.File]::ReadAllText($pendingOutput, $jsonEncoding)
$report = $jsonText | ConvertFrom-Json
if ($report.schemaVersion -ne 'webrc-native-sustained-dsp-v1') { throw "Unexpected sustained benchmark schema '$($report.schemaVersion)'" }
if ($report.sourceFingerprintSha256 -ne $fingerprintBefore.Hash) { throw 'Benchmark JSON source fingerprint does not match verifier fingerprint.' }
if (@($report.cases).Count -lt 49) { throw "Expected broad per-module coverage including pool/long-IR workloads and per-callback YIN worst case; found $(@($report.cases).Count) cases." }
foreach ($case in $report.cases) {
    if (-not $case.processSucceeded -or $case.processOperatorNewCalls -ne 0 -or
        $case.finiteOutputSamples -ne ($case.callbacks * $case.hostCallbackFrames * 2)) {
        throw "Case failed finite/no-new checks: $($case.id)"
    }
    if ([double]::IsNaN([double]$case.inputPeak) -or [double]::IsInfinity([double]$case.inputPeak) -or $case.inputPeak -gt 0.3) {
        throw "Input fixture amplitude is outside the deterministic bounded signal contract: $($case.id), peak=$($case.inputPeak)"
    }
    if ($case.outputRequired -and $case.nonzeroOutputSamples -eq 0) { throw "Expected active non-zero output for $($case.id)" }
    if (@($case.stages).Count -ne 4) { throw "Missing stage timing arrays for $($case.id)" }
    foreach ($stage in $case.stages) {
        if (@($stage.samplesNs).Count -ne $stage.callbackCount) { throw "Bad raw timing count in $($case.id)/$($stage.name)" }
    }
    if ($case.id -eq 'GranularTexture_32Slot' -and $case.activeHighWater -lt 32) {
        throw "Expected full 32-slot granular workload; high-water was $($case.activeHighWater)."
    }
    if ($case.id -eq 'RhythmRenderer_Dense' -and $case.eventCountFinal -eq 0) {
        throw 'Expected rhythm workload to trigger scheduled events.'
    }
    if ($case.id -eq 'OversampledNonlinear_2x_WDF' -and
        ($case.latencyModel -ne 'measured_halfband_fir_group_delay' -or $case.declaredLatencySamples -ne 14.75)) {
        throw 'WDF oversampling latency metadata does not carry the measured 14.75-sample FIR group delay.'
    }
}
$requiredIds = @('Sinc8Read', 'PartitionedConvolver_4096tap', 'GranularTexture_32Slot', 'YinPitchDetector_2048EveryCallback')
foreach ($requiredId in $requiredIds) {
    if (-not (@($report.cases | Where-Object { $_.id -eq $requiredId }).Count -eq 1)) {
        throw "Required sustained workload is missing or duplicated: $requiredId"
    }
}
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$archive = Join-Path $resultsDirectory ("native_dsp_sustained_{0}_{1}.json" -f $stamp, $fingerprintBefore.Hash.Substring(0, 12))
if (Test-Path -LiteralPath $archive) { throw "Refusing to overwrite immutable result $archive" }
Move-Item -LiteralPath $pendingOutput -Destination $archive
Write-Output "Validated per-module raw timing result: $archive"
Write-Output "Cases=$(@($report.cases).Count); rawCallbacksPerCase=$($report.calls.startup + $report.calls.warmup + $report.calls.steady + $report.calls.flush); software-only; no device/XRUN claim."
