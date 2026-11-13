# Classic control and LCD alignment — 2026-11-14

Base: `c543c67421456fc894d19a963364bc7d7c4e1bf9`. This integrates the existing Native PAN, FX Play and confirmed-knob work in the same preserved worktree. It does not assert physical RC-505 parity.

## Changes

- FX EDIT + A–D accepts the second touch only on controls supporting the chord. Ordinary presses still toggle effects; editing does not enable an effect.
- All seven Play screens share MEMORY / unassigned / unassigned / unavailable Master Reverb encoder roles. Five-track readouts remain five-track readouts.
- LOOP uses explicit 3+4 pages. MENU uses 3+4+2; the middle grouping is an engineering interpretation of documented category order, not a photographed hardware claim.
- Parameter editors use four columns and real-value pixel dials. Rhythm labels omit redundant prefixes. Full field names/reasons can be read inside the LCD and EXIT restores focus.
- TAP long hold restores the session's previous confirmed tempo. 2000 ms hold and 3 seconds idle are engineering defaults; input timing uses the down timestamp. Context changes invalidate the session.
- Mixer writes coalesce the last target independently per backend identity/channel. Memory operations cannot start while mixer writes/readback are in flight. Failure drops queued targets and performs read-only reconciliation, never retransmitting the uncertain write.
- Relative knobs display confirmed parameter values, independently of interaction targets.

## Evidence boundaries

See [current manual review](../lcd-layout-matrix-20261114.md) for official eng04/chs04/Parameter Guide page references, version corrections and unknowns. The classic alignment tests use real local Chromium and a Native simulation bridge; they are not physical RC-505 acceptance.

Native source hashes still match the earlier compiled PAN binaries. Re-run portable CTest: 55/55, 39.91 s. Re-run HQ/simulation CTest: 18/18, 70.97 s. Real WASAPI binary compilation was verified earlier; execution remains blocked by the previous automatic approval rejection. No physical RC-505 or calibrated LED evidence is available. CPU deadline exceedances remain documented in the PAN performance report.

## Final regression

- Frozen-source unit: **3012/3012**, **240/240 files**, 304.53 seconds.
- Single complete E2E run: **158/158**, zero skips/flaky/retries, one worker, original 30-second timeout; 545.030 seconds.
- Typecheck and production build: **PASS**, 8.24 seconds, six license files verified. Existing >500 kB chunk warning remains.
- Vite watcher scope: **PASS**, source HMR and docs updates work; Native build, benchmark output, Golden Master and capture output remain excluded.
- Local Browser entry: http://127.0.0.1:4198/?audio=browser&ui=classic . Native simulation acceptance uses an isolated UI and bridge, not the user's real audio session.
- [Machine-readable final receipt](regression.json), [visual measurements](measurements.json), [control coverage](control-coverage.md).

The first complete E2E run was 149/158. Eight failures were obsolete selector/page/cancellation assertions; one exposed delayed Browser OUTPUT display readback and was fixed with render-confirmed polling. Earlier failure receipts remain in the PAN validation report. Final green is a fresh complete run, not a union of retries.

Two resolutions (1920x1080 and 1366x768) were checked in isolated local Chromium; final cropped LCD screenshots are alongside this document. A 1 CSS px scroll-size discrepancy in a track-level card had no visible text boundary overflow and remains recorded in the raw measurements. The old before screenshot is retained for comparison. No physical photometric calibration is claimed.
