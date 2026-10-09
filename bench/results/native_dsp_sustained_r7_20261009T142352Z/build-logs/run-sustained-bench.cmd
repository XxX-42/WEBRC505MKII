@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" amd64 -vcvars_ver=14.29
if errorlevel 1 exit /b %errorlevel%
"C:\Program Files\CMake\bin\cmake.exe" "-S" "C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-sustained-r7_20261009T142352Z\repo-snapshot\shared\dsp" "-B" "C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-sustained-r7_20261009T142352Z\build" "-G" "NMake Makefiles" "-DCMAKE_MAKE_PROGRAM=C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\bin\Hostx64\x64\nmake.exe" "-DCMAKE_BUILD_TYPE=Release" >"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-sustained-r7_20261009T142352Z\build\configure.stdout.log" 2>"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-sustained-r7_20261009T142352Z\build\configure.stderr.log"
if errorlevel 1 exit /b %errorlevel%
"C:\Program Files\CMake\bin\cmake.exe" "--build" "C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-sustained-r7_20261009T142352Z\build" "--target" "native_dsp_sustained_bench" >"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-sustained-r7_20261009T142352Z\build\build.stdout.log" 2>"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-sustained-r7_20261009T142352Z\build\build.stderr.log"
if errorlevel 1 exit /b %errorlevel%
set "WEBRC_DSP_SUSTAINED_JSON=C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-sustained-r7_20261009T142352Z\build\native_dsp_sustained_3f498678cb4a4c12951b2b44be3ff653.json"
set "WEBRC_DSP_SOURCE_REV=unavailable-no-git-metadata"
set "WEBRC_DSP_SOURCE_HASH=e11491528046825cfed5e9932742f5b75ab7e7f08d80b1ebdacea69545350ba4"
set "WEBRC_DSP_BUILD_FLAGS=MSVC 14.29.30133 Release /O2 /Ob2 /DNDEBUG /MD /std:c++17; default precise floating point; no /fp:fast"
set "WEBRC_DSP_CPU=AMD Ryzen 9 5900HX with Radeon Graphics"
set "WEBRC_DSP_OS=Microsoft Windows 10.0.26200 "
"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-sustained-r7_20261009T142352Z\build\native_dsp_sustained_bench.exe" >"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-sustained-r7_20261009T142352Z\build\run.stdout.log" 2>"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-sustained-r7_20261009T142352Z\build\run.stderr.log"
if errorlevel 1 exit /b %errorlevel%
exit /b 0
