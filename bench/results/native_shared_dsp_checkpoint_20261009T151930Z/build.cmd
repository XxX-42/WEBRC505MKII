@call D:\Applications\VisualStudio\VC\Auxiliary\Build\vcvarsall.bat x64 >nul
@if errorlevel 1 exit /b %errorlevel%
@cmake --build "C:\Users\user1000\AppData\Local\Temp\webrc-native-stable17-snapshot-r2-20261009\build"
@exit /b %errorlevel%
