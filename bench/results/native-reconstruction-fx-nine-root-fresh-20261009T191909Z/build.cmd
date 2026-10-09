@echo off
setlocal
set "ARCHIVE=%~dp0"
set "SRC=%ARCHIVE%source-snapshot\shared\dsp"
set "BUILD=%TEMP%\webrc-reconstruction-fx-nine-build"
set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
if not exist "%VCVARS%" exit /b 2
if not exist "%BUILD%" mkdir "%BUILD%"
call "%VCVARS%" amd64 -vcvars_ver=14.29
if errorlevel 1 exit /b %errorlevel%
cd /d "%BUILD%"
cl /Bv > "%ARCHIVE%logs\toolchain.log" 2>&1
cl /nologo /std:c++17 /EHsc /O2 /MD /W4 /permissive- /fp:precise /showIncludes /I"%SRC%\include" "%SRC%\tests\reconstruction_fx_adapter_tests.cpp" "%SRC%\src\reconstruction_fx_adapter.cpp" "%SRC%\src\temporal_fx_adapters.cpp" "%SRC%\src\distortion_fx.cpp" "%SRC%\src\preamp_fx.cpp" "%SRC%\src\octave_fx.cpp" "%SRC%\src\primitives.cpp" "%SRC%\src\control_dynamics.cpp" "%SRC%\src\nonlinear.cpp" "%SRC%\src\fft.cpp" "%SRC%\src\spatial_temporal.cpp" "%SRC%\src\pitch.cpp" "%SRC%\src\performance_fx.cpp" /Fe:"%BUILD%\reconstruction_fx_adapter_tests.exe" > "%ARCHIVE%logs\build.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
"%BUILD%\reconstruction_fx_adapter_tests.exe" > "%ARCHIVE%logs\test.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
exit /b 0