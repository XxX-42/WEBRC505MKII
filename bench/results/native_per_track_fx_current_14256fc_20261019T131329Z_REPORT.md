# Native per-track FX callback profile (current-source diagnostic)

Run ID: `native_per_track_fx_current_14256fc_20261019T131329Z`
Source: `14256fcf2ad540a9aacea215c31c632fd4b395a2`
Scope: opt-in portable Linux CPU callback simulation; no RtAudio device, hardware, driver, physical XRUN, or acoustic latency was measured.

## Workload and build

- Release benchmark target `native_per_track_fx_bench`, built from this source tree with GNU C++ 14.2.0 and CMake 4.2.0
- `-O3 -DNDEBUG -std=c++17 -Wall -Wextra -Wpedantic -Werror`; `NATIVE_PORTABLE_TESTS_ONLY=ON`; Rubber Band HQ disabled; experimental PREAMP ADAA disabled
- 48 kHz, stereo output, 64-frame callbacks, 1.333333 ms callback deadline; five 300-second stereo loop buffers with synthetic per-track sine content
- A 330 Hz, 0.1-amplitude mono sine callback input; 5,000 warm-up and 100,000 measured callbacks
- All 20 A–D per-track slots configured (IDs are recorded in the raw JSON). Track A–D chains are processed before the common output stage
- Mono and poly pitch processors are prepared, but no pitch route is enabled or measured. Input FX bank is prepared but no input slot is configured. Rhythm is prepared/configured but not enabled. This is a 20-track-FX callback profile, not the complete Native feature graph
- The common output stage is in the callback path. Its default chorus/phaser/reverb settings are disabled with zero wet, but `NativeOutputStage::processInPlace` still invokes their processing routines per frame. This is included in the measured runtime. Skipping stateful disabled processors is not an accepted optimization without proving the intended state/tail/re-enable semantics

## Uninstrumented current-source result

Raw data: `native_per_track_fx_current_14256fc_20261019T131329Z.json`
Metadata: `native_per_track_fx_current_14256fc_20261019T131329Z.meta.txt`

- Mean 518,167 ns; P50 467,012 ns; P95 774,794 ns
- P99 1,388,236 ns, above the hard 1,333,333 ns deadline; P99.9 3,174,460 ns; max 12,370,669 ns
- 1,085 of 100,000 callbacks exceeded the hard deadline; finite output 12,800,000/12,800,000 samples; zero faulted FX slots
- Result: this portable simulation fails the hard-deadline check and any stricter P99/P99.9 targets

The same-topology historical file `native_per_track_fx_f7bee1d_noscan_20261018T1652Z.json` reported 466,332 ns mean, 811,551 ns P99, 2,439,209 ns P99.9, and 284 deadline misses. These are two separate runs at different times/build histories, not a controlled A/B; the difference does not establish a code regression or an external-load cause.

Host metadata captured for this run: Linux 6.18.55 x86_64, AMD EPYC 9V74, 9 online processors reported, load average 0.33 before and 0.77 after. No accessible cgroup CPU accounting files were present, and the container process list did not expose host-wide competing jobs. External contention therefore cannot be ruled in or out.

## Instrumented hotspot diagnostic

A separate `-pg -fno-omit-frame-pointer -O3` build of the same source and workload was run at 13:16:18 UTC. Its output is **not callback timing acceptance data**; profiling overhead changed the measured mean to 589,679 ns. GNU gprof’s largest flat-profile entries were:

- Phaser processor: 12.13% sampled time
- FDN16 reverb processor: 12.00%
- `antialiasedTriode`: 8.78%
- PREAMP: 7.10%
- `dsp::lagrange4`: 4.44%
- `ParameterSmoother::next`: 4.34%, 2.02 billion reported calls
- LooperCore: 3.66%
- Distortion: 3.63%

Profile: `native_per_track_fx_gprof_current_14256fc_20261019T131618Z.gprof.txt`; profiler-run JSON and metadata have the same run ID. Some gprof call-graph counts attribute an OSC BOT destructor to the distortion processing path despite no OSC BOT slot in this workload; that attribution is inconsistent with the source graph and is excluded from optimization conclusions. The relative profile identifies possible investigation areas, but does not by itself justify changing DSP or effect semantics.

## Next measurable gap

This run does not include active pitch. A separate explicit LIVE_POLY-selected-track benchmark is needed before claiming a Native full-runtime/pitch cost. Current Native software callback timing fails in this profile. Physical audio-device XRUN, acoustic/round-trip latency, and hardware acceptance remain unmeasured.
