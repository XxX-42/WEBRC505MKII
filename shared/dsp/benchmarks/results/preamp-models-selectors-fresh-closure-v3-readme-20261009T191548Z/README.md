# PREAMP selector adapter candidate

This archive corrects the narrative README from the v2 copied-source Release closure. It preserves the exact v2 source closure, executable, object files, build logs, test output, and UI-contract input. Only this README, the manifest note, and checksum index differ from v2.

Captured build: 2026-10-09T19:14:55Z. The artifact is a standalone clean-room adapter for PREAMP ordinal 23. It is not registered in the shared FX factory and does not establish final sound-quality, real-time deadline, host integration, or device-equivalence gates.

The reviewed UI contract snapshot is `reference/dsp/spec/official_fx_ui_contracts.json`, effect `rc505mkii.fx.preamp`, printed page 38. It records nine AMP TYPE choices, nine printed SPK TYPE labels (raw-only/unexpanded in the source contract), five MIC TYPE choices, OFF MIC / ON MIC, and CENTER, 1–10 cm. Per-model diode parameters, pre-emphasis, generated cabinet modes, microphone equalization, distance, and positional filters are clean-room model assumptions, not Roland-published DSP mappings or factory tone clones.

The far/near interpretation of OFF MIC / ON MIC follows the same named control in Roland GT-8 and GP-10 manuals and is an inference for RC-505mkII. Both states retain the selected microphone curve. SPK TYPE=OFF produces a one-tap identity speaker response through the shared partitioned processor, so the shared path retains its partition/alignment timing. MIC POS maps CENTER to 0 and the printed 1–10 cm range to ten local high-shelf profiles.

All cabinet IR data, filters, and block scratch are prepared off the callback. `requiredPrepareBytes()` counts fixed model storage, PREAMP core dynamic storage, block scratch, and a 64 KiB allocator allowance. `replacementPeakBytes()` adds the current active instance to a staged candidate estimate. Hosts should prepare a fresh inactive instance, admit both byte estimates, and swap outside the callback. With no-exception compilation the estimate is preflight only; allocator OOM is not recoverable. The Release fixture exercises 64 same-frame selector events and 64 mixed control events with no callback allocations or frees.

`fixedMixedPathSamples` is the core-derived dry-alignment anchor, not the earliest wet arrival or end-to-end latency. At 48 kHz and 64-frame partitioning it reports 86 samples. A cold ON MIC identity-speaker impulse has earliest observed wet energy at frame 80. The local ON MIC direct/reflection positions are 6/18 samples; OFF MIC positions are 72/168 samples. These are clean-room placement-model values, not device latency.

`build_release.cmd` recompiles the archived source closure with the recorded MSVC x64 Release flags. `SHA256SUMS.txt` hashes every other archive file, and `manifest.json` records the source/input fingerprints and observed test result.
