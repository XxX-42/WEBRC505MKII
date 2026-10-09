@echo off
setlocal
set "ARCHIVE=%~dp0"
set "SOURCE=%ARCHIVE%upstream-source"
set "OUTPUT=%ARCHIVE%build"
set "RESULTS=%ARCHIVE%results"
set "DATA=%ARCHIVE%data"
set "TOOLS=C:\Users\user1000\AppData\Local\Temp\webrc-rubberband-tools-a8df618f854b42dcb24f590ed3661a84"
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" amd64 -vcvars_ver=14.29 > "%OUTPUT%\vcvars.log" 2>&1
if errorlevel 1 exit /b 10
set "PATH=%TOOLS%\bin;%PATH%"
set "PYTHONPATH=%TOOLS%;%PYTHONPATH%"
cd /d "%OUTPUT%"
cl /Bv > compiler-version.log 2>&1
"%TOOLS%\bin\meson.exe" setup "%OUTPUT%\upstream" "%SOURCE%" --buildtype=release -Dtests=disabled -Dcmdline=disabled -Djni=disabled -Dladspa=disabled -Dlv2=disabled -Dvamp=disabled -Ddefault_library=static -Dfft=builtin -Dresampler=builtin -Db_vscrt=md > meson-setup.log 2>&1
if errorlevel 1 exit /b 12
"%TOOLS%\bin\meson.exe" compile --verbose -C "%OUTPUT%\upstream" > upstream-build.log 2>&1
if errorlevel 1 exit /b 13
if not exist "%OUTPUT%\upstream\rubberband-static.lib" exit /b 14
cl /nologo /std:c++17 /O2 /EHsc /MD /D RUBBERBAND_STATIC /I"%SOURCE%\rubberband" /c "%ARCHIVE%eval-src\rubberband_r2r3_eval.cpp" /Fo"%OUTPUT%\rubberband_r2r3_eval.obj" > harness-build.log 2>&1
if errorlevel 1 exit /b 15
link /nologo /OUT:"%OUTPUT%\rubberband_r2r3_eval.exe" /SUBSYSTEM:CONSOLE /MACHINE:X64 "%OUTPUT%\rubberband_r2r3_eval.obj" "%OUTPUT%\upstream\rubberband-static.lib" > harness-link.log 2>&1
if errorlevel 1 exit /b 16
"%OUTPUT%\rubberband_r2r3_eval.exe" "%DATA%" "%RESULTS%" > "%OUTPUT%\evaluator-stdout.log" 2> "%OUTPUT%\evaluator-stderr.log"
exit /b %ERRORLEVEL%
