# Signalsmith HQ_RENDER synthetic objective measurements

**Classification:** objective regression/measurement only. These synthetic fixtures do not establish sound-quality acceptance, listening quality, device performance, hardware behavior, or Roland fidelity.

- Exact command, from `WEBRC505MKII`: `./node_modules/.bin/vite-node bench/run_hq_render_quality_measurements.ts`
- Implementation: production `renderPitchOffline` in `src/audio/pitch/signalsmith.ts`, backed by the pinned Signalsmith Stretch WASM
- Environment: Node.js `v24.19.0`, Linux x64, kernel `6.18.55`; no browser AudioWorklet or audio device was used
- Run settings: 2.4 s/channel synthetic inputs; `HQ_RENDER`, +7 semitones, playback rate 1, 128-frame chunks; 44.1 and 48 kHz
- Raw measurements: [`hq_render_quality_measurements_2026-10-17.json`](hq_render_quality_measurements_2026-10-17.json)

## Method

The harness has no random inputs and imports the production renderer directly. Dominant pitch is the largest Hann-windowed FFT power peak within ±22% of the expected output fundamental, with parabolic interpolation of log power. Pitch, stereo, and formant metrics use a 1-second steady-state window beginning 0.55 s into the latency-aligned render; the FFT is zero-padded to the next power of two. The transient fixture is an 18 ms, four-partial decaying burst at 0.8 s; alignment uses its energy centroid over a ±120 ms region after removing the renderer's reported leading latency, and overshoot is output/input peak absolute amplitude. Stereo coherence is zero-lag Pearson correlation in the aligned 1-second window with no lag search. The vowel-like source is a 110 Hz harmonic stack with synthetic Gaussian spectral bands centered at 650, 1,200, and 2,500 Hz; movement is reported as change in integrated FFT power ratio between each source band and its +7-semitone counterpart (each ±18%). This last metric is not a formant-preservation score; the offline renderer API has no independent formant-preservation control.

## Results

| Sample rate | Dominant output pitch | Signed cents error | Transient centroid alignment error | Peak offset from expected onset | Peak amplitude ratio | Input → output stereo correlation | Relative movement toward shifted formant bands (F1/F2/F3) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 44.1 kHz | 329.875420 Hz | +1.3013 cents | −0.03168 ms | +0.04535 ms | 0.85393 | 0.605820 → 0.605579 (Δ −0.000241) | +23.50 / +18.78 / +42.36 dB |
| 48 kHz | 329.504051 Hz | −0.6488 cents | −0.03088 ms | +0.37500 ms | 0.87812 | 0.605820 → 0.605990 (Δ +0.000170) | +23.28 / +18.58 / +42.25 dB |

The band-energy changes are consistent with energy moving toward the pitch-shifted regions in this synthetic fixture. No pass/fail thresholds are applied; the measurements are not a feature-quality admission decision.
