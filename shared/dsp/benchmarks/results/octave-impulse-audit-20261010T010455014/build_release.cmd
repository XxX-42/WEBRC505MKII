@echo off
setlocal
set "ROOT=%~dp0source"
set "OUT=%~dp0build"
if not exist "%OUT%" mkdir "%OUT%"
cd /d "%ROOT%"
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" > "%OUT%\vcvars.log" 2>&1
if errorlevel 1 exit /b 10
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\octave_fx_probe.cpp" /Fo"%OUT%\octave_fx_probe.obj" > "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 11
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\pitch.cpp" /Fo"%OUT%\pitch.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 12
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\fft.cpp" /Fo"%OUT%\fft.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 13
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\primitives.cpp" /Fo"%OUT%\primitives.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 14
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\benchmarks\octave_impulse_audit.cpp" /Fo"%OUT%\octave_impulse_audit.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 15
cl /nologo /EHsc /Fe"%OUT%\octave_impulse_audit.exe" "%OUT%\octave_fx_probe.obj" "%OUT%\pitch.obj" "%OUT%\fft.obj" "%OUT%\primitives.obj" "%OUT%\octave_impulse_audit.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 16
"%OUT%\octave_impulse_audit.exe" > "%OUT%\audit.json" 2> "%OUT%\test-stderr.txt"
if errorlevel 1 exit /b 17
exit /b 0
