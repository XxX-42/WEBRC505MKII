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
$benchOutput = Join-Path $resultsDirectory 'native_primitives_latest.json'
$sourceRevision = (& git -C $repoRoot rev-parse HEAD).Trim()
$sourceFiles = @(
    'shared/dsp/include/webrc/dsp/primitives.hpp',
    'shared/dsp/src/primitives.cpp',
    'shared/dsp/benchmarks/native_dsp_primitives_bench.cpp',
    'shared/dsp/CMakeLists.txt'
)
$hashParts = foreach ($relativePath in $sourceFiles) {
    $filePath = Join-Path $repoRoot ($relativePath -replace '/', '\')
    $fileHash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    "$relativePath=$fileHash"
}
$hashText = [string]::Join("`n", $hashParts)
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$sourceHash = [System.BitConverter]::ToString($sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($hashText))).Replace('-', '').ToLowerInvariant()
$sha256.Dispose()
$cpuModel = 'unknown'
try { $cpuModel = (Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1 -ExpandProperty Name).Trim() } catch { }
$osDescription = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
$buildFlags = "MSVC $($toolchain.ToolsetVersion) Release /O2 /Ob2 /DNDEBUG /MD; default precise floating point; no /fp:fast"
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
$buildArgs = @('--build', $BuildRoot, '--target', 'dsp_primitives_tests', 'native_dsp_primitives_bench', 'dsp_primitives_golden')
$lines += '"{0}" {1}' -f $cmake, (ConvertTo-NativeCmdArguments $buildArgs)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$testArgs = @('--test-dir', $BuildRoot, '--output-on-failure', '-R', '^dsp_primitives_tests$')
$lines += '"{0}" {1}' -f $ctestPath, (ConvertTo-NativeCmdArguments $testArgs)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$benchExecutable = Join-Path $BuildRoot 'native_dsp_primitives_bench.exe'
$lines += 'set "WEBRC_DSP_BENCH_JSON={0}"' -f $benchOutput
$lines += 'set "WEBRC_DSP_SOURCE_REV={0}"' -f $sourceRevision
$lines += 'set "WEBRC_DSP_SOURCE_HASH={0}"' -f $sourceHash
$lines += 'set "WEBRC_DSP_BUILD_FLAGS={0}"' -f $buildFlags
$lines += 'set "WEBRC_DSP_CPU={0}"' -f $cpuModel
$lines += 'set "WEBRC_DSP_OS={0}"' -f $osDescription
$lines += '"{0}"' -f $benchExecutable
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
& $env:ComSpec /d /c "`"$runner`""
if ($LASTEXITCODE -ne 0) { throw "Native DSP verification failed with exit code $LASTEXITCODE. Build files: $BuildRoot" }
Write-Output "Native DSP CTest and software benchmark passed. Build files: $BuildRoot; benchmark JSON: $benchOutput"
