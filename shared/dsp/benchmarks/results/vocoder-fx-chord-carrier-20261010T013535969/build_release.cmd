@echo off
setlocal
set "ROOT=%~dp0source"
set "OUT=%~dp0build"
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" > "%OUT%\vcvars.log" 2>&1
if errorlevel 1 exit /b 10
cl /Bv /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\tests\vocoder_fx_tests.cpp" /Fo"%OUT%\compiler_probe.obj" > "%OUT%\compiler-version.txt" 2>&1
if errorlevel 1 exit /b 11
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\vocoder_fx.cpp" /Fo"%OUT%\vocoder_fx.obj" > "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 12
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\pitch.cpp" /Fo"%OUT%\pitch.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 13
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\primitives.cpp" /Fo"%OUT%\primitives.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 14
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\fft.cpp" /Fo"%OUT%\fft.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 15
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\tests\vocoder_fx_tests.cpp" /Fo"%OUT%\vocoder_fx_tests.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 16
link /nologo /OUT:"%OUT%\vocoder_fx_tests.exe" "%OUT%\vocoder_fx.obj" "%OUT%\pitch.obj" "%OUT%\primitives.obj" "%OUT%\fft.obj" "%OUT%\vocoder_fx_tests.obj" >> "%OUT%\build.log" 2>&1
if errorlevel 1 exit /b 17
"%OUT%\vocoder_fx_tests.exe" > "%OUT%\test-output.json" 2> "%OUT%\test-stderr.txt"
if errorlevel 1 exit /b 18
exit /b 0
