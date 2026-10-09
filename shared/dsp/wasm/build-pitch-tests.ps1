param(
    [string]$EmSdkRoot,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

$expectedSdkCommit = '35ff8a6d150541276abbc6bae512ca90bcfbe220'
$expectedCompilerVersion = '6.0.10'
$expectedCompilerCommit = 'd6c521a7f05449857c76bd99e396895583cf2083'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path

if (-not $EmSdkRoot) {
    if ($env:EMSDK) {
        $EmSdkRoot = $env:EMSDK
    } else {
        $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
        $candidateRoots = @(
            (Join-Path $localAppData 'CodexBuildTools\emsdk-6.0.10'),
            (Join-Path $localAppData 'Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\CodexBuildTools\emsdk-6.0.10')
        )
        $EmSdkRoot = $candidateRoots | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }
}
if (-not $EmSdkRoot -or -not (Test-Path -LiteralPath $EmSdkRoot)) {
    throw 'Emscripten SDK 6.0.10 was not found. Pass -EmSdkRoot or set EMSDK.'
}
$EmSdkRoot = (Resolve-Path -LiteralPath $EmSdkRoot).Path
$sdkCommit = (& git -C $EmSdkRoot rev-parse HEAD).Trim()
if ($sdkCommit -ne $expectedSdkCommit) {
    throw "Unexpected emsdk manager commit '$sdkCommit'; expected '$expectedSdkCommit'."
}

$compiler = Join-Path $EmSdkRoot 'upstream\emscripten\em++.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    throw "Emscripten C++ compiler was not found at '$compiler'."
}
$env:EMSDK = $EmSdkRoot
$env:PATH = "$EmSdkRoot;$EmSdkRoot\upstream\emscripten;$env:PATH"
$compilerIdentity = (& $compiler --version | Select-Object -First 1).Trim()
if ($compilerIdentity -notmatch " $expectedCompilerVersion \($expectedCompilerCommit\)$") {
    throw "Unexpected Emscripten compiler: '$compilerIdentity'."
}

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoRoot 'test-results\dsp-wasm'
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$testModulePath = Join-Path $OutputDirectory 'pitch-tests.cjs'
$testWasmPath = Join-Path $OutputDirectory 'pitch-tests.wasm'
$manifestPath = Join-Path $OutputDirectory 'pitch-tests.build.json'
$runScriptPath = Join-Path $PSScriptRoot 'tests\run-pitch-tests.mjs'
$includeDsp = Join-Path $repoRoot 'shared\dsp\include'
$includeStretch = Join-Path $repoRoot 'third_party\signalsmith-stretch\include'
$includeLinear = Join-Path $repoRoot 'third_party\signalsmith-linear\include'
$translationUnits = @(
    (Join-Path $repoRoot 'shared\dsp\src\primitives.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\fft.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\pitch.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\signalsmith_adapter.cpp'),
    (Join-Path $repoRoot 'shared\dsp\tests\pitch_tests.cpp')
)

