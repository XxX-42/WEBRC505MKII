@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 90
cd /d "%~dp0source"
if errorlevel 1 exit /b 91
cl /Bv /? > build\compiler_version.txt 2>&1
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c src\primitives.cpp /Fo"build\primitives.obj" > "build\primitives.compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c src\nonlinear.cpp /Fo"build\nonlinear.obj" > "build\nonlinear.compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c src\performance_fx.cpp /Fo"build\performance_fx.obj" > "build\performance_fx.compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c src\fft.cpp /Fo"build\fft.obj" > "build\fft.compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c src\spatial_temporal.cpp /Fo"build\spatial_temporal.obj" > "build\spatial_temporal.compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c src\temporal_fx_adapters.cpp /Fo"build\temporal_fx_adapters.obj" > "build\temporal_fx_adapters.compile.log" 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /EHsc /O2 /W4 /permissive- /Iinclude /c tests\temporal_fx_adapters_tests.cpp /Fo"build\temporal_fx_adapters_tests.obj" > build\tests.compile.log 2>&1
if errorlevel 1 exit /b %errorlevel%
link /nologo /out:build\temporal_fx_adapters_tests.exe build\primitives.obj build\nonlinear.obj build\performance_fx.obj build\fft.obj build\spatial_temporal.obj build\temporal_fx_adapters.obj build\temporal_fx_adapters_tests.obj > build\link.log 2>&1
if errorlevel 1 exit /b %errorlevel%
build\temporal_fx_adapters_tests.exe > build\test.log 2>&1
exit /b %errorlevel%
