@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" amd64 -vcvars_ver=14.29
if errorlevel 1 exit /b %errorlevel%
"C:\Program Files\CMake\bin\cmake.exe" -S "D:\Documents\Codes\2024_1_WebRC505MKII\2025_WebRC505MKII_v2\bench\results\native-fx-reclaim-serial-warmup-20261009T180047Z\source-snapshot" -B "C:\Users\user1000\AppData\Local\Temp\webrc-native-serial-warmup-20261009T180047Z" -G "NMake Makefiles" -DCMAKE_MAKE_PROGRAM="C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\bin\Hostx64\x64\nmake.exe" -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
if errorlevel 1 exit /b %errorlevel%
"C:\Program Files\CMake\bin\cmake.exe" --build "C:\Users\user1000\AppData\Local\Temp\webrc-native-serial-warmup-20261009T180047Z" --target native_fx_graph_tests native_track_host_tests native_multitrack_core_tests
if errorlevel 1 exit /b %errorlevel%
"C:\Program Files\CMake\bin\ctest.exe" --test-dir "C:\Users\user1000\AppData\Local\Temp\webrc-native-serial-warmup-20261009T180047Z" --output-on-failure
exit /b %errorlevel%
