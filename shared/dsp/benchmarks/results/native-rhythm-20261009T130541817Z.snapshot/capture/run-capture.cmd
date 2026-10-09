@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" amd64 -vcvars_ver=14.29
if errorlevel 1 exit /b %errorlevel%
cl /Bv > "C:\Users\user1000\AppData\Local\Temp\webrc-rhythm-capture-20261009T130541817Z\compiler-version.txt" 2>&1
cmake -S "C:\Users\user1000\AppData\Local\Temp\webrc-rhythm-capture-20261009T130541817Z" -B "C:\Users\user1000\AppData\Local\Temp\webrc-rhythm-capture-20261009T130541817Z\build" -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
if errorlevel 1 exit /b %errorlevel%
cmake --build "C:\Users\user1000\AppData\Local\Temp\webrc-rhythm-capture-20261009T130541817Z\build" --target rhythm_tests native_rhythm_bench --config Release
if errorlevel 1 exit /b %errorlevel%
ctest --test-dir "C:\Users\user1000\AppData\Local\Temp\webrc-rhythm-capture-20261009T130541817Z\build" --output-on-failure > "C:\Users\user1000\AppData\Local\Temp\webrc-rhythm-capture-20261009T130541817Z\ctest-output.txt" 2>&1
if errorlevel 1 exit /b %errorlevel%
set "WEBRC_RHYTHM_BENCH_JSON=C:\Users\user1000\AppData\Local\Temp\webrc-rhythm-capture-20261009T130541817Z\rhythm-bench.json"
"C:\Users\user1000\AppData\Local\Temp\webrc-rhythm-capture-20261009T130541817Z\build\native_rhythm_bench.exe"
if errorlevel 1 exit /b %errorlevel%
exit /b 0
