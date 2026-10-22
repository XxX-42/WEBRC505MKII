# Browser recovery verification evidence: 68106c1

This directory records a fresh, full verification of the unchanged source commit `68106c18deddb7a49a45b2f9ffb7266b3a78c8f7` and tree `d7c13103a33a752fd505bcc14f5f0e8cef8f67c5`, run on 2026-10-20 from 01:09:33 UTC to 01:15:30 UTC. Start/end snapshots show the same HEAD/tree and no tracked diff.

## Exact-tree run

- `npm run build`: exit 0; vue-tsc, worklet bundle, Vite production build, and exact third-party notice verification succeeded.
- `npm test`: exit 0; 145 test files and 1085 tests passed.
- `npm run test:e2e:rubberband`: exit 0; strict serial Chromium E2E 99/99 passed in 4.6 minutes with explicit Native no-audio simulation host.
- Raw stdout, stderr, exit codes, the runner's Playwright last-run file, browser/host paths and SHA-256, machine/TMPDIR metadata, and start/end source identity are retained here.
- The current test emitted `Post-suspend capture retries {"attempts":1,"rejectedForwardGaps":0,"diagnostics":[]}`. This is one successful resumed take in this run. It does not prove continuity across any forward gap and does not establish audio hardware/XRUN performance.

## Historical summary reconciliation

`verification-68106c1.json` is preserved byte-for-byte from the earlier recovery report (SHA-256 recorded in `SHA256SUMS`). It mentions an earlier 128-frame forward gap. That detailed gap is separately extracted into `reported-128-frame-gap.json` and explicitly marked summary-only: no matching raw runner transcript/trace was found in the available artifacts, and this fresh run did not reproduce it.

The only available timestamped 98/99 and 99/99 full-suite transcripts in the prior readiness folder are from the earlier `e48305a` batch, not commit `68106c1`. Its 98/99 raw log records a resumed capture not-ready failure, not the 128-frame gap; its 99/99 success log predates the retry-loop source currently in `68106c1`. Those logs are already preserved in the repository's earlier `e48305a` history and are deliberately not represented as current-run evidence.

No cause for the earlier reported frame gap is established. This evidence does not attribute it to callback loss, timestamp misalignment, AudioContext lifecycle reset, or cloud scheduling. No production capture behavior was changed in this verification run.

The browser was Google Chrome for Testing headless shell 154.0.8037.57; the Native E2E component was the explicit simulation executable. No physical audio device was used.

The pre-run Playwright artifact directory was copied before the suite because Playwright reuses `test-results/`. After the run, that backup was moved intact to `/workspace/shared/rc505-recovery-20261018/checkpoints/test-results-before-reverify-20261020T0109Z/preexisting-test-results` (SHA-256 inventory beside it); the exact current run is represented by this directory's raw stdout/stderr and `strict-e2e-playwright-last-run.json`.
