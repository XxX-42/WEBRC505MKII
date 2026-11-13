# Native PAN validation and FX busy visual observation

An isolated Chromium context loaded `http://127.0.0.1:4198/?audio=browser` at 1600×1000 with fake microphone input. The trace records MutationObserver events and requestAnimationFrame computed styles and bounds. Time offsets below are relative to each click start marker (`performance.now()`); IDs are per-run WeakMap identities, not DOM IDs. Before and after are independent contexts. No real Native host or device was exercised.

| Trace | Track | Control (node ID) | Disabled interval, ms | Disabled-frame opacity | Disabled-frame aria-busy |
|---|---:|---|---|---:|---|
| Before | 1 | STOP (24) | 83.70–110.63 | 0.62 | not captured |
| Before | 1 | REC (25) | 83.82–110.69 | 0.64 | not captured |
| Before | 2 | STOP (28) | 55.74–73.41 | 0.62 | not captured |
| Before | 2 | REC (29) | 55.83–73.47 | 0.64 | not captured |
| After | 1 | STOP (24) | 74.64–93.94 | 1 | true |
| After | 1 | REC (25) | 74.67–94.00 | 1 | true |
| After | 2 | STOP (28) | 69.50–93.25 | 1 | true |
| After | 2 | REC (29) | 69.56–93.31 | 1 | true |

After the change, REC and STOP remained disabled during the transition and all sampled frames had opacity 1; aria-busy was added and removed with the temporary disabled state. Each tracked node remained present with unchanged bounds through its own interval; no relevant button removal mutation occurred. The clicked FX button itself still briefly dimmed to 0.64. In the separate after-change no-audio context, all five REC buttons remained disabled at opacity 0.64 and all five STOP buttons at 0.62, with no aria-busy attribute. The screenshots were taken after the transient ended and do not prove the flash; the frame and mutation logs are the evidence.

The final Native PAN source also passed the **Portable Release CTest 55/55** in 39.73 seconds (test assertions forced on) and **HQ simulation CTest 18/18** in 76.33 seconds. These device-free tests do not demonstrate hardware audio behavior. The detailed [JSON evidence](./fx-busy-visual.json) includes event offsets, observed bounds, exact local paths, SHA-256 hashes and sizes for raw traces, screenshots and test logs. Raw traces and screenshots remain in the temporary directory and are not included in this evidence folder.
