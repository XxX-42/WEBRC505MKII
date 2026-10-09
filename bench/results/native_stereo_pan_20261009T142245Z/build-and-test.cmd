@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" amd64
if errorlevel 1 exit /b %errorlevel%
set "ROOT=%~dp0"
set "SRC=%ROOT%source-snapshot"
set "OUT=%ROOT%out"
if not exist "%OUT%" mkdir "%OUT%"
pushd "%OUT%"
cl /nologo /EHsc /std:c++17 /O2 /W4 /I"%SRC%\native-mvp\engine-cpp\include" /I"%SRC%\shared\dsp\include" "%SRC%\native-mvp\engine-cpp\src\multitrack_looper_core.cpp" "%SRC%\native-mvp\engine-cpp\tests\multitrack_looper_core_tests.cpp" "%SRC%\shared\dsp\src\primitives.cpp" "%SRC%\shared\dsp\src\control_dynamics.cpp" /Fe"%OUT%\multitrack_looper_core_tests.exe"
if errorlevel 1 exit /b %errorlevel%
cl /nologo /EHsc /std:c++17 /O2 /W4 /I"%SRC%\native-mvp\engine-cpp\include" /I"%SRC%\shared\dsp\include" "%SRC%\native-mvp\engine-cpp\src\multitrack_looper_core.cpp" "%SRC%\native-mvp\engine-cpp\src\native_track_host.cpp" "%SRC%\native-mvp\engine-cpp\tests\native_track_host_tests.cpp" "%SRC%\shared\dsp\src\primitives.cpp" "%SRC%\shared\dsp\src\control_dynamics.cpp" /Fe"%OUT%\native_track_host_tests.exe"
if errorlevel 1 exit /b %errorlevel%
"%OUT%\multitrack_looper_core_tests.exe"
if errorlevel 1 exit /b %errorlevel%
echo PASS multitrack_looper_core_tests
"%OUT%\native_track_host_tests.exe"
if errorlevel 1 exit /b %errorlevel%
echo PASS native_track_host_tests
popd
exit /b 0
