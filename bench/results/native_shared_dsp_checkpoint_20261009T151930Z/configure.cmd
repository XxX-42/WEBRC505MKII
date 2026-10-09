@call D:\Applications\VisualStudio\VC\Auxiliary\Build\vcvarsall.bat x64 >nul
@if errorlevel 1 exit /b %errorlevel%
@cmake -S "C:\Users\user1000\AppData\Local\Temp\webrc-native-stable17-snapshot-r2-20261009\repo\shared\dsp" -B "C:\Users\user1000\AppData\Local\Temp\webrc-native-stable17-snapshot-r2-20261009\build" -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
@exit /b %errorlevel%
