@echo off
setlocal
set "ROOT=%~dp0source"
set "OUT=%~dp0build"
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" > "%OUT%\vcvars.log" 2>&1
if errorlevel 1 exit /b 10
set "CFLAGS=/nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /bigobj /I%ROOT%\shared\dsp\include"
cl /Bv %CFLAGS% /c "%ROOT%\shared\dsp\tests\musical_fx_adapter_tests.cpp" /Fo"%OUT%\compiler_probe.obj" > "%OUT%\compiler-version.log" 2>&1
if errorlevel 1 exit /b 11
for %%S in (primitives fft pitch streaming_yin control_dynamics voice_fx synthesis_pitch_fx vocoder_fx musical_fx_adapter) do (
  cl %CFLAGS% /c "%ROOT%\shared\dsp\src\%%S.cpp" /Fo"%OUT%\%%S.obj" > "%OUT%\%%S-compile.log" 2>&1
  if errorlevel 1 exit /b 20
)
cl %CFLAGS% /c "%ROOT%\shared\dsp\tests\musical_fx_adapter_tests.cpp" /Fo"%OUT%\musical_fx_adapter_tests.obj" > "%OUT%\musical_fx_adapter_tests-compile.log" 2>&1
if errorlevel 1 exit /b 21
cl /nologo /std:c++17 /O2 /EHs-c- /D_HAS_EXCEPTIONS=0 /W4 /permissive- /fp:precise /bigobj /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\musical_fx_adapter.cpp" /Fo"%OUT%\musical_fx_adapter_noexceptions.obj" > "%OUT%\musical_fx_adapter-noexceptions-compile.log" 2>&1
if errorlevel 1 exit /b 22
link /nologo /OUT:"%OUT%\musical_fx_adapter_tests.exe" "%OUT%\musical_fx_adapter_tests.obj" "%OUT%\musical_fx_adapter.obj" "%OUT%\synthesis_pitch_fx.obj" "%OUT%\voice_fx.obj" "%OUT%\vocoder_fx.obj" "%OUT%\streaming_yin.obj" "%OUT%\pitch.obj" "%OUT%\control_dynamics.obj" "%OUT%\fft.obj" "%OUT%\primitives.obj" > "%OUT%\link.log" 2>&1
if errorlevel 1 exit /b 23
"%OUT%\musical_fx_adapter_tests.exe" > "%OUT%\test-output.log" 2> "%OUT%\test-stderr.log"
if errorlevel 1 exit /b 24
exit /b 0
