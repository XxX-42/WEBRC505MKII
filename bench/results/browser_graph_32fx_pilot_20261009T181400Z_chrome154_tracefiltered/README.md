# Chrome 149/154 short A/B diagnostic

This archive is the Chrome 154 arm of a one-minute software-only diagnostic comparison. It is not a 30-minute stress run, a whole-render deadline measurement, or a Gate 7 qualification.

## Chrome 154 arm

- Browser: Chrome 154.0.8037.99, `C:\Program Files\Google\Chrome\Application\chrome.exe`; SHA-256 `e57b884ec7ddd663a43e3f82f87723e93709766475014ab0e63accd9eb3be7f0`.
- Launch argument recorded by the runner: `--autoplay-policy=no-user-gesture-required`.
- Frozen source snapshot: `bench/results/browser_graph_snapshot_20261009T181300Z_core32_chrome154_tracefilter/`; snapshot-manifest SHA-256 `36c43efa7af3f5998adc2bd3e49cd0c1f9b818aa51db41348bc700866212e327`, source-asset-set SHA-256 `ed8cd7d6b8773d6dc6782e191354c4dc1face025f22a7f86e31fad6143e5e828`.
- Actual fetched WebAssembly: SHA-256 `f670c0dacdc0e7175f8ce821b1040bf1f39eabdce15673d16f5a00212d0b79c6`; it matched the frozen build manifest.
- Browser smoke: 74/74 assertions passed. The pilot reached 74.116 seconds wall time and 3,165,440 unique output frames (65.947 seconds at 48 kHz).
- During the pilot there was one duplicate callback, one 128-frame forward gap, and one XRUN. Shared DSP processing failure delta was zero. This is a timeline failure, so the run is diagnostic-only.
- Filtered Chrome trace: 29,857 AudioWorklet Process events on one audio thread, no trace data loss, P99 940 µs, P99.9 1,152 µs, maximum 1,899 µs; 302 audio-thread GC events. The trace was 32,056,942 bytes uncompressed and took 12,407 ms to collect. The measured scope is AudioWorklet script callbacks only; whole AudioRenderTask duration is not measured.
- The diagnostic workload used five separate stereo tracks with input FX 25+3, track FX 26+29+36+53, master FDN 47, and clean-room rhythm pattern 17 / kit 7. The registry has 32 implemented entries; this does not cover the full 53-entry catalog or three qualified pitch profiles.

## Chrome 149 comparison record

The comparison arm is the existing run at `bench/results/browser_graph_32fx_pilot_20261010T014000Z_idlefix/`. It records Chrome 149.0.7827.55 and the same WebAssembly SHA and shared-DSP source-set SHA as this run. Its smoke record lacks a run-time executable hash and captured launch-argument list. The Chrome 149 executable currently on disk at `C:\Users\user1000\AppData\Local\ms-playwright\chromium-1228\chrome-win64\chrome.exe` hashes to `B798F9E53A98D29EB7F36F8C409F905D3184780A04D2BCB56989067194784BD1`; this is a later file read, not a run-time hash captured by that older record.

The Chrome 149 pilot ran 72.161 seconds wall / 2,913,024 unique frames (60.688 seconds at 48 kHz). Its recorded timeline counters did not increase during that pilot. Its unfiltered trace had 29,267 Process events, P99 1,029 µs, P99.9 1,184 µs, maximum 1,803 µs and 351 GC events; collection took 52,761 ms and produced 335,556,429 uncompressed bytes. Both traces reported no trace data loss. The different trace configuration and lack of a captured Chrome 149 binary hash limit this comparison. The Chrome 154 arm still observed a timeline event, so these short runs do not show that the browser update fixed the discontinuity.

Raw `browser-smoke.json`, `summary.json`, progress and timeline event records, and the filtered compressed trace are retained unchanged beside this report. `archive-manifest.json` hashes every file in this directory.