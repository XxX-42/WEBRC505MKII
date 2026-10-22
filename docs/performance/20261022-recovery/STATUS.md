# Initial source checkpoint (historical status)

Base: 6bf4a2c011f7e9aba46a7bba02b0021873d19b89.

This independent checkout reconstructs only the Browser exact YIN contiguous-frame and early-termination changes, their baseline fixtures, and targeted tests. It does not overwrite the previous checkout. At this initial checkpoint no new build, test, or performance acceptance is claimed. The checked-in generated worklet is still the base version until a later explicitly recorded build.

## Why a new checkpoint is necessary

After approximately 2026-10-22 04:08 UTC, the previous uncommitted production changes, experiment scripts, raw measurements, and temporary builds were no longer visible. Independent checks observed the same base HEAD with no tracked diff. The cause and permanence of that loss were not established. No new commit or push had happened before the visibility failure.

Previous tool outputs reported a successful Browser build and 1129 passing tests, approximately 48.7% lower cost in a five-instance Node main-global worklet fixture, and matching PCM/recursive state. Those are historical observations only. The original evidence files are missing and those counts or timings must not be used as acceptance of this reconstruction.

Historical frozen source SHA-256 values, useful only for provenance comparison:
- liveMono.ts: 1df6ded1abf6178334a22ea509dbd30a9029d02d4acd7da49fc6c5e084b2dd3e
- BrowserRobotDsp.ts: fd50949657d8f7eecae1b3ddd48427bd1354fad212839ee671792ae24b84aad0
- generated fx-processor.js: d438eb0dbcefd1eb6ba2f5052f598d66cc277139f9b5d45bab8831ae96e1c8d5

The native experimental rounded-logcosh table, its original raw certificates and PCM comparisons are not reconstructed here. The isolated Signalsmith raw-previous-spectrum research reported single-tone improvements with mixed polyphonic outcomes and increased CPU cost; its original artifacts are also unavailable. No native quality candidate is promoted by this recovery.

## Persistence and acceptance plan

1. Commit the recoverable source/tests as an explicitly unvalidated checkpoint.
2. Create and upload a recovery bundle before starting expensive validation.
3. Record fresh targeted/full tests, generated build, exact-output comparisons, and separate A/B measurements against this checkout's base.
4. Persist each successful milestone with an incremental commit and recovery artifact.

No Git push, user-machine operation, hardware sound-quality claim, or XRUN certification is included.

## Current recovery validation

Fresh targeted tests, build, and post-build full unit results are recorded in VALIDATION.json and the accompanying logs. Fresh actual-worklet A/B measurements and a candidate-only CPU profile have also completed. See browser-main-global-ab.json and browser-main-global-profile-proof.json. Historical timings remain historical and are not substituted for these new measurements.
