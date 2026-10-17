# Building Native HQ_RENDER with Rubber Band

Native HQ_RENDER uses the upstream Rubber Band Library offline R2/R3 engines. It is never called from the audio callback. The optional feature is explicit; a build without it reports `nativeHqRenderer.available: false` and rejects Native HQ export rather than substituting a different algorithm.

## Pinned dependency and license

- Project: [Rubber Band Library](https://github.com/breakfastquay/rubberband)
- Release: 4.0.0
- Pinned upstream commit: `1d95888bec3ae0a17c0c4af791810d5a63f6bc35`
- Upstream license: GPL-2.0-or-later; the verbatim `COPYING` file is preserved at `native-mvp/engine-cpp/third_party/rubberband/COPYING`
- The first-party project source is GPL-3.0-or-later. Preserve Rubber Band's copyright and license, provide corresponding source/build information for distributed builds, and comply with the license that applies to your distribution.

The Native renderer uses `getEngineVersion()` from the Rubber Band v3+ API and verifies that the requested R2 or R3 engine is actually selected. Older/incompatible libraries fail at link time or are rejected; the runtime never silently substitutes an engine.

## Build the pinned library from source

Install a C++ compiler, [Meson](https://mesonbuild.com/) and Ninja. Then:

```sh
git clone https://github.com/breakfastquay/rubberband.git
cd rubberband
git checkout 1d95888bec3ae0a17c0c4af791810d5a63f6bc35
meson setup build --default-library=static --auto-features=disabled -Dfft=builtin -Dresampler=builtin
ninja -C build
```

The command disables optional plugins, command-line tools and tests, and uses Rubber Band's built-in FFT/resampler implementations to avoid introducing unlisted FFT/resampler dependencies. Review any change to these settings and the upstream `COMPILING.md` before redistributing a different build.

## Enable Native HQ_RENDER

Configure the Native CMake project with the include and library paths from the source/build directories:

```sh
cmake -S native-mvp/engine-cpp -B build-native \
  -DNATIVE_ENABLE_RUBBERBAND_HQ=ON \
  -DRUBBERBAND_INCLUDE_DIR=/path/to/rubberband/source \
  -DRUBBERBAND_LIBRARY=/path/to/rubberband/build/librubberband.a
cmake --build build-native --target native_bridge_host
ctest --test-dir build-native --output-on-failure
```

For the test-only fake no-audio HTTP host, also set `-DNATIVE_BRIDGE_SIMULATION_ONLY=ON`. That target validates bridge and HQ route behavior with synthetic input only; it does not measure device audio, XRUNs, timing, or hardware quality. To test the renderer without building the host/audio dependencies, set `-DNATIVE_PORTABLE_TESTS_ONLY=ON`; the `native_rubberband_renderer_tests` target exercises the selected R2/R3 library directly.

When `NATIVE_ENABLE_RUBBERBAND_HQ=OFF`, the application exposes the unavailable capability and returns an explicit error. It never falls back to Signalsmith, varispeed, or a silent bypass for Native HQ_RENDER.
