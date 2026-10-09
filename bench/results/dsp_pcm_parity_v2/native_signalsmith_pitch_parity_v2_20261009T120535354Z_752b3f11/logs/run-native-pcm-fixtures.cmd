@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" amd64 -vcvars_ver=14.29
if errorlevel 1 exit /b %errorlevel%
"C:\Program Files\CMake\bin\cmake.exe" "-S" "D:\Documents\Codes\2024_1_WebRC505MKII\2025_WebRC505MKII_v2\shared\dsp" "-B" "C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-pcm-r5-20261009" "-G" "NMake Makefiles" "-DCMAKE_MAKE_PROGRAM=C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\bin\Hostx64\x64\nmake.exe" "-DCMAKE_BUILD_TYPE=Release" >"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-pcm-r5-20261009\cmake-configure.stdout.log" 2>"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-pcm-r5-20261009\cmake-configure.stderr.log"
if errorlevel 1 exit /b %errorlevel%
"C:\Program Files\CMake\bin\cmake.exe" "--build" "C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-pcm-r5-20261009" "--target" "dsp_primitives_tests" "control_dynamics_tests" "nonlinear_tests" "spatial_temporal_tests" "pitch_tests" "native_dsp_pcm_fixture_generator" >"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-pcm-r5-20261009\cmake-build.stdout.log" 2>"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-pcm-r5-20261009\cmake-build.stderr.log"
if errorlevel 1 exit /b %errorlevel%
"C:\Program Files\CMake\bin\ctest.exe" "--test-dir" "C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-pcm-r5-20261009" "--output-on-failure" "-R" "^(dsp_primitives_tests|control_dynamics_tests|nonlinear_tests|spatial_temporal_tests|pitch_tests)$" >"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-pcm-r5-20261009\ctest.stdout.log" 2>"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-pcm-r5-20261009\ctest.stderr.log"
if errorlevel 1 exit /b %errorlevel%
"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-pcm-r5-20261009\native_dsp_pcm_fixture_generator.exe" "C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-pcm-r5-20261009\generated-fixtures" >"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-pcm-r5-20261009\fixture-generator.stdout.log" 2>"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-pcm-r5-20261009\fixture-generator.stderr.log"
if errorlevel 1 exit /b %errorlevel%
exit /b 0
