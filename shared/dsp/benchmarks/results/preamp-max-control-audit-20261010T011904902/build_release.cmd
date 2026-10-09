@echo off
setlocal
set "ROOT=%~dp0source"
set "OUT=%~dp0build"
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" > "%OUT%\vcvars.log" 2>&1
if errorlevel 1 exit /b 10
cl /Bv /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /c "%ROOT%\compiler_probe.cpp" /Fo"%OUT%\compiler_probe.obj" > "%OUT%\compiler-version.txt" 2>&1
if errorlevel 1 exit /b 11
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\preamp_fx.cpp" /Fo"%OUT%\preamp_fx.obj" > "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 12
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\nonlinear.cpp" /Fo"%OUT%\nonlinear.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 13
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\spatial_temporal.cpp" /Fo"%OUT%\spatial_temporal.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 14
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\fft.cpp" /Fo"%OUT%\fft.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 15
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\primitives.cpp" /Fo"%OUT%\primitives.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 16
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\benchmark\preamp_max_control_audit.cpp" /Fo"%OUT%\preamp_max_control_audit.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 17
link /nologo /OUT:"%OUT%\preamp_max_control_audit.exe" "%OUT%\preamp_fx.obj" "%OUT%\nonlinear.obj" "%OUT%\spatial_temporal.obj" "%OUT%\fft.obj" "%OUT%\primitives.obj" "%OUT%\preamp_max_control_audit.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 18
"%OUT%\preamp_max_control_audit.exe" > "%OUT%\audit.json" 2> "%OUT%\audit.stderr.txt"
if errorlevel 1 exit /b 19
exit /b 0
