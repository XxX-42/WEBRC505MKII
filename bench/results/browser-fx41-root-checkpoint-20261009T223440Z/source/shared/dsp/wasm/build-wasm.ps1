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
$coreSources = @(
    $corePath,
    (Join-Path $repoRoot 'shared\dsp\src\control_dynamics.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\nonlinear.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\preamp_fx.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\preamp_models.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\distortion_fx.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\octave_fx.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\octave_models.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\temporal_fx_adapters.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\reconstruction_fx_adapter.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\fft.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\spatial_temporal.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\pitch.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\pitch_profiles.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\signalsmith_adapter.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\streaming_yin.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\live_mono_pitch.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\modulation_fx.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\rhythm.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\cleanroom_rhythm_data.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\performance_fx.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\composite_fx.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\modulated_delay_fx.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\rhythmic_fx.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\spatial_fx_adapters.cpp'),
    (Join-Path $repoRoot 'shared\dsp\src\fx_registry.cpp')
)
$wrapperPath = Join-Path $PSScriptRoot 'webrc_dsp_wasm.cpp'
$coreHeaderPath = Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\primitives.hpp'
$coreHeaders = @(
    $coreHeaderPath,
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\control_dynamics.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\nonlinear.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\preamp_fx.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\preamp_models.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\distortion_fx.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\octave_fx.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\octave_models.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\temporal_fx_adapters.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\reconstruction_fx_adapter.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\fft.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\spatial_temporal.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\pitch.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\pitch_profiles.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\signalsmith_adapter.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\streaming_yin.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\live_mono_pitch.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\modulation_fx.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\rhythm.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\cleanroom_rhythm_data.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\performance_fx.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\composite_fx.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\modulated_delay_fx.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\rhythmic_fx.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\spatial_fx_adapters.hpp'),
    (Join-Path $repoRoot 'shared\dsp\include\webrc\dsp\fx_registry.hpp')
)
$registryPath = Join-Path $PSScriptRoot 'handle_registry.cpp'
$registryHeaderPath = Join-Path $PSScriptRoot 'handle_registry.hpp'
$extendedWrapperPath = Join-Path $PSScriptRoot 'webrc_dsp_extended.cpp'
$extendedWrapperHeaderPath = Join-Path $PSScriptRoot 'webrc_dsp_extended.h'
$fxWrapperPath = Join-Path $PSScriptRoot 'webrc_dsp_fx.cpp'
$fxWrapperHeaderPath = Join-Path $PSScriptRoot 'webrc_dsp_fx.h'
$wrapperHeaderPath = Join-Path $PSScriptRoot 'webrc_dsp_wasm.h'
$includeCore = Join-Path $repoRoot 'shared\dsp\include'
$includeWrapper = $PSScriptRoot
$includeStretch = Join-Path $repoRoot 'third_party\signalsmith-stretch\include'
$includeLinear = Join-Path $repoRoot 'third_party\signalsmith-linear\include'

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

$sourceInputs = @($coreHeaders + $coreSources + @(
    $registryHeaderPath, $registryPath, $wrapperHeaderPath, $wrapperPath,
    $extendedWrapperHeaderPath, $extendedWrapperPath,
    $fxWrapperHeaderPath, $fxWrapperPath, $PSCommandPath,
    (Join-Path $repoRoot 'shared\dsp\CMakeLists.txt'),
    (Join-Path $repoRoot 'third_party\SIGNALSMITH_PINS.md')
))
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
function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)
    $provider = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try {
            $digest = $provider.ComputeHash($stream)
        } finally {
            $stream.Dispose()
        }
        return ([BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()
    } finally {
        $provider.Dispose()
    }
}
function Get-SourceHashes {
    $hashes = [ordered]@{}
    foreach ($sourcePath in $sourceInputs) {
        $resolvedSourcePath = [IO.Path]::GetFullPath($sourcePath)
        $relativePath = Get-ContainedRelativePath -BasePath $repoRoot -TargetPath $resolvedSourcePath
        $hashes[$relativePath] = Get-Sha256Hex -Path $resolvedSourcePath
    }
    return $hashes
}

$sourceHashesBefore = Get-SourceHashes

