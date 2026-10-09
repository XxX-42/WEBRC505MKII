@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" amd64 -vcvars_ver=14.29
if errorlevel 1 exit /b %errorlevel%
cd /d "D:\Documents\Codes\2024_1_WebRC505MKII\2025_WebRC505MKII_v2\bench\results\native-streaming-psola-ratio-fix-20261009T182425Z\verification"
cl.exe /nologo /std:c++17 /EHsc /O2 /MD /I"D:\Documents\Codes\2024_1_WebRC505MKII\2025_WebRC505MKII_v2\bench\results\native-streaming-psola-ratio-fix-20261009T182425Z\source-snapshot\shared\dsp\include" ratio-diagnostic.cpp "C:\Users\user1000\AppData\Local\Temp\webrc-native-psola-ratio-fix-20261009T182425Z\shared_dsp\webrc_dsp.lib" /Fe:ratio-diagnostic.exe
if errorlevel 1 exit /b %errorlevel%
ratio-diagnostic.exe > ratio-diagnostic.json
if errorlevel 1 exit /b %errorlevel%
