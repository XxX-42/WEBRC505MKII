Native 41-ready registry candidate copied-source verification.

Repository HEAD at capture: aa382c0a9b2647724cb35921afc14b9b1eb78f25
UTC capture: 2026-10-09T19:37:10.3400479Z
Snapshot source-set SHA-256: 7acde39774f87a5d9a34754111487f44ca8b823595109ecabf542fb9462c3e4f (1415 files)

Snapshot layout intentionally includes the Native CMake project, shared DSP CMake/source/header/test/benchmark/wasm files, pinned Signalsmith source and license files, native verification scripts, and the three exact FetchContent source trees. It excludes generated build output, old benchmark-result trees, node_modules, and user data files.

Rebuild from this snapshot using: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/native-verify.ps1 -BuildRoot "C:\Users\user1000\AppData\Local\Temp\webrc-native-fx41-copy-20261009T193630570Z"
The script writes all build outputs under TEMP. No audio hardware is opened by this build/test command.
