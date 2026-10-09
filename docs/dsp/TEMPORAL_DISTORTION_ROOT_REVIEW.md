# Stereo temporal and distortion processor review

Seven standalone clean-room processors now have implementation and source-level regression evidence: Tape Echo, Granular Delay, Warp, Twist, Roll, Freeze, and DIST. This checkpoint does not mark their registry, Native host, Browser graph, official parameter mapping, realtime deadlines, or final sound quality complete.

Root reviewed the implementations, rejected three defects, and checked the corrected immutable snapshots. DIST previously clipped ordinary high-drive input to ±8 before fourfold oversampling; normal audio now receives linear drive scaling before the antialiasing stages. Tape feedback previously increased tail energy and then used a cap that made much of its control range ineffective. Its corrected coefficient is `requestedFeedback * 0.8 / max(1, 1.5 * drive)`, retaining a monotonic control response with a conservative loop-gain margin. Delay and wow modulation are validated together against the prepared history limit before processing; same-frame updates validate their final pair as one transaction.

## Verified evidence

Root independently checked every original indexed artifact, matched the archived source closure against the current source bytes, confirmed the recorded before/after source maps agree, and reran each archived executable successfully. The producer performed fresh MSVC 19.29.30159.0 Release builds; root's rerun is not an independent recompilation. Original logs and manifests remain unchanged. Each archive includes `root-review-index.json` and `root-test.log` describing this verification scope.

| Snapshot | Exact source files | Original indexed artifacts | Root executable SHA-256 |
| --- | ---: | ---: | --- |
| `shared/dsp/benchmarks/results/temporal-fx-adapters-latency-contract-fix-20261009T163910062Z` | 13 | 34 | `0ddfcd6fc20cbf9876c62f4f575fd983598424895a1c31f685f8f617c8c22ce1` |
| `shared/dsp/benchmarks/results/distortion-fx-maxdrive-fix-20261009T163506248Z` | 7 | 22 | `2edb60d69643c597d2727be6abe7947abe719cf142c884d7e3b30f9831d5746c` |

Root additionally records its own sorted `path=sha256` source aggregates with LF after each entry: temporal `7bc4938df60ad1787e6a47d5566145dfbb2f251fc75fc8b38095af9a8715fec5`, DIST `92a60dac852aebefb6ba7d88043a9f132d1776d55fec9978da557fe02ee16abb`. These use a separate canonical format from the producer fingerprints.

At 48 kHz, temporal output is identical across 64/128/256-frame partitions. Each of its six processors accepts up to 64 ordered sample-offset controls without observed callback allocations or frees. Freeze retains separate 440 Hz and 997 Hz held spectra; opposite-tone amplitudes are approximately 1.73e-8 and 7.26e-9. Warp uses a stereo STFT freeze stage and FDN return, rather than averaging the input channels. Roll captures 3,000 frames for an eighth beat at 120 BPM.

Tape's two-second impulse-tail peak is 0.7174 and late/early energy ratio is 3.83e-10 in the captured fixture. The separate lower/higher feedback fixture yields tail energies 0.1758 and 0.2932. Its 14 kHz test records a fourfold ADAA reference waveform maximum error of 2.65e-5 and folded-energy ratio of 0.00581 relative to the tested onefold reference. DIST similarly records 2.48e-5 reference maximum error and folded-energy ratio 0.00640 at maximum drive. These are specific synthetic fixtures, not universal alias or perceptual quality guarantees.

## Latency boundaries

Freeze and Warp's measured wet impulse onset is 1,024 frames, or 21.333 ms at 48 kHz. Their aligned dry path retains the STFT window latency. Tape allows a 50 ms base delay with up to 8 ms wow excursion, so its declared wet read-head range begins at 42 ms; bounds are checked at 44.1/48/96 kHz. The nonlinear path's frequency-dependent group delay is reported separately. The captured 50 ms, zero-wow fixture's first wet echo is frame 2,416. A tap-delay range, an impulse threshold crossing, and frequency-dependent group delay are distinct measurements.

DIST inserts no whole-sample delay buffer but retains the oversampling filters' frequency-dependent group delay. Granular, Twist, and Roll wet timing is variable. None of these values is an end-to-end device latency or a Browser callback execution percentile.

The realtime and 30-minute integrated stress gates remain unpassed. Earlier unstable-tail and superseded processor snapshots remain available in the working tree; this checkpoint pins only the corrected source closures above.
