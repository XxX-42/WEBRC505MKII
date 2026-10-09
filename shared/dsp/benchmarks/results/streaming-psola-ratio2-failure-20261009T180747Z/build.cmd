@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b %errorlevel%
cd /d "%~dp0"
if errorlevel 1 exit /b %errorlevel%
cl /Bv > build\compiler_version.txt 2>&1
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I source\include /c source\pitch_ratio_2_failure_repro.cpp /Fobuild\repro.obj > build\compile.log 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I source\include /c source\src\pitch.cpp /Fobuild\pitch.obj >> build\compile.log 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I source\include /c source\src\primitives.cpp /Fobuild\primitives.obj >> build\compile.log 2>&1
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /fp:precise /I source\include /c source\src\fft.cpp /Fobuild\fft.obj >> build\compile.log 2>&1
if errorlevel 1 exit /b %errorlevel%
link /nologo /OUT:build\psola_ratio2_repro.exe build\repro.obj build\pitch.obj build\primitives.obj build\fft.obj > build\link.log 2>&1
if errorlevel 1 exit /b %errorlevel%
build\psola_ratio2_repro.exe > build\run.log 2>&1
if errorlevel 1 exit /b %errorlevel%
exit /b 0
