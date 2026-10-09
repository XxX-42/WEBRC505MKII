# Shared DSP WASM bridge

This directory builds a WebAssembly C ABI over the same C++ implementation used
by the Native engine: `shared/dsp/src/primitives.cpp`. It does not contain a
second set of audio algorithms. The ABI uses opaque handles because C++ state
layout is private to the shared core.

The initial bridge exposes the implemented primitive classes and stateless
helpers. It is a Gate 1 foundation, not evidence that the full F01–F29 catalog,
53 effect implementations, or browser realtime/stress gates have passed.

## Toolchain pin

The build is pinned to the official `emscripten-core/emsdk` checkout at
`35ff8a6d150541276abbc6bae512ca90bcfbe220` and compiler release `6.0.10`,
compiler commit `d6c521a7f05449857c76bd99e396895583cf2083`. The emsdk manager
installs the upstream release selected by `emsdk install 6.0.10`; no moving
branch is used by this build script. Emscripten is MIT licensed. The local
toolchain used for this implementation is under the current user's
`AppData/Local/CodexBuildTools/emsdk-6.0.10` directory (the Codex app may map
that directory through its LocalCache package path).

Build from the repository root on Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File shared/dsp/wasm/build-wasm.ps1
```

The script verifies both pinned revisions before compiling. It writes a
standalone `.wasm` module to ignored `test-results/dsp-wasm/` by default.
`-EmSdkRoot` and `-OutputDirectory` can be supplied explicitly. Standalone
exports and WASI imports keep their stable names, so browser code can compile
the module on the main thread and pass the `WebAssembly.Module` into one
existing AudioWorklet processor for synchronous instantiation. The processor
does not load a module, fetch bytes, or instantiate WASM from `process()`.

The build fixes linear memory at 64 MiB, disables memory growth, enables WASM
SIMD, and builds without exceptions or RTTI. DSP objects and transfer buffers
are created during setup; process calls use the actual supplied frame count and
perform no allocation or locking. JavaScript must copy audio into preallocated
linear-memory views before each block and copy the result back. That copy is
part of future Worklet timing and must be measured there; the Node test is only
a WASM compute/ABI check.

## ABI lifetime rules

`webrc_dsp_create`, `webrc_dsp_configure`, `webrc_dsp_reset`, `webrc_dsp_destroy`,
and the linear-memory allocators are control/setup operations. Create each
state before the audio callback starts. `webrc_dsp_process` rejects blocks
larger than the prepared `maxBlockFrames`; callers pass the real
`outputs[channel].length`, not a 128-frame assumption. Keep each handle alive
for the processor lifetime. No callback-time `malloc`, `new`, vector growth,
locks, module fetch, or instantiation is allowed.

The C ABI and enum values live in `webrc_dsp_wasm.h`. `webrc_dsp_wasm.cpp`
only adapts calls to the shared C++ primitives.
