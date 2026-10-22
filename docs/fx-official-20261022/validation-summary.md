# Final verified FX-parameter delivery

2026-10-22 UTC. Both Browser and Native: **252 functional clean-room rows + 4 partial source-mode rows + 11 unsupported**, covering the 267 official manual parameter rows across 53 families / 55 variants. This is not complete Roland algorithm or hardware sound equivalence. The final software correction below closes the known mono-spatial issue recorded in the historical checkpoint.

- Native official opt-in now preserves two-channel processing through the Input FX bank even when the source is mono. AUTO PAN, PANNING DELAY and CHORUS produce actual stereo PCM equal to explicitly duplicated-stereo input. AUTO PAN rate/depth/waveform alter audio. STEREO ENHANCE is tested against existing side information generated upstream in that same bank, not a fabricated mono-to-stereo promise.
- Legacy mono PCM remains bit-identical under transport-only broadcasts. Invalid official edits do not activate official mode. Variant opt-in is recognized. The tested callback route performs no allocations; this is a bounded test, not a universal real-time or XRUN guarantee.
- Final strict Native build: **52/52 portable CTest**, 23.36 seconds; simulation build: **5/5 HTTP CTest**, 5.84 seconds. Logs are `validation-logs/final-native-*.log`.
- Unchanged final frontend sources passed **182 files / 2,311 tests**, 96.68 seconds, and the complete production build. Logs are `validation-logs/native-carrier-full-unit.log` and `native-carrier-frontend-build.log`. All correctness processes use CPUs 0–5; durations are not performance measurements.
- Final cloud preview root, current app module and FX worklet returned HTTP 200; server stopped. This is only an HTTP asset smoke, not browser audio acceptance or user-machine deployment.
- Final Native published schema remains SHA256 `94d17a653d3a27a7bef6e0c13404f365db1ed1c0fd0174aced28b045e6fee3a1`, 53 families / 266 runtime descriptors. Coverage CSV matches that schema. Thirty tempo rows explicitly lack a documented complete intermediate-note enumeration.
- Remaining limitations are undocumented MODE semantics, unavailable factory phrase/pattern contents, unsupported CARRIER THRU and unmapped or unsupported source modes. See `delivery-report-zh.md`, `coverage-summary.md`, and each CSV row. No empty successful controls substitute for these limitations.
- Git bundle recovery was checked by cloning the preceding integrated carrier checkpoint into a fresh directory and running full git fsck. The final bundle is separately verified. No remote push or overwrite was performed.

# Historical checkpoints (not additional current acceptance)

# Native track-carrier integration checkpoint

2026-10-22 UTC. Both backends: **252 functional + 4 partial source-mode rows + 11 unsupported**. Functional counts describe supported clean-room software controls, not hardware parity. This intermediate checkpoint has a known Native mono-input spatial-routing issue (AUTO PAN and other spatial processors); the separate correction is pending and must not be represented as fully validated mono operation.

- Frontend complete regression: **182 files / 2,311 tests passed**, 96.68 seconds; production build passed including TypeScript, worklet, Vite and six license files. CPU affinity 0–5, two workers; correctness timing is not a benchmark.
- Strict portable Native build and **52/52 CTest passed**, 23.88 seconds. Simulation build and **5/5 HTTP tests passed**, 7.12 seconds.
- Native VOCODER TRACK1–5 uses a same-callback playback-only preview of finalized loops. No actual playback cursor mutation, no internal-oscillator fallback and no added whole block. Explicit mono-modulator/stereo-carrier regression keeps right-channel carrier sound.
- Recording, overdubbing, live pitch processing, history pinning, unavailable buffers, empty/stopped loops and oversized callback splitting are explicitly silent with published carrier-status diagnostics, not represented as supported live sources. Physical carrier selections and THRU remain unsupported.
- Public Native frontend validation now honors the host's narrower published domain, so manual-valid but unavailable physical carrier values cannot be falsely acknowledged. UI choices come from that same host descriptor.
- Published schema: 53 families / 266 runtime descriptors; SHA256 `94d17a653d3a27a7bef6e0c13404f365db1ed1c0fd0174aced28b045e6fee3a1`. The 267 manual-row matrix is a separate count.
- This checkpoint is independently recoverable while the final mono-spatial routing correction is developed. No push, user-device execution, physical hardware audio or XRUN claim.

# Browser carrier integration checkpoint

2026-10-22 UTC. Browser: **252 functional + 4 partial source-mode rows + 11 unsupported**. Native frozen at `bc738d1`: **252 functional + 3 partial source-mode rows + 12 unsupported**. Native carrier work is not included in this checkpoint. All functional controls are clean-room implementations, not Roland hardware sound certification; 30 tempo rows have only documented note endpoints rather than an invented complete intermediate enumeration.

