# Rhythm event-plan parity checkpoint — 2026-10-18

This checkpoint makes Browser and Native generate the same deterministic **clean-room event plan** from the 240-row metadata catalog. It does not add factory MIDI/events or samples, and it does not establish matching synthesized PCM, kit timbre, listening quality, device behavior, or realtime performance.

## Behavior aligned

- Native now uses the Browser event-template seed, event rules, velocity humanization, section behavior, and per-bar seed salt. Kit selection affects the synthetic voice timbre but not the event plan.
- METAL metadata now selects the Browser electronic pattern rules, matching the Native genre classification.
- GUIDE row 210 uses the same four-click template whether selected through the legacy metronome name or the catalog row; its click identity is fixed to A/main.
- Intro/fill templates repeat by bar as the Browser worklet repeats its one-bar template. A tempo/section update is exercised at a bar boundary.
- A fixed-capacity, optional Native trace callback and `native_rhythm_event_dump` target support deterministic comparison. The trace hook is inert unless a test installs it; callback records use fixed storage.

## Reproduction

From the repository root, build the portable Release test targets with assertions enabled for tests:

```sh
/tmp/rc505-cmake-tools/cmake/data/bin/cmake -S native-mvp/engine-cpp -B /tmp/rc505-native-rhythm-release -DCMAKE_BUILD_TYPE=Release -DNATIVE_PORTABLE_TESTS_ONLY=ON -DNATIVE_ENABLE_RUBBERBAND_HQ=OFF
/tmp/rc505-cmake-tools/cmake/data/bin/cmake --build /tmp/rc505-native-rhythm-release --config Release -j2
/tmp/rc505-cmake-tools/cmake/data/bin/cmake --build /tmp/rc505-native-rhythm-release --config Release --target native_rhythm_event_dump -j2
/tmp/rc505-cmake-tools/cmake/data/bin/ctest --test-dir /tmp/rc505-native-rhythm-release --output-on-failure --parallel 1
NATIVE_RHYTHM_EVENT_DUMP=/tmp/rc505-native-rhythm-release/native_rhythm_event_dump npm run test:rhythm:parity
```

The dump target is excluded from the default build set and therefore has an explicit build command. The strict env check intentionally fails if the native executable is missing; it does not silently substitute Browser-only coverage.

## 2026-10-18 result

On the working tree based on `cffa18a577d1b1bdd5d8dcbe5551b8d49145ba7d`:

- Clean-room plan comparison: **3,904 configurations, 58,123 event records, 0 mismatching configurations or event records**.
- Complete catalog matrix: 240 pattern IDs × A–D × main/intro/ending/fill = **3,840 configurations**.
- Representative kit check: kits 1, 6, and 16 across METAL A–D and all four sections = **48 configurations**.
- Timing/boundary cases: fractional 127.3 BPM at 44.1 kHz; 3/4, 5/8, 6/8 and 15/8; two-bar event sequences; 13/64/127/1024-frame callbacks = **12 configurations**.
- Dynamic boundary: METAL intro at 127.3 BPM changes to fill at 139.7 BPM at the bar boundary; verified at 13- and 1024-frame block sizes = **4 segment configurations**, with no block-size-dependent plans.
- Browser unit tests: **131 files / 922 tests passed**.
- Native portable Release CTest: **46/46 passed**. Test compile flags include `-O3 -DNDEBUG ... -UNDEBUG`, so assertions remain active.
- Strict serial Playwright E2E: **84/84 passed**, using Chrome for Testing headless-shell 154.0.8037.57 and the explicit no-audio Native bridge simulation host.
- `npm run build`: passed, including TypeScript/Vue type-check, worklet bundle, Vite bundle, and third-party notice verification.

The initial expanded comparison exposed two harness issues that were corrected before the passing run: the kit-independence matrix must include its default-kit row, and a multi-bar native trace must end at the rounded absolute duration for the full bar count rather than a rounded one-bar duration multiplied by the bar count. The latter can otherwise capture a next-bar downbeat one sample early at fractional tempos.

All Browser E2E Native-host paths here use the explicitly simulated no-audio bridge. No physical audio endpoint or hardware was exercised. The 240 catalog entries are metadata; this clean-room parity result is not comparison against Roland factory rhythm data.