function Get-ContainedRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$TargetPath
    )
    $separator = [IO.Path]::DirectorySeparatorChar
    $baseFullPath = [IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/') + $separator
    $targetFullPath = [IO.Path]::GetFullPath($TargetPath)
    if (-not $targetFullPath.StartsWith($baseFullPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path '$targetFullPath' is outside the expected root '$baseFullPath'."
    }
    return $targetFullPath.Substring($baseFullPath.Length).Replace('\', '/')
}

$sourceInputs = @(
    $translationUnits
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\primitives.hpp')
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\fft.hpp')
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\pitch.hpp')
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\signalsmith_adapter.hpp')
    (Join-Path $repoRoot 'shared\dsp\wasm\build-pitch-tests.ps1')
    $runScriptPath
    (Join-Path $repoRoot 'third_party\SIGNALSMITH_PINS.md')
)
foreach ($vendorRoot in @(
    (Join-Path $repoRoot 'third_party\signalsmith-stretch'),
    (Join-Path $repoRoot 'third_party\signalsmith-linear')
)) {
    if (-not (Test-Path -LiteralPath $vendorRoot -PathType Container)) {
        throw "Pinned Signalsmith vendor tree is missing: '$vendorRoot'."
    }
    $sourceInputs += Get-ChildItem -LiteralPath $vendorRoot -File -Recurse |
        Where-Object {
            @('.h', '.hh', '.hpp', '.hxx', '.ipp', '.inl') -contains $_.Extension.ToLowerInvariant() -or
            $_.Name -eq 'LICENSE.txt' -or $_.Name -eq 'README.md'
        } | Select-Object -ExpandProperty FullName
}
$sourceInputs = @($sourceInputs | Sort-Object -Unique)
foreach ($sourcePath in $sourceInputs) {
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "A pitch-WASM source input is missing: '$sourcePath'."
    }
}

function Get-SourceHashes {
    $hashes = [ordered]@{}
    foreach ($sourcePath in $sourceInputs) {
        $resolvedSourcePath = [IO.Path]::GetFullPath($sourcePath)
        $relativePath = Get-ContainedRelativePath -BasePath $repoRoot -TargetPath $resolvedSourcePath
        $hashes[$relativePath] = (Get-FileHash -LiteralPath $resolvedSourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $hashes
}

$sourceHashesBefore = Get-SourceHashes
$toolchainFiles = @(
    (Join-Path $EmSdkRoot 'upstream\emscripten\em++.exe'),
    (Join-Path $EmSdkRoot 'upstream\emscripten\em++.py'),
    (Join-Path $EmSdkRoot 'upstream\emscripten\emcc.py'),
    (Join-Path $EmSdkRoot 'upstream\bin\clang++.exe'),
    (Join-Path $EmSdkRoot 'upstream\bin\wasm-ld.exe')
)
foreach ($toolchainFile in $toolchainFiles) {
    if (-not (Test-Path -LiteralPath $toolchainFile -PathType Leaf)) {
        throw "Pinned Emscripten toolchain file is missing: '$toolchainFile'."
    }
}
$toolchainHashesBefore = @{}
foreach ($toolchainFile in $toolchainFiles) {
    $toolchainRelativePath = Get-ContainedRelativePath -BasePath $EmSdkRoot -TargetPath $toolchainFile
    $toolchainHashesBefore[$toolchainRelativePath] = (Get-FileHash -LiteralPath $toolchainFile -Algorithm SHA256).Hash.ToLowerInvariant()
}
$arguments = @(
    '-std=c++17', '-O2', '-msimd128', '-fno-exceptions', '-fno-rtti', '-fno-threadsafe-statics',
    '-Wall', '-Wextra',
    "-I$includeDsp", "-I$includeStretch", "-I$includeLinear",
    $translationUnits,
    '-sEXIT_RUNTIME=1', '-sENVIRONMENT=node', '-sALLOW_MEMORY_GROWTH=0',
    '-sINITIAL_MEMORY=67108864', '-sSTACK_SIZE=1048576',
    "-o$testModulePath"
)

Write-Output "emsdk=$EmSdkRoot"
Write-Output "emsdkCommit=$sdkCommit"
Write-Output "compiler=$compilerIdentity"
Write-Output "output=$testModulePath"
& $compiler @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Pitch WASM test build failed with exit code $LASTEXITCODE."
}

$sourceHashesAfter = Get-SourceHashes
$sourceChanges = @($sourceHashesBefore.Keys | Where-Object { $sourceHashesBefore[$_] -ne $sourceHashesAfter[$_] })
if ($sourceChanges.Count -gt 0) {
    Remove-Item -LiteralPath $testModulePath, $testWasmPath -ErrorAction SilentlyContinue
    throw "Pitch DSP sources changed during compilation; refusing to write a build manifest: $($sourceChanges -join ', ')."
}
foreach ($toolchainFile in $toolchainFiles) {
    $toolchainRelativePath = Get-ContainedRelativePath -BasePath $EmSdkRoot -TargetPath $toolchainFile
    $toolchainHashAfter = (Get-FileHash -LiteralPath $toolchainFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($toolchainHashesBefore[$toolchainRelativePath] -ne $toolchainHashAfter) {
        Remove-Item -LiteralPath $testModulePath, $testWasmPath -ErrorAction SilentlyContinue
        throw "Toolchain changed during the build: '$toolchainRelativePath'."
    }
}

$canonicalSourcePaths = [string[]]@($sourceHashesBefore.Keys)
[Array]::Sort($canonicalSourcePaths, [StringComparer]::Ordinal)
$canonicalSourceSet = [string]::Join("`n", @($canonicalSourcePaths | ForEach-Object { "$_=$($sourceHashesBefore[$_])" }))
$sha256Provider = [Security.Cryptography.SHA256]::Create()
try {
    $sourceSetDigest = $sha256Provider.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonicalSourceSet))
    $sourceSetHash = ([BitConverter]::ToString($sourceSetDigest)).Replace('-', '').ToLowerInvariant()
} finally {
    $sha256Provider.Dispose()
}
$artifacts = @()
foreach ($artifactPath in @($testModulePath, $testWasmPath)) {
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
        throw "Expected pitch test artifact is missing: '$artifactPath'."
    }
    $artifacts += [ordered]@{
        file = Get-ContainedRelativePath -BasePath $repoRoot -TargetPath $artifactPath
        byteLength = (Get-Item -LiteralPath $artifactPath).Length
        sha256 = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$manifest = [ordered]@{
    schemaVersion = 1
    suite = 'shared-dsp-pitch-wasm-functional'
    artifacts = $artifacts
    build = [ordered]@{
        emsdkCommit = $sdkCommit
        compilerIdentity = $compilerIdentity
        compilerRelativePath = Get-ContainedRelativePath -BasePath $EmSdkRoot -TargetPath $compiler
        toolchainFiles = $toolchainHashesBefore
        invocationArguments = $arguments
    }
    sourceFiles = $sourceHashesBefore
    sourceSetSha256 = $sourceSetHash
    sourceFilesStableDuringBuild = $true
}
$manifestJson = ConvertTo-Json -InputObject $manifest -Depth 16
[IO.File]::WriteAllText($manifestPath, "$manifestJson`n", [Text.UTF8Encoding]::new($false))
Write-Output "manifest=$manifestPath"
Write-Output "sourceSetSha256=$sourceSetHash"

$node = (Get-Command node -ErrorAction Stop | Select-Object -First 1).Source
& $node $runScriptPath $testModulePath $manifestPath
if ($LASTEXITCODE -ne 0) {
    throw "Pitch WASM tests failed with exit code $LASTEXITCODE."
}
