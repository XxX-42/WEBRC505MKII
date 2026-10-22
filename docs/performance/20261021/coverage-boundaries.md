# Coverage boundaries and unavailable measurements

This file separates what each runner actually executes from the requested end-to-end acceptance. It is not a completed acceptance certificate.

| Evidence | Actually exercised | Not established |
|---|---|---|
| Browser worklet VM A/B | Exact baseline/candidate bundled production FX processor, 44.1/48 kHz, mono/stereo, 1/5 independent instances, full-stream PCM comparison | Actual AudioWorklet scheduling, five TrackAudio lifecycle objects, browser render quantum deadline, UI/GC/structured clone |
| Browser VM per-quantum distribution | Synchronous Node elapsed distribution for all requested FX instances in one timed region, ABBA and memory snapshots | Real browser callback budget PASS; runtime values remain null/NOT_VERIFIED |
| FX sanity (corrected 1,656 cases + 16 long-tail cases complete) | Production canonical UI parameter adapter and bundled DSP; silence/impulse/sine/L-only/R-only/asymmetric stereo; mapped extrema; internal non-finite counters and bypass | Unmapped controls, subjective fidelity, physical latency, full feedback stability from a 0.25-second initialization window |
| Browser functional stress (corrected 1,800 simulated seconds complete in 317.386 wall seconds) | Production DSP, LIVE_MONO, RhythmWorkletCore, recording/overdub processor source, five-buffer playback mix and parameter changes | Five actual TrackAudio objects, LIVE_POLY runtime, real reverse transport, meter/UI, real port transport or browser lifecycle/leak acceptance |
| Native matrix | Production engine callback through device-free accessor; 44.1/48 kHz, 64/128/256 frames, mono/stereo, 1/5 tracks, record/play/overdub, off/realistic/heavy FX | Driver/device XRUN, output continuity, hardware latency; unsupported native transport is not hardware-blocked |
| Native allocation counter | Ordinary C++ operator new/new[] calls in measured callbacks | malloc/calloc/realloc/aligned new; zero tracked allocations is not proof of zero allocation of every kind |
| Native soak (final-source 600-second checkpoint and 1,800-second terminal PASS; earlier-source soak archived) | Real-wall 600-second checkpoint and 1,800-second terminal JSON, workload/state counters recorded | Any unexecuted state/HTTP/UI path; getStatus polling alone is not HTTP bridge concurrency |
| Cloud production preview | Vite preview and HTTP entry/assets in the same execution namespace | User Windows deployment or browser UI behavior |

## Acceptance semantics

- Native functional PASS means finite audio/state/hash assertions passed. It does not imply timing PASS.
- Native timing PASS is independently evaluated from p99 < 50% budget, max < 80% budget, and zero measured CPU deadline exceedances. Budget is frames / sampleRate; at 48 kHz, 64/128/256 frames are 1.333/2.667/5.333 ms.
- CPU deadline exceedances are measured execution durations, not observed driver XRUN events. Hardware counters are null without a driver.
- Three hundred measured callbacks give only about three observations in the p99 tail. Retain raw measurements and do not overinterpret tail precision.
- Browser synchronous VM timings support kernel optimization comparisons, not browser realtime acceptance. Actual callback/long-task/GC/IPC/allocation metrics remain unavailable unless a real browser run supplies them.
- A baseline missing a field is null, never zero. Negative process heap differences may reflect GC and are not negative allocations.
- Correctness tests and bit-identical PCM do not establish acoustic fidelity. Peak/DC flags need baseline comparison and interpretation, not blanket approval from finite output.

## Current environment limitations

The full fresh Playwright run attempted 101 cases, but Chromium failed before assertions with process_singleton_posix.cc socket() Operation not permitted. This is E2E_ENVIRONMENT_BLOCKED, not a hardware requirement. The standard E2E launch retained its existing Playwright parameters (including --no-sandbox in the raw launch log); no security setting was changed to bypass this socket restriction. A separate supported retry explicitly enabled chromiumSandbox:true. The supported cloud browser cannot reach this command executor's loopback namespace, and no supported CDP endpoint was supplied.

LOCAL_DEPLOY_BLOCKED applies to user-machine deployment: this task uses the authorized cloud environment and does not use the user's devices. Cloud HTTP startup must be reported separately.

HARDWARE_BLOCKED is reserved for physical audio/MIDI endpoint timing, driver XRUN/underrun/overflow, physical loopback/acoustic latency, and hardware quality checks. Missing browser execution or software coverage must not be relabeled as hardware-blocked.
