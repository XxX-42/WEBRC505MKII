@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" amd64 -vcvars_ver=14.29
if errorlevel 1 exit /b %errorlevel%
"C:\Program Files\CMake\bin\cmake.exe" "-S" "C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-parity-v21-snapshot-r6-20261009\shared\dsp" "-B" "C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-parity-v21-build-r6-20261009" "-G" "NMake Makefiles" "-DCMAKE_MAKE_PROGRAM=C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\bin\Hostx64\x64\nmake.exe" "-DCMAKE_BUILD_TYPE=Release" >"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-parity-v21-build-r6-20261009\configure.stdout.log" 2>"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-parity-v21-build-r6-20261009\configure.stderr.log"
if errorlevel 1 exit /b %errorlevel%
"C:\Program Files\CMake\bin\cmake.exe" "--build" "C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-parity-v21-build-r6-20261009" "--target" "dsp_primitives_tests" "control_dynamics_tests" "nonlinear_tests" "spatial_temporal_tests" "pitch_tests" "fx_registry_tests" "native_dsp_parity_v21_generator" >"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-parity-v21-build-r6-20261009\build.stdout.log" 2>"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-parity-v21-build-r6-20261009\build.stderr.log"
if errorlevel 1 exit /b %errorlevel%
"C:\Program Files\CMake\bin\ctest.exe" "--test-dir" "C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-parity-v21-build-r6-20261009" "--output-on-failure" "-R" "^(dsp_primitives_tests|control_dynamics_tests|nonlinear_tests|spatial_temporal_tests|pitch_tests|fx_registry_tests)$" >"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-parity-v21-build-r6-20261009\ctest.stdout.log" 2>"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-parity-v21-build-r6-20261009\ctest.stderr.log"
if errorlevel 1 exit /b %errorlevel%
"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-parity-v21-build-r6-20261009\native_dsp_parity_v21_generator.exe" "C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-parity-v21-build-r6-20261009\generated" >"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-parity-v21-build-r6-20261009\generator.stdout.log" 2>"C:\Users\user1000\AppData\Local\Temp\webrc-native-dsp-parity-v21-build-r6-20261009\generator.stderr.log"
if errorlevel 1 exit /b %errorlevel%
exit /b 0
