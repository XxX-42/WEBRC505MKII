# Third-party notices

The first-party project is licensed under GPL-3.0-or-later; see `LICENSE`. The components below retain their own licenses. These notices do not change the terms of any third-party component.

## Browser production bundle

- Signalsmith Stretch 1.3.2 and Signalsmith Linear 0.6.4 are MIT-licensed. Provenance, pinned source commits and exact license texts are in `src/audio/pitch/vendor/NOTICE.md` and `src/audio/pitch/vendor/SIGNALSMITH_*_LICENSE.txt`; browser distributions include matching copies in `THIRD_PARTY/signalsmith/`.
- Vue 3.5.25 is MIT-licensed. The runtime is bundled from the production dependency `vue`; its upstream license is included at `public/THIRD_PARTY/vue/LICENSE` and in built web distributions at `THIRD_PARTY/vue/LICENSE`.
- Vite 7.2.4 is MIT-licensed. Its build injects a module-preload polyfill into the production entry point; the Vite license is included at `public/THIRD_PARTY/vite/LICENSE.md` and in built web distributions at `THIRD_PARTY/vite/LICENSE.md`.
- `public/rc-loop.svg` is a first-party project favicon.
- The Signalsmith WebAssembly module was built using Emscripten. The vendored notice documents upstream module provenance and the local ESM-wrapper patch. The exact Emscripten toolchain build has not yet been recovered, so the generated module's compiler-runtime provenance is not fully pinned in this manifest.
- Google Fonts are fetched at runtime from Google Fonts; the application does not include font binaries. If font files are later self-hosted, include the exact upstream font license notices.

## Native build

The default Native bridge build uses FetchContent to obtain the pinned dependencies. Its release target must ship their exact upstream license files beside the executable under `THIRD_PARTY/`:

- RtAudio 6.0.1: MIT-like license with a non-binding request to send modifications upstream; `LICENSE` from `https://github.com/thestk/rtaudio/tree/6.0.1`.
- cpp-httplib v0.16.3: MIT; `LICENSE` from `https://github.com/yhirose/cpp-httplib/tree/v0.16.3`.
- nlohmann/json v3.11.3: MIT; `LICENSE.MIT` from `https://github.com/nlohmann/json/tree/v3.11.3`.
- Signalsmith Stretch and Linear are MIT-licensed and included as vendored Native headers with their exact notices under `native-mvp/engine-cpp/third_party/signalsmith/`.
- Optional ASIO sources are not bundled or enabled by default. An ASIO-enabled build uses SDK files selected by the developer; audit the exact SDK version and terms before distributing that build.

Native Rubber Band HQ_RENDER is an optional build feature and is disabled by default. When enabled, the Native bridge links Rubber Band Library v4.0.0 from upstream commit `1d95888bec3ae0a17c0c4af791810d5a63f6bc35`; the exact upstream `COPYING` text is also retained at `native-mvp/engine-cpp/third_party/rubberband/COPYING` (SHA-256 `cedd4c1885d75991bf1077cc6e33359103cf04fbc996f20d30ab043d5fc5fcc5`). The Native build copies this license beside the executable under `THIRD_PARTY/rubberband/COPYING`. See [`native-mvp/engine-cpp/RUBBERBAND_BUILD.md`](native-mvp/engine-cpp/RUBBERBAND_BUILD.md) for pinned, reproducible source-build steps and CMake configuration. The source and binary distribution of a build with this dependency must comply with its GPL-2.0-or-later terms; the app's first-party source remains GPL-3.0-or-later. Do not distribute an ASIO SDK without its separate applicable terms.
