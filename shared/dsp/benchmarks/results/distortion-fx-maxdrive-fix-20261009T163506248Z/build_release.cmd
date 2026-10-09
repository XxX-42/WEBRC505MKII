@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 90
cd /d "%~dp0source"
if errorlevel 1 exit /b 91
cl /Bv /? > build\compiler_version.txt 2>&1
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c src/primitives.cpp /Fo"build\primitives.obj" > "build\primitives.compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c src/nonlinear.cpp /Fo"build\nonlinear.obj" > "build\nonlinear.compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c src/distortion_fx.cpp /Fo"build\distortion_fx.obj" > "build\distortion_fx.compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c tests/distortion_fx_tests.cpp /Fo"build\distortion_fx_tests.obj" > "build\tests.compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
link /nologo /out:build\distortion_fx_tests.exe build\primitives.obj build\nonlinear.obj build\distortion_fx.obj build\distortion_fx_tests.obj > build\link.log 2>&1
if errorlevel 1 exit /b %errorlevel%
build\distortion_fx_tests.exe > build\test.log 2>&1
exit /b %errorlevel%