$exportedFunctions = '["_webrc_dsp_api_version","_webrc_dsp_abi_version","_webrc_dsp_extended_api_version","_webrc_dsp_capabilities","_webrc_dsp_max_block_frames","_webrc_dsp_last_create_status","_webrc_dsp_managed_memory_bytes","_webrc_dsp_managed_memory_capacity_bytes","_webrc_dsp_create","_webrc_dsp_destroy","_webrc_dsp_reset","_webrc_dsp_configure","_webrc_dsp_seed","_webrc_dsp_process","_webrc_dsp_equal_power_crossfade","_webrc_dsp_equal_power_pan","_webrc_dsp_sinc8_read","_webrc_dsp_sinc8_lookahead_samples","_webrc_dsp_alloc_f32","_webrc_dsp_free","_webrc_dsp_alloc_f32_token","_webrc_dsp_transfer_address","_webrc_dsp_free_transfer_token","_webrc_dsp_extended_create","_webrc_dsp_extended_create_convolver","_webrc_dsp_extended_last_create_status","_webrc_dsp_extended_destroy","_webrc_dsp_extended_reset","_webrc_dsp_extended_configure","_webrc_dsp_extended_process_mono","_webrc_dsp_extended_process_stereo","_webrc_dsp_extended_process_vocoder","_webrc_dsp_extended_process_pattern","_webrc_dsp_extended_process_onset","_webrc_dsp_extended_process_platter","_webrc_dsp_extended_process_pitch_stretch","_webrc_dsp_extended_process_spectrum","_webrc_dsp_extended_process_pitch_buffer","_webrc_dsp_extended_yin_analyze","_webrc_dsp_extended_process_yin","_webrc_dsp_extended_pitch_get_estimate","_webrc_dsp_extended_pitch_get_metrics","_webrc_dsp_extended_streaming_set_pitch","_webrc_dsp_extended_pattern_set_gains","_webrc_dsp_extended_schedule_absolute","_webrc_dsp_extended_schedule_tick","_webrc_dsp_extended_collect_events","_webrc_dsp_extended_set_impulse_response","_webrc_dsp_extended_trigger_drum","_webrc_dsp_extended_input_latency_samples","_webrc_dsp_extended_output_latency_samples","_webrc_dsp_extended_rhythm_pattern_count","_webrc_dsp_extended_rhythm_kit_count","_webrc_dsp_extended_rhythm_patterns_sha256","_webrc_dsp_extended_rhythm_kits_sha256","_webrc_dsp_extended_rhythm_algorithmic_latency_samples","_webrc_dsp_extended_rhythm_get_metrics","_webrc_dsp_extended_rhythm_set_pattern","_webrc_dsp_extended_rhythm_set_kit","_webrc_dsp_extended_rhythm_queue_pattern_kit","_webrc_dsp_extended_rhythm_selected_pattern","_webrc_dsp_extended_rhythm_selected_kit","_webrc_dsp_extended_rhythm_start","_webrc_dsp_extended_rhythm_start_words","_webrc_dsp_extended_rhythm_queue_variation","_webrc_dsp_extended_rhythm_queue_fill","_webrc_dsp_extended_rhythm_queue_ending","_webrc_dsp_extended_rhythm_queue_stop","_webrc_dsp_extended_rhythm_queue_tempo","_webrc_dsp_extended_rhythm_process_block","_webrc_dsp_extended_rhythm_process_block_words","_webrc_dsp_extended_rhythm_is_playing","_webrc_dsp_extended_fft_transform","_webrc_dsp_extended_normalized_hadamard","_webrc_dsp_extended_pitch_ratio","_webrc_dsp_fx_api_version","_webrc_dsp_fx_create_v2_api_version","_webrc_dsp_fx_catalog_size","_webrc_dsp_fx_id_pointer","_webrc_dsp_fx_name_pointer","_webrc_dsp_fx_family_pointer","_webrc_dsp_fx_is_processor_available","_webrc_dsp_fx_official_parameters_validated","_webrc_dsp_fx_parameter_count","_webrc_dsp_fx_parameter_info","_webrc_dsp_fx_memory_info","_webrc_dsp_fx_create","_webrc_dsp_fx_create_v2","_webrc_dsp_fx_last_create_status","_webrc_dsp_fx_destroy","_webrc_dsp_fx_reset","_webrc_dsp_fx_set_parameter","_webrc_dsp_fx_process_stereo","_webrc_dsp_fx_process_stereo_events","_webrc_dsp_fx_fixed_latency_samples","_webrc_dsp_fx_latency_model","_webrc_dsp_fx_startup_warmup_frames","_webrc_dsp_fx_startup_warmup_upper_bound_samples"]'
$arguments = @(
    '-std=c++17', '-O3', '-msimd128', '-fno-exceptions', '-fno-rtti', '-fno-threadsafe-statics',
    '-Wall', '-Wextra',
    "-I$includeCore", "-I$includeWrapper", "-I$includeStretch", "-I$includeLinear",
    $coreSources, $registryPath, $wrapperPath, $extendedWrapperPath, $fxWrapperPath,
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
$moduleHash = Get-Sha256Hex -Path $modulePath
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
