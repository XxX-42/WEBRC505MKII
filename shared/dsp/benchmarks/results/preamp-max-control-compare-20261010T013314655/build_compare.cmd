@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" > "%~dp0compiler-env.log" 2>&1
if errorlevel 1 exit /b 10
call :build baseline
if errorlevel 1 exit /b 20
call :build corrected
if errorlevel 1 exit /b 30
exit /b 0
:build
set "NAME=%~1"
set "ROOT=%~dp0%NAME%\source"
set "OUT=%~dp0%NAME%\build"
cl /Bv /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\benchmark\preamp_max_control_compare.cpp" /Fo"%OUT%\compiler_probe.obj" > "%OUT%\compiler-version.txt" 2>&1
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\preamp_fx.cpp" /Fo"%OUT%\preamp_fx.obj" > "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 2
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\nonlinear.cpp" /Fo"%OUT%\nonlinear.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 3
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\spatial_temporal.cpp" /Fo"%OUT%\spatial_temporal.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 4
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\fft.cpp" /Fo"%OUT%\fft.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 5
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\primitives.cpp" /Fo"%OUT%\primitives.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 6
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\benchmark\preamp_max_control_compare.cpp" /Fo"%OUT%\preamp_max_control_compare.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 7
link /nologo /OUT:"%OUT%\preamp_max_control_compare.exe" "%OUT%\preamp_fx.obj" "%OUT%\nonlinear.obj" "%OUT%\spatial_temporal.obj" "%OUT%\fft.obj" "%OUT%\primitives.obj" "%OUT%\preamp_max_control_compare.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 8
"%OUT%\preamp_max_control_compare.exe" > "%OUT%\results.json" 2> "%OUT%\stderr.txt"
if errorlevel 1 exit /b 9
exit /b 0
