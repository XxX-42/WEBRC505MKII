param(
    [string]$BuildRoot = (Join-Path $env:TEMP ("webrc-native-dsp-asan-" + [Guid]::NewGuid().ToString('N'))),
    [string]$VsInstallPath,
    [string]$VsWherePath,
    [string]$ToolsetVersion,
    [string]$ClangClPath,
    [ValidateRange(1, 600)]
    [int]$TestTimeoutSeconds = 90,
    [ValidateRange(1, 60)]
    [int]$PreflightTimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'native-build-common.ps1')

$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\', '/') + '\'
$BuildRoot = [System.IO.Path]::GetFullPath($BuildRoot)
if (-not $BuildRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "BuildRoot must be under TEMP so compiler /Fo object files stay outside the workspace: $BuildRoot"
}

$sourceDir = Join-Path $repoRoot 'shared\dsp'
$toolchain = Resolve-NativeToolchain -VsInstallPath $VsInstallPath -VsWherePath $VsWherePath -ToolsetVersion $ToolsetVersion
$asanCompiler = 'cl'
$clangBin = $null
$asanRuntimeDir = $null
if ($ClangClPath) {
    $ClangClPath = (Resolve-Path -LiteralPath $ClangClPath -ErrorAction Stop).Path
    if ((Split-Path -Leaf $ClangClPath) -notin @('clang-cl.exe', 'clang-cl')) {
        throw "ClangClPath must name clang-cl.exe: $ClangClPath"
    }
    $clangBin = Split-Path -Parent $ClangClPath
    $clangRoot = Split-Path -Parent $clangBin
    $resourceRoot = Join-Path $clangRoot 'lib\clang'
    $asanRuntimeDirs = @(
        Get-ChildItem -LiteralPath $resourceRoot -Directory -ErrorAction Stop |
            ForEach-Object { Join-Path $_.FullName 'lib\windows' } |
            Where-Object {
                (Test-Path -LiteralPath (Join-Path $_ 'clang_rt.asan_dynamic-x86_64.dll') -PathType Leaf) -and
                (Test-Path -LiteralPath (Join-Path $_ 'clang_rt.asan_dynamic-x86_64.lib') -PathType Leaf) -and
                (Test-Path -LiteralPath (Join-Path $_ 'clang_rt.asan_dynamic_runtime_thunk-x86_64.lib') -PathType Leaf)
            }
    )
    if ($asanRuntimeDirs.Count -ne 1) {
        throw "Expected exactly one usable x64 Clang ASan runtime under $resourceRoot; found $($asanRuntimeDirs.Count)."
    }
    $asanRuntimeDir = $asanRuntimeDirs[0]
    $asanDynamicLibrary = Join-Path $asanRuntimeDir 'clang_rt.asan_dynamic-x86_64.lib'
    $asanRuntimeThunk = Join-Path $asanRuntimeDir 'clang_rt.asan_dynamic_runtime_thunk-x86_64.lib'
    foreach ($requiredPath in @((Join-Path $clangBin 'lld-link.exe'), (Join-Path $clangBin 'LLVM-C.dll'))) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Portable Clang ASan toolchain is incomplete; missing $requiredPath"
        }
    }
    $asanCompiler = $ClangClPath
}
$exeLinkerFlags = '/DEBUG'
if ($ClangClPath) {
    $exeLinkerFlags = '/DEBUG "{0}" /WHOLEARCHIVE:"{1}" /INCLUDE:__asan_seh_interceptor' -f $asanDynamicLibrary, $asanRuntimeThunk
}