- Final frontend regression: **182 files / 2,307 tests passed**, 94.88 seconds, CPU affinity 0–5 / two workers. This is correctness-run time under shared load, not a performance benchmark. Earlier failed attempts were corrected; this result is the complete rerun.
- Production build passed: TypeScript, AudioWorklet bundle, Vite and six exact license files. Cloud preview root, app JavaScript and FX worklet returned HTTP 200, then the preview stopped. This is a cloud HTTP asset smoke, not user-machine deployment or physical audio verification.
- VOCODER TRACK1–5 carriers now use the actual playback-only track bus on AudioWorklet input 1. Shared Input, shared Track and private Track routes use the real graph, including recovery adoption. Stopped/empty/cleared tracks are silent, not replaced by an internal oscillator. Monitor audio is excluded to prevent the input-monitor feedback path.
- Shared-bank legacy VOCODER percentage mix and legacy carrier PCM remain compatible. Recovery preserves 107 BPM / 7/8, canonical OSC VOC fields and DIST identity. RADIO no longer clamps engine BPM to 100; BPM messages retain the sparse configure contract.
- The full suite includes 42 carrier-specific cases and the 158-case control/recovery sweep: 51 non-source effects, 157 route/variant snapshots and 801 official parameter addresses per authoring pass. The sweep uses mock audio/control boundaries; separate tests establish carrier PCM behavior. Neither is hardware or listening certification.
- Physical carrier inputs and CARRIER THRU remain unavailable. Undocumented alternate MODE algorithms and factory phrase/pattern banks remain explicit unsupported rows. See `coverage-summary.md`, the row-level CSV and `api-contract.md`.

Evidence: `validation-logs/browser-carrier-{full-unit,build,startup}.log`.

## Historical checkpoint below

# Control correctness follow-up checkpoint

2026-10-22 UTC. Coverage is unchanged: Browser 252 functional + 3 partial source-mode rows + 12 unsupported; Native 249 functional + 1 partial live-stream row + 17 unsupported. These remain clean-room implementations, not Roland hardware sound certification.

- Full frontend regression: **179 files / 2,088 tests passed**, 49.16 seconds. Production build passed, including TypeScript, AudioWorklet bundling, Vite and six exact license files. These timings are correctness-run wall times under shared load, not benchmarks.
- Native: **52/52 portable CTest targets passed**, 26.18 seconds; **5/5 simulation/HTTP targets passed**, 6.29 seconds. Extra strengthened FREEZE balance-transition test also passed.
- Native FREEZE now retains its held sound across repeated legacy macro snapshots, and official BALANCE/SUSTAIN have actual ramps. TAPE, ROLL and both SLICER catalog routes forward the requested ramp length; output tests verify a 100-frame transition.
- Native full-snapshot replacement now safely clears omitted controls and stale variant state when stopped. Live deletion is explicitly rejected as requiring stopped audio, without a false ACK or automatic engine stop. Patch-only external clients keep legacy behavior; capability negotiation prevents newer official UI controls from silently using an older unsafe host.
- Actual published schema is exercised through all 52 family/variant public-editor cases, with domains and defaults checked. HRM AUTO (M) is now selectable rather than silently omitted from the Native label map.
- ROBOT Browser latency metadata now reports the existing PSOLA engine delay instead of zero: 1,416 samples at 48 kHz (29.5 ms). Eighteen regression cases cover 11 sample rates, mode changes, reset and dry/bypass semantics. DSP audio processing is unchanged; host alignment, pitch-tracker acquisition and physical I/O delay are separate concepts.
- No Git push, user-machine deployment, hardware listening, physical I/O measurement or XRUN acceptance. The latency comparison retains its separate frozen baseline/current pair.

# Integrated fourth checkpoint

2026-10-22 UTC. Browser and Native parameter implementations are separately validated and now integrated.

- Browser: 252 functional clean-room manual rows, 3 partial source-mode rows, 12 unsupported.
- Native: 249 functional clean-room manual rows, 1 partial live-stream row, 17 unsupported. Actual host schema publishes 50 families, 258 DSP keys and 2 routing selectors. Source rows and runtime key counts intentionally differ because STEP LEVEL has 16 indexed addresses and variant families share keys.
- Native new batch: TAPE ECHO1/2, ROLL1/2, PATTERN SLICER, STEP SLICER, TWIST and FREEZE. Portable CTest 52/52 passed (21.71 seconds); complete HTTP simulation 5/5 passed (5.10 seconds). Variant validation is atomic and uses explicit variant-first application.
- The sanitized tested host schema is native-runtime-schema.json, SHA256 1a2c9fbfed7fc529573beafd02176f43b8c23d65e6d8aa1f4875272e0a61d676. Coverage CSV is generated from this exact schema, not inferred from descriptor regex.
- Browser full suite remains 176 files / 2,013 tests passed; production build passed. Subsequent cloud startup independently served root, app-DGzluriK.js and fx-processor.js with HTTP 200. Server was stopped after the smoke check. This is not user-machine deployment.
- Native TAPE/ROLL add 3.30/2.20 MiB of preparation-time allocation per instance at 48 kHz, including legacy preparation; no universal memory-budget claim.
- Both streams continue independently from the separate version-frozen latency comparison. No hardware audio parity, physical I/O delay or XRUN acceptance is inferred from these functional tests.

