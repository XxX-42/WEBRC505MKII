# Recover and use the validated FX interface work

## Recover into a new folder

The supplied Git bundle contains complete history. Do not reset an existing dirty project or overwrite a newer UI to inspect this work.

```sh
git clone -b feat/official-fx-parameters-20261022 /path/to/downloaded.bundle rc505-fx-review
cd rc505-fx-review
git log -1 --oneline
```

This creates a separate local checkout. It does not push anything. Review and merge selectively into another working project rather than force-pushing or overwriting user changes.

## Browser build and tests

```sh
npm ci
npm run test:unit -- --maxWorkers=2
npm run build
npm run preview -- --host 127.0.0.1
```

The production build checks TypeScript, bundles the AudioWorklet and verifies exact license files. Browser audio still requires normal browser audio activation and the intended audio device. The recorded cloud HTTP startup check is not a physical browser/device audio test or user-machine deployment.

## Native portable verification

```sh
cmake -S native-mvp/engine-cpp -B build/native-portable -DNATIVE_PORTABLE_TESTS_ONLY=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build/native-portable -j2
ctest --test-dir build/native-portable --output-on-failure -j2
```

CMake uses the declared official dependency pins, including nlohmann/json v3.11.3. An offline environment can supply `FETCHCONTENT_SOURCE_DIR_JSON_SRC`; see `native-validation.md` for tested dependency provenance and cache overrides. No compiler, npm packages or dependency cache is embedded in the Git bundle.

For a device-free bridge contract test, configure a separate build with `NATIVE_BRIDGE_SIMULATION_ONLY=ON`, `RTAUDIO_API_ALSA=OFF`, `RTAUDIO_API_PULSE=OFF` and `RTAUDIO_API_JACK=OFF`, build it and run CTest. This uses the declared RtAudio 6.0.1 and cpp-httplib v0.16.3 dependencies but does not certify hardware audio.

## Find the actual controls and limits

- `api-contract.md`: Browser setter, Native HTTP setter, capability discovery, acknowledged snapshots, reset/replacement and unit compatibility.
- `coverage-summary.md`: human-readable effect/variant coverage.
- `parameter-coverage.csv`: all 267 manual rows, exact implementation status and documented-domain limitations.
- `native-runtime-schema.json`: the captured tested Native host capability schema. Query a running host's `/v1/status` for that host's actual support.
- `validation-summary.md` and `validation-logs/`: exact verified checkpoints and evidence, with historical results separated.

Official parameters are opt-in and clearly distinguished from legacy extensions. Unsupported controls are not empty successful setters. Undocumented alternate algorithms, factory phrase/pattern content and unmapped physical carrier inputs are not invented. Browser VOCODER folds its stereo carrier into the existing mono voice engine; Native uses separate channel processing. Cross-backend PCM or Roland hardware sound identity is not claimed.

This work does not claim complete hardware MEMORY import/export, all bank-level assignments or full MIDI ASSIGN support. Physical latency, XRUNs, hardware listening acceptance and deployment on the user's computer remain unverified.
