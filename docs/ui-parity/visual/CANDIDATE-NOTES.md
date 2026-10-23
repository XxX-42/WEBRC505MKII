# Visual candidate evidence (2026-10-23)

The complete official frontal reference is `reference.png` / `official-front.png` (1680 x 920). `reference-scene.png` is not used as a geometry oracle. Source URL and source SHA-256 are retained in `official-front-source.json`; PNG SHA-256 is recorded in `measurement.json`.

Two CSS rounds were captured from the isolated Vite server on port 5188: `candidate-before`, `candidate-round1`, and `candidate-after`. Each includes 1920 x 1080 and 1366 x 768 full-page browser captures, face crop, LCD crops, and actual DOM bounding boxes. `candidate-before/overlay.png` and `candidate-after/overlay.png` blend the complete frontal reference after global normalization to the fixed 1520 x 846 face.

High-confidence changes: lower track numerals, larger stop discs and halo silhouettes, longer/wider physical fader wells/caps, rounded FX/TRACK cap silhouettes with perimeter lenses, reduced LCD shell dimensions, larger FX slot buttons, silver divider, and INPUT FX/TRACK FX heading placement. Only CSS changed; the 41 button / 7 knob / 5 fader control model, handlers, audio state, and DSP were not edited.

Calibration is UNMEASURED. The photograph has projection and enclosure-edge uncertainty. Global affine normalization is a comparison aid, not a calibrated control-center map. There is no assertion that all controls meet a 4 px threshold. RGB/luminance/bloom are UNMEASURED engineering approximations, and no hardware timing or blink behavior was inferred from a still image. Startup screenshots show disabled/uninitialized browser audio; the catalog photo shows illuminated hardware in another state, so color comparison is not a state-equivalent validation.

Remaining visible differences include top MENU/LOOP and navigation control silhouettes, official branding/type, exact LCD content and color, cap textures, and illuminated-state appearance. Independent review has not cleared the candidate at this commit. No physical hardware was used.

Validation: `npx playwright test rc505-classic-parity.spec.ts --config playwright.visual.config.ts --reporter line`: 7 passed (35.3s). Includes LCD navigation, FX ordinary/chord/hold/bank interactions, virtual-input recording/play/overdub/stop/undo/clear, fixed-layout zoom >= 80%, and 1920 x 1080 / 1366 x 768 viewport checks. This is browser/virtual-audio evidence, not hardware parity proof.
