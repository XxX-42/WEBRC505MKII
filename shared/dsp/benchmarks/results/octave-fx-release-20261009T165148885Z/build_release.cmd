@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 90
cd /d "%~dp0source"
if errorlevel 1 exit /b 91
cl /Bv /? > build\compiler_version.txt 2>&1
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c src\primitives.cpp /Fo"build\primitives.obj" > "build\primitives.compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c src\fft.cpp /Fo"build\fft.obj" > "build\fft.compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c src\pitch.cpp /Fo"build\pitch.obj" > "build\pitch.compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c src\octave_fx.cpp /Fo"build\octave_fx.obj" > "build\octave_fx.compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c tests\octave_fx_tests.cpp /Fo"build\octave_fx_tests.obj" > build\tests.compile.log 2>&1
if errorlevel 1 exit /b %errorlevel%
link /nologo /out:build\octave_fx_tests.exe build\primitives.obj build\fft.obj build\pitch.obj build\octave_fx.obj build\octave_fx_tests.obj > build\link.log 2>&1
if errorlevel 1 exit /b %errorlevel%
build\octave_fx_tests.exe > build\test.log 2>&1
exit /b %errorlevel%
