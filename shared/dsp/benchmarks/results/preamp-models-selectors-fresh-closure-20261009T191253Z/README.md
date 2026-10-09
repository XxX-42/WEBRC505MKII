# PREAMP selector adapter candidate

Captured UTC: 20261009T191253Z. This is a standalone clean-room model adapter for PREAMP (ordinal 23); it is not registered in the shared FX factory and does not establish final sound-quality, real-time deadline, host integration, or device equivalence gates.

The official UI facts are in dsp/spec/official_fx_ui_contracts.json, effect c505mkii.fx.preamp, printed page 38: nine AMP TYPE choices, nine printed SPK TYPE labels (still raw-only/unexpanded in the source contract), five MIC TYPE choices, OFF MIC / ON MIC, and CENTER, 1–10 cm. The wrapper implements those visible choices in selector order. The per-model diode parameters, pre-emphasis curves, cabinet modal IRs, microphone equalization, and positional filters are authored clean-room reconstruction assumptions; they are not values published by Roland and do not claim to clone the factory sounds.

The far/near interpretation of OFF MIC / ON MIC follows the same named control in Roland GT-8 and GP-10 manuals and is an inference for RC-505mkII. Both states retain the selected microphone curve. SPK TYPE=OFF produces a one-tap identity speaker response through the existing partitioned processor, so the shared path retains its partition/alignment timing. MIC POS maps CENTER to 0 and 1–10 cm to ten local high-shelf profiles.

All generated cabinet IR data, filters, and block scratch are prepared off the audio callback. equiredPrepareBytes() counts the instance's fixed arrays, PREAMP core's dynamic storage, block scratch, and 64 KiB allocator allowance. eplacementPeakBytes() adds an active instance to the staged candidate estimate. Hosts should prepare a fresh inactive instance, budget both instances, and swap outside the callback. On no-exception targets the estimate is preflight only; allocator OOM is not recoverable. processBlock() uses a fixed event array, separate L/R histories, and was verified with 64 same-frame controls and zero callback allocations/frees.

The reported ixedMixedPathSamples is the dry alignment anchor inherited from the core, not earliest wet arrival or end-to-end latency. In this 48 kHz / 64-frame partitioned impulse fixture it reports 86 samples while the earliest observed wet output is frame 80 with ON MIC. ON MIC uses a local 6-sample direct / 18-sample reflection position model; OFF MIC uses 72 / 168 samples. These are placement-model delays, not device latency claims.

uild_release.cmd recompiles only the archived source closure with the recorded MSVC x64 Release flags and runs preamp_models_tests.exe. SHA256SUMS.txt fingerprints every archive file except itself; manifest.json gives the same input fingerprints and the measured test result.

