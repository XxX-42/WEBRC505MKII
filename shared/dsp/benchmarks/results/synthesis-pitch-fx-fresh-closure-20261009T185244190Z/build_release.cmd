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
cl /Bv %CFLAGS% /c compiler_probe.cpp /Fo"%BUILD_ROOT%\compiler_probe.obj" > "%LOG_ROOT%\compiler-version.log" 2>&1
if errorlevel 1 exit /b 1
for %%S in (synthesis_pitch_fx voice_fx pitch streaming_yin control_dynamics primitives fft) do (
  cl %CFLAGS% /c shared\dsp\src\%%S.cpp /Fo"%BUILD_ROOT%\%%S.obj" > "%LOG_ROOT%\%%S-compile.log" 2>&1
  if errorlevel 1 exit /b 1
)
cl %CFLAGS% /c shared\dsp\tests\synthesis_pitch_fx_tests.cpp /Fo"%BUILD_ROOT%\synthesis_pitch_fx_tests.obj" > "%LOG_ROOT%\synthesis_pitch_fx_tests-compile.log" 2>&1
if errorlevel 1 exit /b 1
link /nologo /OUT:"%BUILD_ROOT%\synthesis_pitch_fx_tests.exe" "%BUILD_ROOT%\synthesis_pitch_fx_tests.obj" "%BUILD_ROOT%\synthesis_pitch_fx.obj" "%BUILD_ROOT%\voice_fx.obj" "%BUILD_ROOT%\pitch.obj" "%BUILD_ROOT%\streaming_yin.obj" "%BUILD_ROOT%\control_dynamics.obj" "%BUILD_ROOT%\primitives.obj" "%BUILD_ROOT%\fft.obj" > "%LOG_ROOT%\link.log" 2>&1
if errorlevel 1 exit /b 1
"%BUILD_ROOT%\synthesis_pitch_fx_tests.exe" > "%LOG_ROOT%\test-output.log" 2> "%LOG_ROOT%\test-stderr.log"
if errorlevel 1 exit /b 1
popd
exit /b 0
