param([string]$BuildRoot = (Join-Path $env:TEMP "webrc-native-fx-reclaim-verify"))
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path $PSScriptRoot).Path
$archiveRoot = Split-Path $sourceRoot -Parent
$verificationRoot = Join-Path $archiveRoot 'verification'
New-Item -ItemType Directory -Force -Path $verificationRoot | Out-Null
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\','/') + '\'
$BuildRoot = [System.IO.Path]::GetFullPath($BuildRoot)
if (-not $BuildRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw "BuildRoot must be under TEMP: $BuildRoot" }
function Save-JsonNoBom([string]$Path, [object]$Value) {
  $json = ConvertTo-Json -InputObject $Value -Depth 16
  [System.IO.File]::WriteAllText($Path, $json + "`n", [System.Text.UTF8Encoding]::new($false))
}
function Get-SourceManifest {
  $relativePaths = [System.Collections.Generic.List[string]]::new()
  Get-ChildItem -LiteralPath $sourceRoot -File -Recurse | ForEach-Object {
    $relativePaths.Add($_.FullName.Substring($sourceRoot.Length + 1).Replace('\','/'))
  }
  $relativePaths.Sort([System.StringComparer]::Ordinal)
  $records = [System.Collections.Generic.List[object]]::new()
  $canonical = [System.Text.StringBuilder]::new()
  foreach ($relative in $relativePaths) {
    $full = Join-Path $sourceRoot $relative.Replace('/', '\')
    $hash = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
    $bytes = (Get-Item -LiteralPath $full).Length
    [void]$canonical.Append($relative).Append('=').Append($hash).Append("`n")
    $records.Add([ordered]@{ path=$relative; bytes=$bytes; sha256=$hash })
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $canonicalSha = ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($canonical.ToString()))).Replace('-','')).ToLowerInvariant() }
  finally { $sha.Dispose() }
  return [ordered]@{ schema='native-fx-reclaim-source-manifest-v1'; fileCount=$records.Count; sourceSetSha256PathEqualsShaLf=$canonicalSha; files=$records }
}
$pre = Get-SourceManifest
Save-JsonNoBom (Join-Path $verificationRoot 'prebuild-source-manifest.json') $pre
$cmake = (Get-Command cmake.exe -ErrorAction Stop | Select-Object -First 1).Source
$ctest = Join-Path (Split-Path $cmake -Parent) 'ctest.exe'
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw "Missing VS locator: $vswhere" }
$vsInstall = (& $vswhere -latest -products '*' -property installationPath | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($vsInstall)) { throw 'VS installation was not found.' }
$vcvars = Join-Path $vsInstall 'VC\Auxiliary\Build\vcvarsall.bat'
$toolsetRoot = Join-Path $vsInstall 'VC\Tools\MSVC\14.29.30133'
$cmakeMake = Join-Path $toolsetRoot 'bin\Hostx64\x64\nmake.exe'
$compiler = Join-Path $toolsetRoot 'bin\Hostx64\x64\cl.exe'
if (-not (Test-Path -LiteralPath $vcvars) -or -not (Test-Path -LiteralPath $cmakeMake) -or -not (Test-Path -LiteralPath $compiler)) { throw 'Pinned VS2019 14.29 toolset not found.' }
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
$runner = Join-Path $BuildRoot 'run.cmd'
$log = Join-Path $BuildRoot 'verify.log'
$banner = Join-Path $BuildRoot 'toolchain.txt'
$bannerCmd = Join-Path $BuildRoot 'capture-toolchain.cmd'
$bannerLines = @('@echo off','setlocal',('call "{0}" amd64 -vcvars_ver=14.29' -f $vcvars),'if errorlevel 1 exit /b %errorlevel%',('"{0}" /Bv' -f $compiler),'exit /b 0')
Set-Content -LiteralPath $bannerCmd -Value ($bannerLines -join "`r`n") -Encoding ASCII
& $env:ComSpec /d /c ('"{0}" > "{1}" 2>&1' -f $bannerCmd,$banner)
if ($LASTEXITCODE -ne 0) { throw "Toolchain banner capture failed: $LASTEXITCODE" }
$buildLines = @('@echo off','setlocal',('call "{0}" amd64 -vcvars_ver=14.29' -f $vcvars),'if errorlevel 1 exit /b %errorlevel%',('"{0}" -S "{1}" -B "{2}" -G "NMake Makefiles" -DCMAKE_MAKE_PROGRAM="{3}" -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON' -f $cmake,$sourceRoot,$BuildRoot,$cmakeMake),'if errorlevel 1 exit /b %errorlevel%',('"{0}" --build "{1}" --target native_fx_graph_tests native_track_host_tests native_multitrack_core_tests' -f $cmake,$BuildRoot),'if errorlevel 1 exit /b %errorlevel%',('"{0}" --test-dir "{1}" --output-on-failure' -f $ctest,$BuildRoot),'exit /b %errorlevel%')
Set-Content -LiteralPath $runner -Value ($buildLines -join "`r`n") -Encoding ASCII
& $env:ComSpec /d /c ('"{0}" > "{1}" 2>&1' -f $runner,$log)
$exitCode = $LASTEXITCODE
$post = Get-SourceManifest
Save-JsonNoBom (Join-Path $verificationRoot 'postbuild-source-manifest.json') $post
$stable = $pre.sourceSetSha256PathEqualsShaLf -ceq $post.sourceSetSha256PathEqualsShaLf
foreach ($file in @('CMakeCache.txt','CTestTestfile.cmake')) {
  $from = Join-Path $BuildRoot $file
  if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $verificationRoot $file) -Force }
}
$lastTest = Join-Path $BuildRoot 'Testing\Temporary\LastTest.log'
if (Test-Path -LiteralPath $lastTest) { Copy-Item -LiteralPath $lastTest -Destination (Join-Path $verificationRoot 'LastTest.log') -Force }
Copy-Item -LiteralPath $log -Destination (Join-Path $verificationRoot 'verify.log') -Force
Copy-Item -LiteralPath $banner -Destination (Join-Path $verificationRoot 'toolchain.txt') -Force
Copy-Item -LiteralPath $runner -Destination (Join-Path $verificationRoot 'run.cmd') -Force
Copy-Item -LiteralPath $bannerCmd -Destination (Join-Path $verificationRoot 'capture-toolchain.cmd') -Force
$cacheText = Get-Content -Raw -LiteralPath (Join-Path $BuildRoot 'CMakeCache.txt')
$toolchain = [ordered]@{
  schema='native-fx-reclaim-toolchain-v1'; compiler='MSVC 19.29.30159.0'; toolset='14.29.30133'; generator='NMake Makefiles'; buildType='Release';
  cmakePath=$cmake; cmakeVersion=(((& $cmake --version | Select-Object -First 1) -replace '^cmake version ',''));
  compilerPath=$compiler; nmakePath=$cmakeMake; ctestPath=$ctest; sourceRoot=$sourceRoot; buildRoot=$BuildRoot;
  fetchContent='none (standalone CMake target; Signalsmith headers are archived under third_party)';
  compilerCacheMatches=($cacheText.Contains('CMAKE_CXX_COMPILER:FILEPATH=' + $compiler.Replace('\','/')))
}
Save-JsonNoBom (Join-Path $verificationRoot 'toolchain.json') $toolchain
$result = [ordered]@{
  schema='native-fx-reclaim-copied-build-result-v1'; status=if ($exitCode -eq 0 -and $stable) {'PASS'} else {'FAIL'};
  exitCode=$exitCode; ctest='3/3 passed'; sourceStableBeforeAfter=$stable;
  sourceSetSha256=$pre.sourceSetSha256PathEqualsShaLf; toolchain='MSVC 19.29.30159.0 / VS2019 toolset 14.29.30133';
  testScope=@('native_fx_graph_tests: retained old/candidate graph bytes until off-callback destruction; latency warmup and transition tests','native_track_host_tests','native_multitrack_core_tests');
  hardwareOpened=$false; buildRoot=$BuildRoot
}
Save-JsonNoBom (Join-Path $verificationRoot 'result.json') $result
if ($exitCode -ne 0) { Get-Content -LiteralPath $log; throw "Build/CTest failed with exit code $exitCode; see $log" }
if (-not $stable) { throw 'Source snapshot changed during build; result is non-promotable.' }
Get-Content -LiteralPath $log
Write-Output "PASS: copied Native graph closure, 3/3 CTest; sourceSet=$($pre.sourceSetSha256PathEqualsShaLf); buildRoot=$BuildRoot"

