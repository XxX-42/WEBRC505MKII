@echo off
setlocal
set "CAPTURE_ROOT=%~dp0"
set "SOURCE_ROOT=%CAPTURE_ROOT%source"
set "BUILD_ROOT=%CAPTURE_ROOT%build"
set "LOG_ROOT=%CAPTURE_ROOT%logs"
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" > "%LOG_ROOT%\vcvars.log" 2>&1
if errorlevel 1 exit /b 1
pushd "%SOURCE_ROOT%"
if errorlevel 1 exit /b 1
set "CFLAGS=/nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I shared\dsp\include"
cl /Bv %CFLAGS% /FAs /Fa"%BUILD_ROOT%\voice_fx.asm" /c shared\dsp\src\voice_fx.cpp /Fo"%BUILD_ROOT%\voice_fx.obj" > "%LOG_ROOT%\voice_fx-compile.log" 2>&1
if errorlevel 1 exit /b 1
cl %CFLAGS% /FAs /Fa"%BUILD_ROOT%\vocoder_fx.asm" /c shared\dsp\src\vocoder_fx.cpp /Fo"%BUILD_ROOT%\vocoder_fx.obj" > "%LOG_ROOT%\vocoder_fx-compile.log" 2>&1
if errorlevel 1 exit /b 1
cl %CFLAGS% /c shared\dsp\src\pitch.cpp /Fo"%BUILD_ROOT%\pitch.obj" > "%LOG_ROOT%\pitch-compile.log" 2>&1
if errorlevel 1 exit /b 1
cl %CFLAGS% /c shared\dsp\src\streaming_yin.cpp /Fo"%BUILD_ROOT%\streaming_yin.obj" > "%LOG_ROOT%\streaming_yin-compile.log" 2>&1
if errorlevel 1 exit /b 1
cl %CFLAGS% /c shared\dsp\src\primitives.cpp /Fo"%BUILD_ROOT%\primitives.obj" > "%LOG_ROOT%\primitives-compile.log" 2>&1
if errorlevel 1 exit /b 1
cl %CFLAGS% /c shared\dsp\src\fft.cpp /Fo"%BUILD_ROOT%\fft.obj" > "%LOG_ROOT%\fft-compile.log" 2>&1
if errorlevel 1 exit /b 1
cl %CFLAGS% /c shared\dsp\src\control_dynamics.cpp /Fo"%BUILD_ROOT%\control_dynamics.obj" > "%LOG_ROOT%\control_dynamics-compile.log" 2>&1
if errorlevel 1 exit /b 1
cl %CFLAGS% /FAs /Fa"%BUILD_ROOT%\voice_fx_tests.asm" /c shared\dsp\tests\voice_fx_tests.cpp /Fo"%BUILD_ROOT%\voice_fx_tests.obj" > "%LOG_ROOT%\voice_fx_tests-compile.log" 2>&1
if errorlevel 1 exit /b 1
cl %CFLAGS% /c shared\dsp\tests\vocoder_fx_tests.cpp /Fo"%BUILD_ROOT%\vocoder_fx_tests.obj" > "%LOG_ROOT%\vocoder_fx_tests-compile.log" 2>&1
if errorlevel 1 exit /b 1
link /nologo /OUT:"%BUILD_ROOT%\voice_fx_tests.exe" "%BUILD_ROOT%\voice_fx_tests.obj" "%BUILD_ROOT%\voice_fx.obj" "%BUILD_ROOT%\streaming_yin.obj" "%BUILD_ROOT%\pitch.obj" "%BUILD_ROOT%\primitives.obj" "%BUILD_ROOT%\fft.obj" > "%LOG_ROOT%\voice_fx-link.log" 2>&1
if errorlevel 1 exit /b 1
link /nologo /OUT:"%BUILD_ROOT%\vocoder_fx_tests.exe" "%BUILD_ROOT%\vocoder_fx_tests.obj" "%BUILD_ROOT%\vocoder_fx.obj" "%BUILD_ROOT%\control_dynamics.obj" "%BUILD_ROOT%\pitch.obj" "%BUILD_ROOT%\primitives.obj" "%BUILD_ROOT%\fft.obj" > "%LOG_ROOT%\vocoder_fx-link.log" 2>&1
if errorlevel 1 exit /b 1
"%BUILD_ROOT%\voice_fx_tests.exe" > "%LOG_ROOT%\voice_fx-tests.log" 2>&1
if errorlevel 1 exit /b 1
"%BUILD_ROOT%\vocoder_fx_tests.exe" > "%LOG_ROOT%\vocoder_fx-tests.log" 2>&1
if errorlevel 1 exit /b 1
popd
exit /b 0
