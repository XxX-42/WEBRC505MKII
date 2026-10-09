param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [string]$VcvVars = 'C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$ArtifactRoot = $PSScriptRoot
$SnapshotRoot = Join-Path $ArtifactRoot 'snapshot'
$BuildRoot = Join-Path $ArtifactRoot 'build'
if ((Test-Path -LiteralPath $SnapshotRoot) -or (Test-Path -LiteralPath $BuildRoot)) {
    throw 'Refusing to overwrite an existing snapshot or build directory.'
}
New-Item -ItemType Directory -Path $SnapshotRoot | Out-Null
New-Item -ItemType Directory -Path $BuildRoot | Out-Null

$relativeInputs = @(
    'shared/dsp/include/webrc/dsp/modulated_delay_fx.hpp',
    'shared/dsp/include/webrc/dsp/primitives.hpp',
    'shared/dsp/src/modulated_delay_fx.cpp',
    'shared/dsp/src/primitives.cpp',
    'shared/dsp/tests/modulated_delay_fx_tests.cpp',
    'shared/dsp/benchmarks/modulated_delay_callback_bench.cpp'
)
foreach ($relativePath in $relativeInputs) {
    $source = Join-Path $RepoRoot $relativePath
    $destination = Join-Path $SnapshotRoot $relativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
}

function Get-InputManifest([string]$Root, [string[]]$Paths) {
    $entries = @()
    foreach ($relativePath in $Paths) {
        $fullPath = Join-Path $Root $relativePath
        $item = Get-Item -LiteralPath $fullPath
        $hash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $entries += [pscustomobject]@{ path = $relativePath; sha256 = $hash; bytes = $item.Length }
    }
    return $entries
}

$inputsBefore = Get-InputManifest $SnapshotRoot $relativeInputs
$fingerprintText = ''
foreach ($entry in ($inputsBefore | Sort-Object -Property path)) {
    $fingerprintText += "$($entry.path):$($entry.sha256):$($entry.bytes)`n"
}
$sha = [System.Security.Cryptography.SHA256]::Create()
$fingerprintBytes = [System.Text.Encoding]::UTF8.GetBytes($fingerprintText)
$fingerprint = [Convert]::ToHexString($sha.ComputeHash($fingerprintBytes)).ToLowerInvariant()
$sha.Dispose()

$toolchainLog = Join-Path $ArtifactRoot 'toolchain.log'
$toolchainLine = 'call "' + $VcvVars + '" x64 > nul && cl /Bv /?'
& $env:ComSpec /d /c $toolchainLine *> $toolchainLog
$toolchainExitCode = $LASTEXITCODE

$includeRoot = Join-Path $SnapshotRoot 'shared/dsp/include'
$testSources = @(
    (Join-Path $SnapshotRoot 'shared/dsp/tests/modulated_delay_fx_tests.cpp'),
    (Join-Path $SnapshotRoot 'shared/dsp/src/modulated_delay_fx.cpp'),
    (Join-Path $SnapshotRoot 'shared/dsp/src/primitives.cpp')
)
$testArguments = ($testSources | ForEach-Object { '"' + $_ + '"' }) -join ' '
$testCompileLine = 'call "' + $VcvVars + '" x64 > nul && cd /d "' + $BuildRoot +
    '" && cl /nologo /std:c++17 /O2 /EHsc /MD /W4 /permissive- /I"' +
    $includeRoot + '" ' + $testArguments + ' /Fe"modulated_delay_fx_tests.exe"'
$compileLog = Join-Path $ArtifactRoot 'compile.log'
& $env:ComSpec /d /c $testCompileLine *> $compileLog
$testCompileExitCode = $LASTEXITCODE

$benchSources = @(
    (Join-Path $SnapshotRoot 'shared/dsp/benchmarks/modulated_delay_callback_bench.cpp'),
    (Join-Path $SnapshotRoot 'shared/dsp/src/modulated_delay_fx.cpp'),
    (Join-Path $SnapshotRoot 'shared/dsp/src/primitives.cpp')
)
$benchArguments = ($benchSources | ForEach-Object { '"' + $_ + '"' }) -join ' '
$benchCompileLine = 'call "' + $VcvVars + '" x64 > nul && cd /d "' + $BuildRoot +
    '" && cl /nologo /std:c++17 /O2 /EHsc /MD /W4 /permissive- /I"' +
    $includeRoot + '" ' + $benchArguments + ' /Fe"modulated_delay_callback_bench.exe"'
Add-Content -LiteralPath $compileLog -Value "`n--- benchmark build ---"
& $env:ComSpec /d /c $benchCompileLine *>> $compileLog
$benchCompileExitCode = $LASTEXITCODE

