# Browser 41 frozen product checkpoint

This archive preserves the exact software test inputs; it does not certify the whole implementation contract.

The frozen app directory was built from source-head-7b56238.zip plus 33 overlays. The original 27-row overlay manifest omitted six new TypeScript/test files. The additive v2 manifest supplies them and preserves the original manifest. The base ZIP is preserved byte for byte; it is not claimed to be a raw Git archive because checkout newline conventions differ from the base Git blobs.

The source directory contains the union of the captured app/runtime and unit-test/config inputs, 77 raw WASM build inputs, and the corrected overlays. The original 188-entry capture contains 187 product inputs plus a capture explanation README, which did not exist in the app directory. That README is under evidence/capture-README.md and is not installed into the product. The unit and build logs are archived agent execution; Root independently checked all hashes, source closure, the fetched WASM identity and the Node asset guard. Root did not rerun the 394-second full suite without a code change.

Accepted software evidence: 34 Vitest files / 223 tests PASS; vue-tsc and Vite build PASS; the retained 185-second recording assertions PASS at 16/48 kHz; real Chromium 149.0.7827.55 smoke 74 assertions PASS using synthetic input and sink=none. Both the initial missing-stress-driver failure and the successful rerun are retained. Two COEP blocked-resource console errors remain in the successful browser JSON. Kernel/worklet logs under evidence/wasm are scoped measurements, not hardware or whole-graph realtime qualification.

This checkpoint fixes the actual looper FX control buffer reference and separates Master FX alignment delay from startup-history requirements. Five independent left/right signatures, FX routing, Master FDN/DC transitions, and Memory A/B/A restoration were exercised. Pitch Worker scaffolding has synthetic unit coverage; actual HQ Worker product integration and low-fundamental pitch quality remain pending. Newer live Native 50 FX, typed carrier/MIDI, Native UI controls and HTTP software-host work are intentionally outside this frozen 41 checkpoint.

The product commit preserves raw bytes for all 77 pinned WASM inputs and the 33 overlays. Other captured source/test files may differ from Git only in CRLF/LF; the verifier reports this separately and refuses semantic mismatches. No user aggregate.py or generated code-only Markdown is installed or staged.

Verification from the project root:

    python scripts/review-browser-fx41-checkpoint.py --archive bench/results/browser-fx41-root-checkpoint-20261009T223440Z --repo . --revision HEAD

To rerun the archived product, extract evidence/source-head-7b56238.zip to a fresh directory, overlay source, then npm ci, node scripts/verify-shared-dsp-assets.mjs, npm run test:unit -- --maxWorkers=1, and npm run build. For the browser smoke, set WEBRC_SINGLE_CONTEXT_INPUT=1 and WEBRC_CHROMIUM_PATH to the retained browser version, then npm run audio:smoke:browser. Sink=none and synthetic input do not measure hardware latency. No 30-minute continuity or deadline Gate is passed by this smoke.
