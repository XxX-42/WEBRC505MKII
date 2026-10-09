# DSP implementation baseline (Gate 0)

Audit snapshot for branch `codex/instrument-grade-audio-20261007`, reviewed against repository HEAD `7acbab0e325c08af17bee38cb7caf6d76116aecb` before this catalog work. This is an evidence baseline, not an implementation claim. Gate0 artifacts are ready for root review; Gates 1–7 have not passed.

## Native signal path

The current Native target is a Track 1 mono `LooperCore` path at 48 kHz with vector buffering capped at 300 seconds. The verified path accepts mono input and copies it to left/right outputs. `NativeAudioCore` separates WASAPI capture/render with SPSC queues; the current bridge can wait for at least two blocks. ASIO is optional. There is no 5-track Native mixer, shared DSP FX runtime, pitch engine, rhythm playback engine, or kit voice pool. A successful LooperCore build is a partial transport/core check, not Gate1.

Fresh evidence from the coordinating audit: `npm run native:verify` completed a fresh MSVC build and CTest **1/1 passed**. Existing C++ test coverage is concentrated on LooperCore transport, clear, and command queue behavior; it does not qualify the requested 53 FX or all DSP primitives.

## Browser signal path

Browser already has a five-track stereo SharedArrayBuffer v4/AudioWorklet path with planar left/right transport and project/history/clock behavior. The Worklet reads the actual output quantum frame count and publishes `LAST_QUANTUM_FRAMES`. It measures process time and increments deadline misses only when `performance.now` is available; availability of that API in every targeted Chrome AudioWorklet context has not been verified. It does not yet publish a callback duration distribution or P99/P99.9. Several surrounding rhythm-delay, calibration, and sink-latency metrics still assume 128 frames even when the Worklet reports actual frame length. Interactive `AudioContext` is 48 kHz.

Existing browser FX are six prototype aliases (`compressor`, `filter`, `delay`, `reverb`, `slicer`, `phaser`), mostly using Web Audio nodes. The compressor prototype has zero lookahead. Reverb uses a generated noise/exponential impulse response with `ConvolverNode`; it is not an instrument-grade FDN. There is no shared WASM DSP backend. These prototypes do not count as full official FX support, cross-platform parity, or completed Gates.

Pitch/time processing is a pure-JavaScript phase-vocoder/FFT path in `public/worklets/time-stretch-core.js` (window 1024, hop 512), also used by project bounce. A previous 8-layer keepPitch smoke reported 6.9–14.9 ms startup, P99 2.08–2.34 ms and max 4.57–8.65 ms, with over-budget risk and no per-callback deadline telemetry. Ordinary five-track play measured P99 0.026 ms/max 0.171 ms in a prior run. Chrome 57 audio assertions passed in that test context; neither measurement proves all-path deadline compliance.

## FX, rhythm and kit coverage

The machine-readable catalog has 53 stable FX IDs, 49 marked Input-capable and all 53 Track-capable; the four Track-only effects are BEAT SCATTER, BEAT REPEAT, BEAT SHIFT and VINYL FLICK. Every full-effect target implementation state remains `not_implemented`; prototype aliases are separately marked partial and unqualified. Candidate topologies/formula IDs copied from the research matrix are proposals, not Roland topology disclosures.

The supplied rhythm matrix has 240 metadata rows: 206 preset rows, 33 GUIDE rows, and one USER slot. Duplicate displayed names are preserved under unique global keys. This does not contain note events or factory MIDI and does not make patterns playable. The 16 official kit names are indexed, but no sound assets, drum voices, or verified kit audio are present. All kit asset provenance/runtime fields remain pending/not implemented.

## Test and benchmark coverage

At audit time the repository had 29 `tests/unit/*.spec.ts` files, two E2E specs, and one C++ test source. Existing tests exercise portions of compressor, browser FX transactions, pitch composite cache, rhythm documentation, and time stretch, among other app behavior. They do not constitute a full 53-FX parameter/quality matrix, full DSP primitive quality matrix, Native/Web parity matrix, or realtime tail-latency gate.

Fresh application verification from the coordinating audit: `npm run build` passed (vue-tsc and Vite, 142 modules). `npm run test:unit -- --maxWorkers=2` produced 175/176 pass; the 185-second accelerated buffer-growth case timed out at 30 seconds under parallel CPU load, with no assertion failure. Immediate isolated rerun of `npx vitest run tests/unit/coreAudioBehaviors.spec.ts --maxWorkers=1 -t 'records 185 accelerated seconds through real chunk growth'` passed 1/1 in 22.936 seconds (25.68 seconds total). A separate 48 kHz/185-second test passed in 92.777 seconds. Do not report the parallel full suite as 176/176 passing.

There is no callback P99/P99.9/max distribution for every Native/Browser audio callback and no 30-minute full-system stress acceptance record. Prior kernel benchmarks in the source package are research evidence only; see [`RESEARCH_ERRATA.md`](RESEARCH_ERRATA.md) for invalid or non-equivalent results.

## License and source boundary

No repository-root `LICENSE`, `COPYING`, or `NOTICE` was found during this audit, so the project’s third-party compatibility boundary is unresolved. The copied source package ZIP SHA-256 is recorded in `dsp/spec/source_manifest.json`; all 36 extracted files matched its supplied SHA256SUMS, and ZIP CRC testing passed. Only four CSV matrices and compact metadata derived from them are included here. The official Roland guide is linked and identified by its PDF hash; its prose and assets are not copied. Parameter extraction is incomplete: an extractor probe hit value-column bleed into Explanation text at RING.MOD/BALANCE, so `official_fx_parameters.json` contains only empty parameter slots and source references. Do not add third-party DSP code, factory sounds/MIDI, or sample assets without a compatible license and per-asset provenance review.

## Gate status and required completion evidence

`dsp/spec/gates.json` is the machine-readable source of gate states and exit requirements. Gate0's audit and metadata prerequisite have been accepted by the coordinator; see [`GATE0_ROOT_REVIEW.md`](GATE0_ROOT_REVIEW.md). This does not qualify any DSP runtime. Shared primitive work may appear in the uncommitted working tree; it does not alter the Gate0 audit snapshot or count as a passed Gate1 until its implementation and tests are reviewed. Gates1–7 are **not passed**. In particular, catalog completeness for FX/rhythm/kits is a metadata property only. A gate passes only after the actual Native and Browser runtime paths, measured performance, quality tests, and required state/automation behavior are evidenced.

## Reproduce metadata validation

From the repository root, run:

```powershell
python dsp/spec/build_catalog.py
python dsp/spec/validate_catalog.py
```

The builder verifies pinned CSV SHA-256 inputs before writing JSON. The validator checks stable IDs, counts/classification, formula references, no fabricated playback data, legal asset placeholders, and requires evidence for any future runtime qualification. Builder regeneration preserves FX implementation-state fields. It does not run audio or pass performance gates. The audit has no hardware end-to-end result; current evidence is software/build/test scope only.
