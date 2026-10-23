# Independent final visual review

Reviewed 2026-10-23, from the supplied official front reference `../reference.png` (1680 × 920) and newly captured candidate images only. No historical diffs or earlier review conclusions were read. Production source was not changed.

## Capture evidence

- URL: `http://127.0.0.1:5173/?audio=browser&ui=classic`.
- Independent headless Chromium contexts through CLI Playwright; no existing user tabs, permissions, audio start, Memory operations, or loops were touched.
- Browser zoom 100%, deviceScaleFactor 1. App faceplate zoom automatically 100% at 1920 × 1080 and 80% at 1366 × 768. The agreed 80% minimum plus scrolling is not a defect.
- `1920-viewport.png`, `1366-viewport.png`: viewport captures. `1920-face.png`, `1366-face.png`: complete face element captures. `1920-lcd.png`, `1366-lcd.png`: LCD element captures. Images were visually inspected with view_image, including the official reference, 1920 face, 1366 viewport, and 1920 LCD.
- Measured DOM geometry is preserved in `geometry.json`: face 1520 × 846 at (200, 123.84) on desktop, 1216 × 676.80 at (75, 110.84) on smaller viewport. Candidate ratio 1.797 versus reference 1.826, about 1.6% relatively taller. This is a measured proportion difference, not a claim of perceptual severity.

## Ranked discrepancies

Only rows marked **Recommend** meet both high-impact and high-confidence criteria. Remaining rows document the Top 10 observations without recommending speculative changes.

| Rank | Visible discrepancy | Impact | Confidence | Minimal fix / disposition |
| --- | --- | --- | --- | --- |
| 1 | Reference has a long red top accent with red central model banner and a complete rear-connection label row; candidate has a plain raised gray title strip. | High | High | **Recommend:** reproduce the red stripe silhouette and connection-label row as static faceplate decoration. |
| 2 | MENU/LOOP, ALL START/STOP, UNDO/REDO, TAP TEMPO and rhythm START/STOP lose the reference's broad capsule silhouettes and inset end-button construction; candidate uses small rectangular keys. | High | High | **Recommend:** change outlines, corner radius and internal label/button proportions while preserving hit targets and behavior. |
| 3 | Large FX knobs lack the reference's prominent outer silver arc, scale and layered circular housing; candidate looks like a single textured disk. | High | High | **Recommend:** add static outer arc and housing layers; increase apparent diameter roughly 10–15%, checked against available spacing. |
| 4 | Official BOSS wordmark includes the square emblem and large upright block lettering. Candidate uses small italic plain text. | High | High | **Recommend:** use an accurate authorized mark or a faithful vector/text treatment with emblem and correct proportions. |
| 5 | Reference LCD is saturated deep blue with large white memory number/name; captured candidate is pale blue with dense dark diagnostic/data rows. | High | High for appearance; state equivalence unverified | Do not imitate the specific reference Memory01 state without verifying the corresponding application screen. A matching screen/state capture is needed before changing LCD hierarchy or palette globally. |
| 6 | Reference transport rings and FX/TRACK keys are brightly colored; captured candidate controls and rings are mostly gray. | High | High for appearance; state equivalence unverified | No cosmetic recommendation: candidate explicitly says browser audio is not initialized and tracks are empty; reference illumination state is unknown. Do not fake active lighting. |
| 7 | Upper A–D FX keys are circular flat disks with small lettering; reference keys have thick concentric light-ring construction and larger inset letterforms. | Medium | High | Consider static concentric rim and letter geometry only; active colors must remain state-dependent. Not high-impact enough to recommend in this pass. |
| 8 | Candidate upper area is split into three visibly different dark rectangular panels; reference reads as a continuous dark metal surface. | Medium | High | Consider reducing background tonal seams while retaining control groups. No high-impact recommendation. |
| 9 | Reference bottom track bays have substantial beveled perimeter edges and a stepped silhouette; candidate is a flatter uniform rectangle with thin vertical separators. | Medium | High | Consider static bevel and outer corner geometry. No high-impact recommendation. |
| 10 | Candidate track numerals are narrow upright text; reference numerals are wide stylized hardware glyphs. | Low | High | Optional local font/glyph adjustment; no high-impact recommendation. |

## Limits

This is an independent visual review of Browser Classic before audio initialization, not a matched hardware operating-state comparison. No transport, FX, fader or Memory state was changed to imitate the reference. The default Native page was initially observed, then excluded from the review after selecting the explicit Browser URL in a fresh context. Screenshot loading is not a cold-start timing measurement. Photometry, calibrated luminance, color difference, pixel-registration error and physical hardware dimensions were not measured. No claim is made about audio, DSP, physical-device behavior, or runtime test coverage.
