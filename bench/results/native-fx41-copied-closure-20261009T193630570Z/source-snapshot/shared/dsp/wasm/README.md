# Shared DSP WASM bridge

This directory builds a WebAssembly C ABI over the shared C++ DSP library in
`shared/dsp/src`, which is also used by the Native engine. It does not contain a
second set of audio algorithms. The ABI uses opaque handles because C++ state
layout is private to the shared core.

The base API kind IDs 1–11 and control IDs are a distinct namespace from the
extended kind IDs. ABI version 2 keeps existing control IDs 1–13 unchanged;
the following additive controls extend that API without renumbering existing
values. Shelf control values are `[frequencyHz, gainDb, slope, smoothingMs]`;
the final `smoothingMs` element may be omitted and defaults to 5 ms. Reset
controls 16–18 are setup/control operations and should be applied before the
processor becomes active. The shared core rejects invalid shelf values before
changing active coefficients.

| Base kind | C ABI ID | Controls |
| --- | ---: | --- |
| Parameter smoother | 1 | 1: target `[value, timeMs]`; 16: reset value `[value]` |
| Biquad DF2T | 2 | 2: low-pass; 3: high-pass; 4: band-pass; 5: peaking; 14: low shelf; 15: high shelf |
| TPT state-variable filter | 3 | 6: frequency/Q |
| First-order all-pass | 4 | 7: frequency |
| Lagrange delay | 5 | delay time per frame through the process parameter span |
| LFO | 6 | 8: frequency; 17: reset phase cycles `[phaseCycles]` |
| PolyBLEP oscillator | 7 | 9: frequency; 10: waveform; 18: reset phase cycles `[phaseCycles]` |
| ADAA cubic shaper | 8 | 11: drive |
| Dual-detector compressor | 9 | 12: parameters |
| 2×2 delay matrix | 10 | 13: same/cross feedback |
| PCG32 | 11 | `webrc_dsp_seed(state, sequence)` |

The initial bridge exposes the implemented primitive classes and stateless
helpers. It is a Gate 1 foundation, not evidence that the full F01–F29 catalog,
53 effect implementations, or browser realtime/stress gates have passed.

## Toolchain pin

The build is pinned to the official `emscripten-core/emsdk` checkout at
`35ff8a6d150541276abbc6bae512ca90bcfbe220` and compiler release `6.0.10`,
compiler commit `d6c521a7f05449857c76bd99e396895583cf2083`. The emsdk manager
installs the upstream release selected by `emsdk install 6.0.10`; no moving
branch is used by this build script. Emscripten is MIT licensed. The local
toolchain used for this implementation is under the current user's
`AppData/Local/CodexBuildTools/emsdk-6.0.10` directory (the Codex app may map
that directory through its LocalCache package path).

