# Voice and vocoder standalone capture

This archive contains a fresh MSVC Release compile from the copied `source/` closure. The exact command is `build.cmd`; compiler, linker, and flags are recorded in `manifest.json` and the per-step `logs/` files. `snapshot-input-hashes-before.tsv` equals `snapshot-input-hashes-after.tsv`; the corresponding live input lists also match, so the compiled source snapshot did not change during the build.

Both standalone suites passed: ROBOT/ELECTRIC/OSC BOT in `logs/voice_fx-tests.log` and VOCODER/OSC VOC(M) in `logs/vocoder_fx-tests.log`. The assembly listings preserve relevant stack frames: the large Electric test frame is 696 bytes, `ElectricFxProcessor::prepare` reserves 1,312 bytes, and `YinPsolaStereoPath::prepare` reserves 128 bytes. Prepare stages its large candidate objects on the heap; `processBlock` remains allocation-free in the tests.

These results qualify only the archived source and test scenarios. They do not establish real-time deadline performance, final sound quality, hardware behavior, or complete Native/Browser graph integration. Native ratio-sweep and cross-runtime evidence remains separate.
