# Native Audio Core MVP

## Goal

Keep the current Web UI as the MVP shell and move only the realtime audio path into a native C++ engine.

## Build Native Host

```powershell
cmake -S native-mvp/engine-cpp -B native-mvp/build-v145 -G "Visual Studio 17 2022" -T v145 -A x64
cmake --build native-mvp/build-v145 --config Release --target native_bridge_host
native-mvp\build-v145\Release\looper_core_tests.exe
```

If `cmake` is not on `PATH`, use:

```powershell
D:\Applications\VisualStudio\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe -S native-mvp/engine-cpp -B native-mvp/build-v145 -G "Visual Studio 17 2022" -T v145 -A x64
```

## Run Native Host

```powershell
native-mvp\build-v145\Release\native_bridge_host.exe
```

The host binds to `http://127.0.0.1:17755`.

## Frontend

```powershell
npm install
npm run build
npm run dev
```

The Web UI will enter `NATIVE AUDIO UNAVAILABLE` if the host is not running. It will not fall back to the old Web Audio path.
