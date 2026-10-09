@echo off
setlocal
set "ARCHIVE=%~dp0"
set "SRC=%ARCHIVE%source-snapshot"
set "BUILD=%TEMP%\webrc-native-psola-fixture-rebuild"
set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
if not exist "%VCVARS%" exit /b 2
if not exist "%BUILD%" mkdir "%BUILD%"
call "%VCVARS%" amd64 -vcvars_ver=14.29
if errorlevel 1 exit /b %errorlevel%
cd /d "%BUILD%"
cl /Bv > "%ARCHIVE%logs\rebuild-toolchain.txt" 2>&1
cl /nologo /std:c++17 /EHsc /O2 /MD /W4 /permissive- /fp:precise /I"%SRC%\shared\dsp\include" /c "%SRC%\shared\dsp\benchmarks\native_streaming_psola_ratio_fixture.cpp" /Fo"%BUILD%\fixture.obj" /showIncludes > "%ARCHIVE%logs\rebuild-compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /MD /W4 /permissive- /fp:precise /I"%SRC%\shared\dsp\include" /c "%SRC%\shared\dsp\src\pitch.cpp" /Fo"%BUILD%\pitch.obj" /showIncludes >> "%ARCHIVE%logs\rebuild-compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /MD /W4 /permissive- /fp:precise /I"%SRC%\shared\dsp\include" /c "%SRC%\shared\dsp\src\fft.cpp" /Fo"%BUILD%\fft.obj" /showIncludes >> "%ARCHIVE%logs\rebuild-compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /MD /W4 /permissive- /fp:precise /I"%SRC%\shared\dsp\include" /c "%SRC%\shared\dsp\src\primitives.cpp" /Fo"%BUILD%\primitives.obj" /showIncludes >> "%ARCHIVE%logs\rebuild-compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
link /nologo /OUT:"%BUILD%\native_streaming_psola_ratio_fixture.exe" "%BUILD%\fixture.obj" "%BUILD%\pitch.obj" "%BUILD%\fft.obj" "%BUILD%\primitives.obj"
if errorlevel 1 exit /b %errorlevel%
"%BUILD%\native_streaming_psola_ratio_fixture.exe" "%ARCHIVE%inputs\pitch_mono.f32le" "%ARCHIVE%reproduction"
exit /b %errorlevel%