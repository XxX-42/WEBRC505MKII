@echo off
setlocal
set "ROOT=%~dp0source"
set "OUT=%~dp0build"
if not exist "%OUT%" mkdir "%OUT%"
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" > "%OUT%\vcvars.log" 2>&1
if errorlevel 1 exit /b 10
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\preamp_fx.cpp" /Fo"%OUT%\preamp_fx.obj"
if errorlevel 1 exit /b 11
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\nonlinear.cpp" /Fo"%OUT%\nonlinear.obj"
if errorlevel 1 exit /b 12
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\spatial_temporal.cpp" /Fo"%OUT%\spatial_temporal.obj"
if errorlevel 1 exit /b 13
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\fft.cpp" /Fo"%OUT%\fft.obj"
if errorlevel 1 exit /b 14
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\primitives.cpp" /Fo"%OUT%\primitives.obj"
if errorlevel 1 exit /b 15
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\tests\preamp_fx_tests.cpp" /Fo"%OUT%\preamp_fx_tests.obj"
if errorlevel 1 exit /b 16
cl /nologo /EHsc /Fe"%OUT%\preamp_fx_tests.exe" "%OUT%\preamp_fx.obj" "%OUT%\nonlinear.obj" "%OUT%\spatial_temporal.obj" "%OUT%\fft.obj" "%OUT%\primitives.obj" "%OUT%\preamp_fx_tests.obj"
if errorlevel 1 exit /b 17
"%OUT%\preamp_fx_tests.exe" > "%OUT%\test-output.json"
if errorlevel 1 exit /b 18
exit /b 0
