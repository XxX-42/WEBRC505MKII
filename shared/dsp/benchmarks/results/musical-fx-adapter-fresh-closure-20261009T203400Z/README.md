# Musical FX adapter standalone closure

This isolated MSVC Release build wraps the existing clean-room processors for ordinals 6, 10, 12, 16, 17, 19, 20, 21, and 22. It does not modify CMake, `FxProcessor`, the factory, Native host, or WASM exports.

The adapter uses a single sorted stream of typed control and MIDI events, with a total limit of 64. VOCODER20 requires an external interleaved stereo carrier buffer through `processBlockWithCarrier`; the ordinary render entry rejects it. OSC VOC(M)21 uses its existing internal oscillators and typed sample-offset MIDI note events. Setup uses a fresh processor variant and checks the candidate or replacement peak against the supplied budget before replacing the previous prepared state.

Build and test: run `build_release.cmd` from this archive on the captured Visual Studio 2019 Build Tools installation. Release test output is in `build/test-output.log`; `musical_fx_adapter.cpp` also compiled with MSVC exceptions disabled. The complete copied source closure and SHA-256 list are in `source/`, `source-hashes.json`, and `SHA256SUMS.txt`.

The test executable passed stereo processing for all nine kinds, left/right silent-side tests for G2B/ROBOT/ELECTRIC, true carrier sidechain routing with left/right isolation, sample-offset MIDI chords, 64 mixed parameter/MIDI events, 65-event rejection, invalid tail-event transactional behavior, failed prepare and insufficient replacement-budget preservation, exact 64/128/64 split equivalence for timed MIDI, and zero C++ `new`/`delete` within the measured process calls. The VOCODER20 final-block carrier energy was L=1.88125543, R=1.06895568e-09 with the right carrier zero.

This is an adapter behavior pass only. The shared `FxProcessor` base still has planar audio and float-only parameter events; Native integration needs an explicit stereo carrier context and typed MIDI event path for ordinals 20/21. This evidence does not qualify final audio quality, realtime deadline targets, whole-graph operation, or hardware.