function Get-DspSanitizerFingerprint {
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
    foreach ($relativePath in @('scripts/native-dsp-sanitize.ps1', 'scripts/native-build-common.ps1')) {
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

$fingerprintBeforeBuild = Get-DspSanitizerFingerprint
$cmakeCommand = Get-Command cmake.exe -ErrorAction Stop | Select-Object -First 1
$cmake = $cmakeCommand.Source
$ctestPath = Join-Path (Split-Path $cmake -Parent) 'ctest.exe'
if (-not (Test-Path -LiteralPath $ctestPath -PathType Leaf)) {
    $ctestPath = (Get-Command ctest.exe -ErrorAction Stop | Select-Object -First 1).Source
}
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
$runner = Join-Path $BuildRoot 'run-dsp-asan.cmd'
$preflightBuildRunner = Join-Path $BuildRoot 'build-asan-preflight.cmd'
$preflightRunRunner = Join-Path $BuildRoot 'run-asan-preflight.cmd'
$preflightSource = Join-Path $BuildRoot 'asan_runtime_preflight.cpp'
$preflightObject = Join-Path $BuildRoot 'asan_runtime_preflight.obj'
$preflightPdb = Join-Path $BuildRoot 'asan_runtime_preflight.pdb'
$preflightExe = Join-Path $BuildRoot 'asan_runtime_preflight.exe'
$preflightStdout = Join-Path $BuildRoot 'asan-preflight.stdout.log'
$preflightStderr = Join-Path $BuildRoot 'asan-preflight.stderr.log'
$preflightCompileStdout = Join-Path $BuildRoot 'asan-preflight-build.stdout.log'
$preflightCompileStderr = Join-Path $BuildRoot 'asan-preflight-build.stderr.log'
$preflightExitFile = Join-Path $BuildRoot 'asan-preflight.exitcode.txt'
$configureStdout = Join-Path $BuildRoot 'cmake-configure.stdout.log'
$configureStderr = Join-Path $BuildRoot 'cmake-configure.stderr.log'
$buildStdout = Join-Path $BuildRoot 'cmake-build.stdout.log'
$buildStderr = Join-Path $BuildRoot 'cmake-build.stderr.log'
$ctestStdout = Join-Path $BuildRoot 'ctest.stdout.log'
$ctestStderr = Join-Path $BuildRoot 'ctest.stderr.log'
if (Test-Path -LiteralPath $preflightExitFile) { Remove-Item -LiteralPath $preflightExitFile -Force }
[System.IO.File]::WriteAllText($preflightSource, "int main() { return 0; }`n", [System.Text.Encoding]::ASCII)
$activationLines = @('@echo off', 'setlocal')
if ($toolchain.VcvarsPath) {
    $activation = 'call "{0}" amd64' -f $toolchain.VcvarsPath
    if ($toolchain.VcvarsVersion) { $activation += " -vcvars_ver=$($toolchain.VcvarsVersion)" }
    $activationLines += $activation
    $activationLines += 'if errorlevel 1 exit /b %errorlevel%'
}
$buildPreflightLines = @($activationLines)
if ($ClangClPath) { $buildPreflightLines += ('set "PATH={0};{1};%PATH%"' -f $clangBin, $asanRuntimeDir) }
$buildPreflightLines += 'echo Building a small AddressSanitizer runtime preflight.'
$preflightCompileCommand = if ($ClangClPath) { '"{0}"' -f $ClangClPath } else { 'cl' }
$preflightCompileLine = '{0} /nologo /fsanitize=address /Zi /EHsc /MD "{1}" /Fo"{2}" /Fd"{3}" /link /DEBUG /OUT:"{4}"' -f $preflightCompileCommand, $preflightSource, $preflightObject, $preflightPdb, $preflightExe
$buildPreflightLines += ('{0} >"{1}" 2>"{2}"' -f $preflightCompileLine, $preflightCompileStdout, $preflightCompileStderr)
$buildPreflightLines += 'if errorlevel 1 exit /b %errorlevel%'
[System.IO.File]::WriteAllLines($preflightBuildRunner, $buildPreflightLines, [System.Text.Encoding]::ASCII)

$runPreflightLines = @($activationLines)
if ($ClangClPath) { $runPreflightLines += ('set "PATH={0};{1};%PATH%"' -f $clangBin, $asanRuntimeDir) }
$runPreflightLines += 'echo Running the AddressSanitizer runtime preflight with a bounded parent timeout.'
$runPreflightLines += '"{0}"' -f $preflightExe
$runPreflightLines += 'set "_webrc_preflight_exit=%errorlevel%"'
$runPreflightLines += ('>"{0}" echo %_webrc_preflight_exit%' -f $preflightExitFile)
$runPreflightLines += 'exit /b %_webrc_preflight_exit%'
[System.IO.File]::WriteAllLines($preflightRunRunner, $runPreflightLines, [System.Text.Encoding]::ASCII)

Write-Output "Building MSVC ASan runtime preflight in TEMP: $BuildRoot"
& $env:ComSpec /d /c "`"$preflightBuildRunner`""
if ($LASTEXITCODE -ne 0) { throw "AddressSanitizer runtime preflight failed to compile with exit code $LASTEXITCODE. Build files: $BuildRoot" }

$preflightProcess = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', "`"$preflightRunRunner`"") -PassThru -WindowStyle Hidden -RedirectStandardOutput $preflightStdout -RedirectStandardError $preflightStderr
if (-not $preflightProcess.WaitForExit($PreflightTimeoutSeconds * 1000)) {
    $taskkillPath = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    if (Test-Path -LiteralPath $taskkillPath -PathType Leaf) {
        Start-Process -FilePath $taskkillPath -ArgumentList @('/PID', [string]$preflightProcess.Id, '/T', '/F') -Wait -WindowStyle Hidden | Out-Null
    }
    if (-not $preflightProcess.HasExited) { $preflightProcess.Kill() }
    $preflightProcess.WaitForExit()
    Write-Output "AddressSanitizer preflight timed out after ${PreflightTimeoutSeconds}s; owned process tree was stopped. stdout=$preflightStdout stderr=$preflightStderr"
    throw "AddressSanitizer runtime preflight hung or did not exit within ${PreflightTimeoutSeconds}s. Instrumented tests were not started. Build files: $BuildRoot"
}
$preflightProcess.Refresh()
if (-not (Test-Path -LiteralPath $preflightExitFile -PathType Leaf)) {
    $processExitCode = if ($null -eq $preflightProcess.ExitCode) { 'unavailable' } else { [string]$preflightProcess.ExitCode }
    Write-Output "AddressSanitizer preflight did not write its child exit code. ProcessExit=$processExitCode stdout=$preflightStdout stderr=$preflightStderr"
    throw "AddressSanitizer runtime preflight status is unknown; instrumented tests were not started. Build files: $BuildRoot"
}
$preflightExitText = (Get-Content -LiteralPath $preflightExitFile -Raw).Trim()
$preflightExitCode = [long]0
if (-not [long]::TryParse($preflightExitText, [ref]$preflightExitCode)) {
    throw "AddressSanitizer preflight wrote an invalid exit code '$preflightExitText'. Build files: $BuildRoot"
}
if ($preflightExitCode -ne 0) {
    Write-Output "AddressSanitizer preflight exited with $preflightExitCode. stdout=$preflightStdout stderr=$preflightStderr"
    throw "AddressSanitizer runtime preflight failed with exit code $preflightExitCode. Instrumented tests were not started. Build files: $BuildRoot"
}
Write-Output "AddressSanitizer runtime preflight exited successfully in $($preflightProcess.ExitTime - $preflightProcess.StartTime). stdout=$preflightStdout stderr=$preflightStderr"

$lines = @('@echo off', 'setlocal')
if ($toolchain.VcvarsPath) {
    $lines += $activation
    $lines += 'if errorlevel 1 exit /b %errorlevel%'
}
if ($ClangClPath) { $lines += ('set "PATH={0};{1};%PATH%"' -f $clangBin, $asanRuntimeDir) }
$configureArgs = @(
    '-S', $sourceDir,
    '-B', $BuildRoot,
    '-G', 'NMake Makefiles',
    "-DCMAKE_MAKE_PROGRAM=$($toolchain.NMakePath)",
    '-DCMAKE_BUILD_TYPE=RelWithDebInfo',
    '-DCMAKE_CXX_FLAGS=/fsanitize=address /Zi /EHsc',
    "-DCMAKE_EXE_LINKER_FLAGS=$exeLinkerFlags",
    '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL'
)
if ($ClangClPath) { $configureArgs += "-DCMAKE_CXX_COMPILER:FILEPATH=$ClangClPath" }
$configureCommand = '"{0}" {1}' -f $cmake, (ConvertTo-NativeCmdArguments $configureArgs)
$lines += ('{0} >"{1}" 2>"{2}"' -f $configureCommand, $configureStdout, $configureStderr)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$buildCommand = '"{0}" --build "{1}"' -f $cmake, $BuildRoot
$lines += ('{0} >"{1}" 2>"{2}"' -f $buildCommand, $buildStdout, $buildStderr)
$lines += 'if errorlevel 1 exit /b %errorlevel%'
$testArgs = @('--test-dir', $BuildRoot, '--output-on-failure', '--timeout', [string]$TestTimeoutSeconds)
$testCommand = '"{0}" {1}' -f $ctestPath, (ConvertTo-NativeCmdArguments $testArgs)
$lines += ('{0} >"{1}" 2>"{2}"' -f $testCommand, $ctestStdout, $ctestStderr)
$lines += 'exit /b %errorlevel%'
[System.IO.File]::WriteAllLines($runner, $lines, [System.Text.Encoding]::ASCII)

Write-Output "AddressSanitizer build: $($toolchain.VsInstallPath) / $($toolchain.ToolsetVersion) ($($toolchain.Source)); C++ compiler=$asanCompiler"
Write-Output "All shared DSP tests build and run in TEMP: $BuildRoot (preflight timeout: ${PreflightTimeoutSeconds}s, CTest timeout: ${TestTimeoutSeconds}s per test)"
Write-Output "Fingerprint SHA256 $($fingerprintBeforeBuild.Hash) includes $($fingerprintBeforeBuild.FileCount) C++/CMake inputs and this sanitizer verifier."
Write-Output "Full logs: preflight compile=$preflightCompileStdout / $preflightCompileStderr; preflight run=$preflightStdout / $preflightStderr; configure=$configureStdout / $configureStderr; build=$buildStdout / $buildStderr; CTest=$ctestStdout / $ctestStderr"
& $env:ComSpec /d /c "`"$runner`""
if ($LASTEXITCODE -ne 0) { throw "Native DSP AddressSanitizer preflight, build, or bounded CTest failed with exit code $LASTEXITCODE. Build files: $BuildRoot" }
$fingerprintAfterBuild = Get-DspSanitizerFingerprint
if ($fingerprintAfterBuild.Hash -ne $fingerprintBeforeBuild.Hash) {
    throw "DSP sources changed during AddressSanitizer verification; results are stale. Before=$($fingerprintBeforeBuild.Hash), after=$($fingerprintAfterBuild.Hash). Build files: $BuildRoot"
}
Write-Output "Native DSP AddressSanitizer build and CTest passed with a stable source fingerprint. Build files: $BuildRoot"
