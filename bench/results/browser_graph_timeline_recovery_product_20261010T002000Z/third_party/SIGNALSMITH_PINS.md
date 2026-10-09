# Signalsmith source pins

Browser and Native pitch adapters share these upstream header-only trees. The sources are pinned to immutable commits, not floating tags or a moving branch.

- `signalsmith-stretch`: `a670068d9aeb64913331d5cc29337b19a457a7df` (upstream repository tag v1.4.0); `LICENSE.txt` is MIT, copyright 2022 Geraint Luff / Signalsmith Audio Ltd.
- `signalsmith-linear`: `de55e6a50ffcf6f8f43f649692d94691c7025151` (upstream repository tag v0.6.4); `LICENSE.txt` is MIT, copyright 2025 Signalsmith Audio.

The stretch header reports `signalsmith::stretch::SignalsmithStretch<float>::version` as 1.3.2 at this pinned source commit. Build the adapter with the constructor that accepts an explicit seed; the default constructor calls `std::random_device`.

CMake integration should expose one `signalsmith-stretch` INTERFACE target with include directories `third_party/signalsmith-stretch/include` and `third_party/signalsmith-linear/include`. The compatibility header in the stretch include directory includes the pinned root header. `shared/dsp` uses the same target for both Native and Web/WASM.