## Earlier fourth Browser-only checkpoint


2026-10-22 UTC. Browser implementation is frozen and validated; concurrent uncommitted Native DSP work is deliberately excluded from this checkpoint.

- Browser: 252 functional clean-room manual rows, 3 `partial_source_modes`, 12 unsupported, out of 267 documented rows.
- Native DSP remains the prior verified 136cf02 source: 207 functional, 1 `partial_live_stream`, 59 unsupported. This is not a fresh Native DSP test claim.
- Full Vitest: 176 files / 2,013 tests passed in 34.40 seconds. Production build passed (vue-tsc, AudioWorklet, Vite and all six required license files).
- New Browser batch: 258 per-control audio behavior tests, 13 Reverse Reverb tests, source-routing tests; final source/tempo/boundary/legacy TrackAudio group 60 passed, counted-delay group 29 passed. Frontend domain/routing group: 26 passed.
- Reverse Reverb uses a real rising-tail processor. Pattern Slicer adds functional timing/envelope/compression controls without pretending to implement the undocumented P01–P20 factory pattern bank.
- Shared Track A BEAT SHIFT reads the actual loop buffer at future/past phase; VINYL uses the real source playback rate, including sustained 2x. Tests prove +0.5 second source offset, past wrap to 1.5 seconds and playback-rate destination 2x. Private chains and causal live-stream adapters reject these official source fields.
- Source effects remain `partial_source_modes`: reverse/live-pitch/overdub combinations are not supported. Transport phase offset is not physical audio I/O latency.
- Official auxiliary tempo is bounded to 40–300 BPM (non-finite fallback 120), while legacy project clock semantics are unchanged. Out-of-domain legacy project tempi are not claimed as exact official beat synchronization.
- Browser counted-repeat storage is bounded to 51 seconds, 18.68 MiB per stereo instance at 48 kHz (double at 96 kHz). Configuration can still allocate on the AudioWorklet message thread. This does not establish strict real-time allocation or multi-slot memory-budget acceptance.
- No push, user-machine deployment, physical latency, hardware listening or XRUN acceptance was performed. The separate latency comparison uses an explicitly frozen version and is not represented by these correctness tests.

## Prior third-checkpoint evidence


2026-10-22 UTC, dot cloud only. No push, user-machine deployment or hardware audio/XRUN acceptance.

- Browser functional source rows: 236; unsupported: 31.
- Native functional source rows: 207; partial_live_stream: 1; unsupported: 59. Published interface: 44 effects / 208 controls.
- Browser core-focused group: 501 passed; meter/routing group: 111 passed; latest scope/variant/bank group: 45 passed.
- Native portable CTest: 50/50 passed. Simulation: 5/5 passed, including full legacy HTTP and all 208 official control live updates.
- Final full Vitest: 172 files / 1,943 tests passed in 59.82 seconds. Production build passed, including vue-tsc, AudioWorklet bundle, Vite and required license verification. A previous exact-message test missing the new BPM field was corrected without altering DSP.
- Input/shared Track panels in both layouts now expose implemented official controls alongside preserved dedicated legacy editors. Panel-focused group: 40 tests passed. Native applies remain ACK-aware.
- Cloud production-preview startup: root app shell and bundled JavaScript served HTTP 200 on loopback. This is cloud startup only, not user-machine deployment.

MEAS propagation is now verified for non-4/4. Native VINYL currently reads bounded live history and is not source-aware loop playback. Unknown manufacturer MODE/phrase/pattern tables, independent VOCODER carrier routing, Memory archive FX inclusion, complete MIDI assignments, physical latency/sound/XRUN and real user-machine deployment remain separate gaps. No old test count is represented as a new full acceptance.

Native counted-delay storage is preallocated for 51 seconds, 18.68 MiB per instance at 48 kHz. The 16th half-note repeat at 40 BPM arrives at 48 seconds, with no 17th repeat. See native-validation.md for dependency provenance, test logs and real-time constraints. PREAMP/DYNAMICS presets and voice models are independently authored, not measured Roland factory models. Last four Track-only effects admit official controls only in Track A under the implemented MULTI bank mode; legacy extension-only routes are preserved.
