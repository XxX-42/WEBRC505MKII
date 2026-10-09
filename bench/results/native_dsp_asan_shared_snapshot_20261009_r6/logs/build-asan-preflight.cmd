@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" amd64 -vcvars_ver=14.29
if errorlevel 1 exit /b %errorlevel%
set "PATH=C:\Users\user1000\AppData\Local\Temp\llvm-23.1.3-asan-probe\clang+llvm-23.1.3-x86_64-pc-windows-msvc\bin;C:\Users\user1000\AppData\Local\Temp\llvm-23.1.3-asan-probe\clang+llvm-23.1.3-x86_64-pc-windows-msvc\lib\clang\23\lib\windows;%PATH%"
echo Building a small AddressSanitizer runtime preflight.
"C:\Users\user1000\AppData\Local\Temp\llvm-23.1.3-asan-probe\clang+llvm-23.1.3-x86_64-pc-windows-msvc\bin\clang-cl.exe" /nologo /fsanitize=address /Zi /EHsc /MD "C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-asan-registry-r6-20261009\asan_runtime_preflight.cpp" /Fo"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-asan-registry-r6-20261009\asan_runtime_preflight.obj" /Fd"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-asan-registry-r6-20261009\asan_runtime_preflight.pdb" /link /DEBUG /OUT:"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-asan-registry-r6-20261009\asan_runtime_preflight.exe" >"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-asan-registry-r6-20261009\asan-preflight-build.stdout.log" 2>"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-asan-registry-r6-20261009\asan-preflight-build.stderr.log"
if errorlevel 1 exit /b %errorlevel%