Build from the repository root on Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File shared/dsp/wasm/build-wasm.ps1
```

The script verifies both pinned revisions before compiling. It writes a
standalone `.wasm` module to ignored `test-results/dsp-wasm/` by default.
`-EmSdkRoot` and `-OutputDirectory` can be supplied explicitly. Standalone
exports and WASI imports keep their stable names, so browser code can compile
the module on the main thread and pass the `WebAssembly.Module` into one
existing AudioWorklet processor for synchronous instantiation. The processor
does not load a module, fetch bytes, or instantiate WASM from `process()`.

The build fixes linear memory at 64 MiB, disables memory growth, enables WASM
SIMD, and builds without exceptions or RTTI. DSP objects and transfer buffers
are created during setup; process calls use the actual supplied frame count and
perform no allocation or locking. JavaScript must copy audio into preallocated
linear-memory views before each block and copy the result back. That copy is
part of future Worklet timing and must be measured there; the Node test is only
a WASM compute/ABI check.

## ABI lifetime rules

`webrc_dsp_create`, `webrc_dsp_configure`, `webrc_dsp_reset`, `webrc_dsp_destroy`,
and the linear-memory allocators are control/setup operations. Create each
state before the audio callback starts. `webrc_dsp_process` rejects blocks
larger than the prepared `maxBlockFrames`; callers pass the real
`outputs[channel].length`, not a 128-frame assumption. Keep each handle alive
for the processor lifetime. No callback-time `malloc`, `new`, vector growth,
locks, module fetch, or instantiation is allowed.

The C ABI and enum values live in `webrc_dsp_wasm.h`. `webrc_dsp_wasm.cpp`
only adapts calls to the shared C++ primitives.

## Versioned extended kinds

`webrc_dsp_abi_version()` returns `2`, `webrc_dsp_extended_api_version()`
returns `1`, and `webrc_dsp_capabilities()` returns `0x7`: bits `0x1`, `0x2`,
and `0x4` advertise the base primitives, extended kinds, and shared product FX
registry respectively. The additive FX API reports version 1 through
`webrc_dsp_fx_api_version()`; ABI version 2 and its existing entry points remain
unchanged. Browser setup must require all three bits and the FX API version
before exposing these capabilities.

`webrc_dsp_extended.h` assigns stable C ABI kind IDs that
are separate from the formula references in `dsp/spec/formula_index.json`.
Creating and exercising a kind through this bridge does not mean that a named
product FX, all 53 FX, or a full application graph has passed acceptance.

| Extended kind | C ABI ID | Formula reference |
| --- | ---: | --- |
| WDF symmetric diode | 100 | F23 |
| Oversampled nonlinear | 101 | F07 |
| Pattern slicer | 102 | F16 |
| Sample-accurate scheduler | 103 | F20 |
| Mid/Side width | 104 | F22 |
| Onset detector | 105 | F27 |
| Bit-rate reducer | 106 | F28 |
| Ring modulator | 107 | F29 |
| YIN pitch detector | 108 | F10 |
| Offline TD-PSOLA | 109 | F11 |
| Streaming TD-PSOLA | 110 | F11 |
| Phase vocoder | 111 | F12 |
| Multiband vocoder | 112 | F13 |
| Signalsmith stretch adapter | 113 | F11/F12 adapter; dependency identity is separate |
| Granular texture | 114 | F15 |
| FDN reverb | 115 | F17 |
| Partitioned convolver | 116 | F18 |
| Spectral freeze | 117 | F19 |
| Reverse segment | 118 | F25 |
| Platter inertia | 119 | F26 |
| Drum voice pool | 120 | F24 |
| Clean-room rhythm renderer | 121 | 240 CR-RHY patterns × 16 procedural kits |
| Incremental YIN detector | 126 | F10 |
| Prepared LIVE_MONO pitch route | 127 | F10/F11 |

IDs 122–125 are intentionally unassigned in this extended-kind namespace.
Pitch kind 127 is a mono algorithm. Browser bank integration must opt into it
explicitly and use separate prepared instances for the left and right channels
when stereo preservation is required; it is not an implicit stereo-to-mono
conversion. Its detector/work-budget and PSOLA latency fields are exposed via
`webrc_dsp_extended_pitch_get_metrics`; an unknown or unavailable estimate must
remain explicit.
For pitch runtime metrics, `analysisBusy` is `0` or `1` only when the selected
detector exposes that state. `UINT32_MAX` means the adapter cannot report it;
in particular, LIVE_MONO currently returns this unavailable sentinel.

## Browser FX registry route

The shared FX ABI reports 53 stable catalog entries, but processor readiness
comes from `webrc_dsp_fx_is_processor_available`, not from the catalog count.
The build currently exposes the ready registry processors through one stable
per-ordinal descriptor API. Parameter bounds are reconstructed safe bounds;
`officialParametersValidated` remains false unless separately verified. A
Browser route rejects enabled shared-DSP and legacy WebAudio units interleaved
in one bank location, because splitting such a chain would reorder its slots.
All-shared and all-legacy bank routes keep their stored order.

The looper Worklet owns five separate stereo record-input chains and five
separate stereo playback chains. Enabled record-input DSP runs before loop
record/overdub writes; track-playback DSP runs before the pre-existing track
send and mix graph. A distinct post-mix stereo Worklet hosts the shared output
bank after master gain, so those shared output units also process monitor and
rhythm signals that feed the same master route. Legacy output effects retain
their existing track-mix-only location before master gain. FX-bank replacement
stages handles while the AudioContext is suspended, then publishes both Worklet
plans transactionally; each newly enabled shared route ramps from dry to wet
over 10 ms using preallocated scratch. This does not qualify the full FX catalog
or real-time callback deadlines.

Kind 121 reads immutable, generated clean-room pattern and kit tables. It does
not embed or claim third-party MIDI, samples, or audio. The table digests are
queried through the C ABI so a caller can pin the data actually compiled into
the module. Setup operations select a table pattern/kit and start at an absolute
frame while stopped. Queue variation/fill/ending/stop/tempo methods are the
only cross-thread-safe controls; rendering takes an explicit absolute block
start and the actual output frame count. A noncontiguous frame range returns an
error after the renderer zeroes that range and resets its transport. Rhythm
metrics are a quiescent snapshot API and must not race `process_block`.

Kinds 126 and 127 add explicit mono streaming pitch paths. Kind 126
`IncrementalYinDetector` takes six prepare floats in this order:
`[windowFrames, minimumHz, maximumHz, threshold, hopFrames, workUnitsPerCallback]`.
Kind 127 `LiveMonoPitchRoute` takes
`[windowFrames, hopFrames, workUnitsPerCallback, minimumHz, maximumHz, threshold]`
and combines incremental YIN with streaming TD-PSOLA. Both require one input
channel and reject invalid, non-integral frame/work values during preflight.
Kind 126 consumes samples with `webrc_dsp_extended_process_yin`; kind 127 uses
the ordinary mono process call for input-to-output resynthesis. The getter
returns `WEBRC_DSP_NO_ESTIMATE` until the first complete estimate is available.
Pitch metrics separately report the cold-start frames to that first estimate,
window end, estimate age, detector processing lag, last/budgeted estimator work,
and (for LIVE_MONO) the PSOLA lookahead and declared window-plus-lookahead sum.
That declared sum counts the analysis window and resynthesis lookahead only;
it excludes detector processing lag, estimate age, hop scheduling, and cold
startup. It is not a bound or measurement of the complete path latency.
`LIVE_MONO_PITCH_RATIO` control 20 accepts one ratio in [0.5, 2]. The
work-unit budget bounds estimator operations; input ingestion and complete
callback time still require runtime measurement. The default tuple values used
by tests are not a realtime qualification profile.

## Shared product FX registry

The shared catalog has 53 stable ordinal/ID pairs sourced from
`dsp/spec/fx_catalog.json`; formula IDs F01–F29 are not these registry ordinals.
The current WASM bridge exposes real processors for ordinals 1–5, 7–9, 11,
13, 25–27, 29–39, and 46–53. Other catalog entries remain metadata-only
and reject creation with a non-success status. These 32 processors use the same
native/Web C++ core and generation-checked `Fx` handle domain. Their
parameter descriptors are reconstruction-safe ranges;
`officialParametersValidated` remains false. This available subset does not
claim that the remaining 21 catalog entries or a complete 49-input/53-track
graph are implemented.

`webrc_dsp_fx_create()` is setup-only and reserves its reported peak requirement
in the common 48 MiB managed-memory ledger before factory construction or
prepare. Prepare and destroy require a suspended/inactive candidate and must
not run on the active Worklet render thread. Stereo process calls use separate
planar input and output pointers; mono handles only require left pointers.
`process_stereo_events()` applies at most 256 sorted frame-offset parameter
events using a fixed stack array. Process pointers must come from checked
transfer allocations or other validated spans inside this module's memory.
Parameter-set calls belong to the processor's single audio owner. The FX
registry does not claim the other 21 processors, a published official UI
mapping, a complete 49-input/53-track graph, or realtime deadline qualification.

## Setup, processing, and pointer boundaries

The ABI operations `create`, `create_convolver`, `destroy`, `reset`,
`configure`, transfer allocation/free, and FDN early-impulse installation are
setup or graph-control operations. Do them on an inactive candidate or under
serialization with the processor; do not call them concurrently with its
process method. Convolver IRs are copied during candidate creation. The
`set_impulse_response` function is only for prepared FDN early taps and does
not reconfigure a convolver. Publish a replacement graph only after candidate
preparation succeeds. The fixed 48 MiB ledger limits accounted module payload
inside the fixed 64 MiB WASM memory; it cannot recover a WebAssembly trap from
an allocator failure, so the host must preflight active plus staged memory and
isolate candidate preparation from the active module/graph.

Prepared `process_*` entry points and bounded scheduler/event/drum operations
do not allocate or lock in the shared implementation. This is a code-path
property, not proof of callback deadline performance. The FFT utility runs
in place with caller-owned scratch and no allocation. YIN frame analysis is
bounded but compute-heavy; measure it before scheduling on a realtime thread.
No operation may race another operation on the same handle unless its API
explicitly defines that concurrency.

Every pointer passed to the C ABI must describe a readable or writable span
inside this module's current `memory.buffer`, sized for the declared frame or
parameter count and aligned for its C type. The C ABI does not validate
arbitrary host addresses. The JavaScript boundary should obtain these spans
from live transfer tokens, verify address/byte-length/alignment before making
typed views, and discard views after any memory-buffer replacement. The legacy
raw-address free API is setup-only and cannot protect against stale-free ABA;
new code should retain the generation token returned by
`webrc_dsp_alloc_f32_token` and use it for address lookup and release.

The Node suites validate WASM ABI and PCM compute paths without hardware I/O.
They do not include JS/Worklet copy overhead, prove current Chrome's callback
deadline, qualify all FX chains, or substitute for the integrated browser
stress and long-PCM cross-compiler parity gates.
