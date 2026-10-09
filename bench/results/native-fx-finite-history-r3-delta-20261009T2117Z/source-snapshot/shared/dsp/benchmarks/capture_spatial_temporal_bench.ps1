param(
    [string]$VisualStudioInstallPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$sourcePaths = @(
    'shared/dsp/benchmarks/native_spatial_temporal_bench.cpp',
    'shared/dsp/benchmarks/capture_spatial_temporal_bench.ps1',
    'shared/dsp/src/fft.cpp',
    'shared/dsp/src/spatial_temporal.cpp',
    'shared/dsp/src/primitives.cpp',
    'shared/dsp/include/webrc/dsp/fft.hpp',
    'shared/dsp/include/webrc/dsp/spatial_temporal.hpp',
    'shared/dsp/include/webrc/dsp/primitives.hpp',
    'shared/dsp/tests/spatial_temporal_tests.cpp'
)
$compileSources = @(
    'shared/dsp/benchmarks/native_spatial_temporal_bench.cpp',
    'shared/dsp/src/fft.cpp',
    'shared/dsp/src/spatial_temporal.cpp',
    'shared/dsp/src/primitives.cpp'
)
$flags = @('/nologo', '/std:c++20', '/O2', '/EHsc', '/MD', '/W4', '/DWEBRC_DSP_BENCHMARK=1')

function Get-SourceFingerprint {
    param([string[]]$Paths)
    $fingerprint = [ordered]@{}
    foreach ($relativePath in $Paths) {
        $absolutePath = Join-Path $repoRoot $relativePath
        if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
            throw "Build evidence input is missing: $relativePath"
        }
        $fingerprint[$relativePath] = (Get-FileHash -LiteralPath $absolutePath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $fingerprint
}

if (-not $VisualStudioInstallPath) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $candidate = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($LASTEXITCODE -eq 0 -and $candidate) { $VisualStudioInstallPath = $candidate.Trim() }
    }
}
if (-not $VisualStudioInstallPath) {
    throw 'Could not locate Visual Studio C++ Build Tools. Pass -VisualStudioInstallPath with its installation directory.'
}
$vcvars = Join-Path $VisualStudioInstallPath 'VC/Auxiliary/Build/vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf)) {
    throw "Missing x64 MSVC environment script: $vcvars"
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("webrc-spatial-temporal-capture-" + [Guid]::NewGuid().ToString('N'))
$objDirectory = Join-Path $tempRoot 'obj'
$exePath = Join-Path $tempRoot 'native_spatial_temporal_bench.exe'
$buildCommandPath = Join-Path $tempRoot 'build_and_capture.cmd'
$versionPath = Join-Path $tempRoot 'compiler_version.txt'
$buildLogPath = Join-Path $tempRoot 'build.log'
New-Item -ItemType Directory -Force -Path $objDirectory | Out-Null

$before = Get-SourceFingerprint -Paths $sourcePaths
$includePath = Join-Path $repoRoot 'shared/dsp/include'
$flagArguments = $flags -join ' '
$objectPaths = @()
$compileCommands = [System.Collections.Generic.List[string]]::new()
foreach ($compileSource in $compileSources) {
    $objectName = [System.IO.Path]::GetFileNameWithoutExtension($compileSource) + '.obj'
    $objectPath = Join-Path $objDirectory $objectName
    $objectPaths += $objectPath
    $sourcePath = Join-Path $repoRoot $compileSource
    $compileCommands.Add(('cl {0} /c /I"{1}" "{2}" /Fo"{3}" >> "{4}" 2>&1' -f
        $flagArguments, $includePath, $sourcePath, $objectPath, $buildLogPath))
    $compileCommands.Add('if errorlevel 1 exit /b 1')
}
$objectArguments = ($objectPaths | ForEach-Object { '"' + $_ + '"' }) -join ' '
$commandLines = [System.Collections.Generic.List[string]]::new()
$commandLines.Add('@echo off')
$commandLines.Add(('call "{0}" >nul' -f $vcvars))
$commandLines.Add('if errorlevel 1 exit /b 11')
$commandLines.Add(('cd /d "{0}"' -f $tempRoot))
$commandLines.Add(('cl /Bv > "{0}" 2>&1' -f $versionPath))
foreach ($compileCommand in $compileCommands) { $commandLines.Add($compileCommand) }
$commandLines.Add(('cl /nologo /O2 /MD /Fe:"{0}" {1} >> "{2}" 2>&1' -f $exePath, $objectArguments, $buildLogPath))
$commandLines.Add('exit /b %ERRORLEVEL%')
[System.IO.File]::WriteAllLines($buildCommandPath, $commandLines.ToArray(), [System.Text.Encoding]::ASCII)
& $env:ComSpec /d /c $buildCommandPath
if ($LASTEXITCODE -ne 0) {
    $buildLog = if (Test-Path -LiteralPath $buildLogPath) { Get-Content -LiteralPath $buildLogPath -Raw } else { '(no compiler log)' }
    throw "Fresh spatial/temporal benchmark build failed with exit code $LASTEXITCODE.`n$buildLog"
}

$after = Get-SourceFingerprint -Paths $sourcePaths
foreach ($relativePath in $sourcePaths) {
    if ($before[$relativePath] -ne $after[$relativePath]) {
        throw "Source changed during benchmark build; no evidence will be archived: $relativePath"
    }
}

$compilerVersion = if (Test-Path -LiteralPath $versionPath) {
    (Get-Content -LiteralPath $versionPath -Raw).Trim()
} else {
    throw 'MSVC did not emit compiler version evidence.'
}
$rawOutput = & $exePath | Out-String
if ($LASTEXITCODE -ne 0) {
    throw "Freshly built benchmark exited with code $LASTEXITCODE."
}
$measurement = $rawOutput | ConvertFrom-Json
if ($measurement.schema -ne 'webrc.spatial-temporal-bench.v2') {
    throw "Unexpected benchmark schema '$($measurement.schema)'."
}

$resultsDirectory = Join-Path $PSScriptRoot 'results'
New-Item -ItemType Directory -Force -Path $resultsDirectory | Out-Null
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$target = Join-Path $resultsDirectory "native-spatial-temporal-$stamp.json"
if (Test-Path -LiteralPath $target) {
    throw "Refusing to replace immutable benchmark evidence: $target"
}
$record = [ordered]@{
    schema = 'webrc.spatial-temporal-bench-record.v2'
    capturedUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    machine = [Environment]::MachineName
    operatingSystem = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
    compiler = [ordered]@{
        family = 'MSVC'
        versionOutput = $compilerVersion
        flags = $flags
        target = 'x64 native Windows executable'
        buildMode = 'fresh compile in a unique temporary directory'
    }
    buildInputs = [ordered]@{
        compileSources = $compileSources
        includeDirectory = 'shared/dsp/include'
        sourceAndTestFingerprintBeforeBuild = $before
        sourceAndTestFingerprintAfterBuild = $after
        fingerprintsIdentical = $true
    }
    executableSha256 = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant()
    measurement = $measurement
}
$json = ConvertTo-Json -InputObject $record -Depth 32
$bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json + "`n")
$archiveStream = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try {
    $archiveStream.Write($bytes, 0, $bytes.Length)
    $archiveStream.Flush($true)
} finally {
    $archiveStream.Dispose()
}
Write-Output $target
