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
$modulePath = Join-Path $OutputDirectory 'webrc-dsp.wasm'
$manifestPath = Join-Path $OutputDirectory 'webrc-dsp.build.json'
$corePath = Join-Path $repoRoot 'shared\dsp\src\primitives.cpp'
$wrapperPath = Join-Path $PSScriptRoot 'webrc_dsp_wasm.cpp'
$coreHeaderPath = Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\primitives.hpp'
$wrapperHeaderPath = Join-Path $PSScriptRoot 'webrc_dsp_wasm.h'
$includeCore = Join-Path $repoRoot 'shared\dsp\include'
$includeWrapper = $PSScriptRoot

function Get-ContainedRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$TargetPath
    )
    $baseFullPath = [IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $targetFullPath = [IO.Path]::GetFullPath($TargetPath)
    if (-not $targetFullPath.StartsWith($baseFullPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path '$targetFullPath' is outside the expected root '$baseFullPath'."
    }
    return $targetFullPath.Substring($baseFullPath.Length).Replace('\', '/')
}

$sourceInputs = @($coreHeaderPath, $corePath, $wrapperHeaderPath, $wrapperPath, $PSCommandPath)
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

$exportedFunctions = '["_webrc_dsp_api_version","_webrc_dsp_max_block_frames","_webrc_dsp_last_create_status","_webrc_dsp_managed_memory_bytes","_webrc_dsp_managed_memory_capacity_bytes","_webrc_dsp_create","_webrc_dsp_destroy","_webrc_dsp_reset","_webrc_dsp_configure","_webrc_dsp_seed","_webrc_dsp_process","_webrc_dsp_equal_power_crossfade","_webrc_dsp_equal_power_pan","_webrc_dsp_sinc8_read","_webrc_dsp_sinc8_lookahead_samples","_webrc_dsp_alloc_f32","_webrc_dsp_free"]'
$arguments = @(
    '-std=c++17', '-O3', '-msimd128', '-fno-exceptions', '-fno-rtti', '-fno-threadsafe-statics',
    '-Wall', '-Wextra',
    "-I$includeCore", "-I$includeWrapper",
    $corePath, $wrapperPath,
    '--no-entry', "-o$modulePath",
    '-sSTANDALONE_WASM=1', '-sFILESYSTEM=0',
    '-sALLOW_MEMORY_GROWTH=0', '-sINITIAL_MEMORY=67108864',
    '-sSTACK_SIZE=1048576', '-sABORTING_MALLOC=0',
    "-sEXPORTED_FUNCTIONS=$exportedFunctions"
)

Write-Output "emsdk=$EmSdkRoot"
Write-Output "emsdkCommit=$sdkCommit"
Write-Output "compiler=$compilerIdentity"
Write-Output "output=$modulePath"
& $compiler @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Emscripten build failed with exit code $LASTEXITCODE."
}

$sourceHashesAfter = Get-SourceHashes
$sourceChanges = @($sourceHashesBefore.Keys | Where-Object { $sourceHashesBefore[$_] -ne $sourceHashesAfter[$_] })
if ($sourceChanges.Count -gt 0) {
    Remove-Item -LiteralPath $modulePath -ErrorAction SilentlyContinue
    throw "DSP sources changed during compilation; refusing to write a build manifest: $($sourceChanges -join ', ')."
}

$canonicalSourceSet = [string]::Join("`n", @($sourceHashesBefore.Keys | Sort-Object | ForEach-Object { "$_=$($sourceHashesBefore[$_])" }))
$sha256Provider = [Security.Cryptography.SHA256]::Create()
try {
    $sourceSetDigest = $sha256Provider.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonicalSourceSet))
    $sourceSetHash = ([BitConverter]::ToString($sourceSetDigest)).Replace('-', '').ToLowerInvariant()
} finally {
    $sha256Provider.Dispose()
}
$moduleHash = (Get-FileHash -LiteralPath $modulePath -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
    schemaVersion = 1
    artifact = [ordered]@{
        file = Get-ContainedRelativePath -BasePath $repoRoot -TargetPath $modulePath
        byteLength = (Get-Item -LiteralPath $modulePath).Length
        sha256 = $moduleHash
    }
    build = [ordered]@{
        emsdkCommit = $sdkCommit
        compilerIdentity = $compilerIdentity
        compilerRelativePath = Get-ContainedRelativePath -BasePath $EmSdkRoot -TargetPath $compiler
        flags = $arguments
    }
    sourceFiles = $sourceHashesBefore
    sourceSetSha256 = $sourceSetHash
    sourceFilesStableDuringBuild = $true
}
$manifestJson = ConvertTo-Json -InputObject $manifest -Depth 16
[IO.File]::WriteAllText($manifestPath, "$manifestJson`n", [Text.UTF8Encoding]::new($false))
Write-Output "manifest=$manifestPath"
Write-Output "wasmSha256=$moduleHash"
Write-Output "sourceSetSha256=$sourceSetHash"