$testLog = Join-Path $ArtifactRoot 'test.log'
$testExitCode = -1
if ($testCompileExitCode -eq 0) {
    Push-Location $BuildRoot
    try {
        & '.\modulated_delay_fx_tests.exe' *> $testLog
        $testExitCode = $LASTEXITCODE
    } finally { Pop-Location }
}

$benchLog = Join-Path $ArtifactRoot 'modulated_delay_callback_bench.json'
$benchExitCode = -1
if ($benchCompileExitCode -eq 0) {
    Push-Location $BuildRoot
    try {
        & '.\modulated_delay_callback_bench.exe' *> $benchLog
        $benchExitCode = $LASTEXITCODE
    } finally { Pop-Location }
}

$inputsAfter = Get-InputManifest $SnapshotRoot $relativeInputs
$beforeJson = $inputsBefore | ConvertTo-Json -Depth 4 -Compress
$afterJson = $inputsAfter | ConvertTo-Json -Depth 4 -Compress
$snapshotStable = $beforeJson -ceq $afterJson
$testBinary = Join-Path $BuildRoot 'modulated_delay_fx_tests.exe'
$benchBinary = Join-Path $BuildRoot 'modulated_delay_callback_bench.exe'
$testBinaryHash = if (Test-Path -LiteralPath $testBinary) {
    (Get-FileHash -LiteralPath $testBinary -Algorithm SHA256).Hash.ToLowerInvariant()
} else { $null }
$benchBinaryHash = if (Test-Path -LiteralPath $benchBinary) {
    (Get-FileHash -LiteralPath $benchBinary -Algorithm SHA256).Hash.ToLowerInvariant()
} else { $null }
$os = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 Caption, Version, BuildNumber, OSArchitecture
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores, NumberOfLogicalProcessors
$testOutput = if (Test-Path -LiteralPath $testLog) { Get-Content -LiteralPath $testLog } else { @() }
$benchObject = if (Test-Path -LiteralPath $benchLog) {
    Get-Content -Raw -LiteralPath $benchLog | ConvertFrom-Json
} else { $null }
$manifest = [ordered]@{
    schemaVersion = 1
    capturedAtLocal = (Get-Date).ToString('o')
    timezone = [TimeZoneInfo]::Local.Id
    captureScriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    sourceFingerprintRecipe = 'Sort relative paths ordinally, concatenate UTF-8 lines path:sha256:bytes\n, then SHA256.'
    sourceFingerprintSha256 = $fingerprint
    sourceSnapshot = 'snapshot/'
    inputFiles = $inputsBefore
    sourceHashesUnchangedAfterBuild = $snapshotStable
    compiler = 'MSVC x64; see toolchain.log for cl /Bv output'
    compilerFlags = @('/std:c++17', '/O2', '/EHsc', '/MD', '/W4', '/permissive-')
    toolchainProbeExitCode = $toolchainExitCode
    testCompileExitCode = $testCompileExitCode
    benchmarkCompileExitCode = $benchCompileExitCode
    testExitCode = $testExitCode
    benchmarkExitCode = $benchExitCode
    testTarget = 'modulated_delay_fx_tests.exe (standalone Release; shared CMake unchanged)'
    benchmarkTarget = 'modulated_delay_callback_bench.exe (64-frame ordinary and 64-event scenarios; standalone kernel only)'
    testBinarySha256 = $testBinaryHash
    benchmarkBinarySha256 = $benchBinaryHash
    benchmarkArtifact = 'modulated_delay_callback_bench.json (chronological raw callback nanoseconds and quantiles)'
    benchmarkCases = if ($benchObject) { $benchObject.cases } else { @() }
    testedCases = @(
        'Five stereo effects: 50,000-frame 64/256 partition parity, sample-offset controls and real signal response.',
        'Vibrato fractional impulse at 492.5 samples; Panning Delay cross-feedback and DC stress.',
        'Allocated-history lower and upper coupled bounds; 2000+50 ms rejected transactionally while exact 1950+50 ms is accepted.',
        'Up to 64 ordered sample events per callback; guarded no-allocation test for each effect kind.'
    )
    environment = [ordered]@{ operatingSystem = $os; processor = $cpu }
    testOutput = $testOutput
}
$manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $ArtifactRoot 'manifest.json') -Encoding utf8
if (-not $snapshotStable -or $toolchainExitCode -ne 0 -or $testCompileExitCode -ne 0 -or
    $benchCompileExitCode -ne 0 -or $testExitCode -ne 0 -or $benchExitCode -ne 0) {
    throw "Capture failed: stable=$snapshotStable probe=$toolchainExitCode testCompile=$testCompileExitCode benchCompile=$benchCompileExitCode test=$testExitCode bench=$benchExitCode"
}
