# Native/Web TD-PSOLA ratio parity

This immutable archive compares the same shared TD-PSOLA implementation compiled as the frozen Native MSVC library and the pinned WebAssembly module. It contains the complete Native fixture/source snapshot, the exact WASM module and build manifest, the comparator source, the comparison JSON, and all 36 WASM PCM output sidecars.

The Native manifest contains 36 records: six offline whole-buffer kind-109 runs and 30 streaming kind-110 runs (six ratios × five callback schedules). Every case uses the same 15,360-frame mono input at 48 kHz. Streaming schedules are uniform 64, 128, 256, and 512 frames plus a mixed 64/128/256/512 sequence. The streaming latency getter is 0 input samples and 1,200 output samples; the offline renderer makes no streaming-latency claim.

All 36 Native/Web output vectors matched sample-for-sample: maximum absolute error 0, RMS error 0, and no non-finite output. WASI fd_close/fd_write/fd_seek counters remained 0. The comparator verifies the WASM artifact SHA, the 60-input WASM build manifest and source-set digest, the Native manifest and source-file manifest hashes, the recomputed Native source-tree digest, all seven copied Native source files, every overlapping Native/WASM source hash, and each Native input/output sidecar before processing.

This is cross-build PCM parity evidence for these PSOLA fixtures. It does not qualify listening quality, the combined live YIN-to-PSOLA route, realtime deadlines, or the full application graph.
