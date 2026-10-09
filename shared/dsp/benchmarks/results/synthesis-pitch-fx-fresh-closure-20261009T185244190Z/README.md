# SYNTH / G2B / AUTO RIFF / HRM AUTO standalone source closure

This archive freezes the clean-room standalone implementation of SYNTH (catalog ordinal 6), G2B (10), AUTO RIFF (12), and HRM AUTO(M) (19), together with the exact C++ dependency closure and the executable used for the Release tests.

`source/` is the compiler input copy. `build_release.cmd` compiles only that copy and writes objects, executable, and logs to `build/` and `logs/`. Re-run with the pinned VS2019 Build Tools environment from this folder. The source SHA list is in `source-prebuild.json`; `source-postbuild.json` confirms the copy did not change during the captured build. The source copy matched the live repository at capture: true.

Release verification: 22 passed, 0 failed. The captured executable is `build/synthesis_pitch_fx_tests.exe`; complete stdout and stderr are in `logs/test-output.log` and `logs/test-stderr.log`. The assertions cover separate 220/330 Hz tracking, G2B octave-down projections and distinct modes, all 30 distinct authored eight-slot riff tables plus 120 BPM sample-clock progression and sample-offset phrase changes, C-major harmony and MIDI target override, transactional event rejection, L/R isolation, and no C++ heap new/delete during 64/128/256-frame callback probes. Raw projections and RMS are included in the test log.

The local control curves and the 30 phrase table are clean-room reconstruction choices. They do not claim sample-identical Roland behavior or establish normative internal topology. Pitch analysis is incremental YIN (2048-frame window, 512-frame hop) and does not add fixed audio delay. G2B, AUTO RIFF, and HRM AUTO(M) use streaming TD-PSOLA; its lookahead is reported separately from analysis age. SYNTH has no fixed audio-path delay. This archive has no callback-duration distribution, browser/WASM parity, host-graph, ASan, or hardware result and does not qualify a realtime or final-quality gate.

Repository reference at capture: `codex/instrument-grade-audio-20261007` / `9c665897fe77053a6c21c79703543b15349d1cb4`. Source-closure digest: `4b335963745ee625a26d01b3c67dba95fee7a4d3144fd6c12b20d47d8e51c13b`.
