@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" amd64 -vcvars_ver=14.29
if errorlevel 1 exit /b %errorlevel%
set "PATH=C:\Users\user1000\AppData\Local\Temp\llvm-23.1.3-asan-probe\clang+llvm-23.1.3-x86_64-pc-windows-msvc\bin;C:\Users\user1000\AppData\Local\Temp\llvm-23.1.3-asan-probe\clang+llvm-23.1.3-x86_64-pc-windows-msvc\lib\clang\23\lib\windows;%PATH%"
echo Running the AddressSanitizer runtime preflight with a bounded parent timeout.
"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-asan-r7-20261009\asan_runtime_preflight.exe"
set "_webrc_preflight_exit=%errorlevel%"
>"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-asan-r7-20261009\asan-preflight.exitcode.txt" echo %_webrc_preflight_exit%
exit /b %_webrc_preflight_exit%
