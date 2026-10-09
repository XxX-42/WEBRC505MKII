@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64 -vcvars_ver=14.29
if errorlevel 1 exit /b %errorlevel%
cl /nologo /O2 /Ob2 /DNDEBUG /MD /EHsc /std:c++17 /showIncludes /I"C:\Users\user1000\AppData\Local\Temp\webrc-root-config-preflight-20261010-r1/native-include" /I"C:\Users\user1000\AppData\Local\Temp\webrc-root-config-preflight-20261010-r1/dsp-include" /Fo"C:\Users\user1000\AppData\Local\Temp\webrc-root-config-preflight-20261010-r1/repro.obj" /Fe"C:\Users\user1000\AppData\Local\Temp\webrc-root-config-preflight-20261010-r1/repro.exe" "C:\Users\user1000\AppData\Local\Temp\webrc-root-config-preflight-20261010-r1\native-fx-config-preflight-root-repro.cpp" "C:\Users\user1000\AppData\Local\Temp\webrc-root-config-preflight-20261010-r1/native_track_host.lib" "C:\Users\user1000\AppData\Local\Temp\webrc-root-config-preflight-20261010-r1/native_multitrack_core.lib" "C:\Users\user1000\AppData\Local\Temp\webrc-root-config-preflight-20261010-r1/webrc_dsp.lib"
exit /b %errorlevel%
