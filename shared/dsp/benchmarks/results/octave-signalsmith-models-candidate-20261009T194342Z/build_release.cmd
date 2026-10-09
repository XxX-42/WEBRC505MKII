@echo off
setlocal
set "ROOT=%~dp0source"
set "OUT=%~dp0build"
set "DATA=%~dp0data"
if not exist "%OUT%" mkdir "%OUT%"
if not exist "%DATA%" mkdir "%DATA%"
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" amd64 -vcvars_ver=14.29 > "%OUT%\vcvars.log" 2>&1
if errorlevel 1 exit /b 10
cd /d "%OUT%"
cl /Bv > compiler-version.log 2>&1
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /I"%ROOT%\third_party\signalsmith-stretch\include" /I"%ROOT%\third_party\signalsmith-linear\include" /c "%ROOT%\shared\dsp\src\octave_signalsmith_models.cpp" /Fo"%OUT%\octave_signalsmith_models.obj" > build.log 2>&1
if errorlevel 1 exit /b 11
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /I"%ROOT%\third_party\signalsmith-stretch\include" /I"%ROOT%\third_party\signalsmith-linear\include" /c "%ROOT%\shared\dsp\src\signalsmith_adapter.cpp" /Fo"%OUT%\signalsmith_adapter.obj" >> build.log 2>&1
if errorlevel 1 exit /b 12
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /c "%ROOT%\shared\dsp\src\primitives.cpp" /Fo"%OUT%\primitives.obj" >> build.log 2>&1
if errorlevel 1 exit /b 13
cl /nologo /std:c++17 /O2 /EHsc /W4 /permissive- /I"%ROOT%\shared\dsp\include" /I"%ROOT%\third_party\signalsmith-stretch\include" /I"%ROOT%\third_party\signalsmith-linear\include" /c "%ROOT%\shared\dsp\tests\octave_signalsmith_models_tests.cpp" /Fo"%OUT%\octave_signalsmith_models_tests.obj" >> build.log 2>&1
if errorlevel 1 exit /b 14
link /nologo /OUT:"%OUT%\octave_signalsmith_models_tests.exe" "%OUT%\octave_signalsmith_models.obj" "%OUT%\signalsmith_adapter.obj" "%OUT%\primitives.obj" "%OUT%\octave_signalsmith_models_tests.obj" >> build.log 2>&1
if errorlevel 1 exit /b 15
"%OUT%\octave_signalsmith_models_tests.exe" --capture-dir "%DATA%" > test-output.json 2> test-stderr.log
exit /b %ERRORLEVEL%
