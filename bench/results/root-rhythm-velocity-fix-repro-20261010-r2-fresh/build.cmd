@echo off
call "C:/Program Files (x86)/Microsoft Visual Studio/2019/BuildTools/VC/Auxiliary/Build/vcvarsall.bat" x64 > nul
if errorlevel 1 exit /b 2
cl /nologo /std:c++17 /O2 /EHsc /MD /I"snapshot/shared/dsp/include" probe.cpp "snapshot\shared\dsp\src\cleanroom_rhythm_data.cpp" "snapshot\shared\dsp\src\fft.cpp" "snapshot\shared\dsp\src\primitives.cpp" "snapshot\shared\dsp\src\rhythm.cpp" "snapshot\shared\dsp\src\spatial_temporal.cpp" /Fe:probe.exe
