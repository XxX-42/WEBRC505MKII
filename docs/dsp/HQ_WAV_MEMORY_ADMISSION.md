# HQ_RENDER export memory admission

HQ_RENDER export applies a UI-side estimate before making a Browser channel
copy or starting its render Worker, and before sending the Native render request
that causes the C++ host to snapshot and render. The default per-export budget
is 512 MiB. The Track Strip may pass a larger `memoryBudgetBytes` value to
`exportHqWav` when the user raises its export memory budget; raising the budget
does not change loop content or output duration. Native also performs a
separate C++ admission estimate before allocating the pinned snapshot or
renderer output.

The estimate includes:

- one Browser worker input copy; for Native, a conservative triple-input-sized
  reserve plus rendered PCM, UI-side deinterleaved channels, and encoded WAV
  buffers (the Native PCM response and its little-endian Float32 view share
  storage)
- Browser rendered output plus a conservative two-second latency reserve at
  the selected sample rate; the Native renderer returns an exact-duration
  interleaved Float32 response with zero reported leading latency
- the known bounded Signalsmith chunk buffers for Browser
- a 64 MiB WASM/runtime reserve
- two encoded WAV-sized buffers for the encoder result and its transferable
  worker copy

An over-budget export is rejected with the estimated and configured sizes and
an instruction to raise the budget or reduce loop length. Rejection does not
clear, shorten, detach, or rewrite the recording. Browser's Worker repeats its
guard before calling Signalsmith. Native's UI checks small metadata first,
then sends the request only after admission; the C++ host independently checks
the configured budget before capturing the loop and invoking Rubber Band. The
Native host estimate accounts for three input-sized terms, two rendered-output
terms, and a 64 MiB process/runtime reserve. Neither estimate is an OS memory
cap.

This is an estimate of known export working buffers, not an OS memory quota.
Actual process use also depends on browser/WASM allocator growth, the Native
host's Rubber Band working set, the resident loops, concurrent tabs, and
available device memory. A user-raised budget can still exceed what the current
browser/device can allocate. RIFF's 32-bit chunk limit and renderer
sample-rate/rate limits continue to apply; export never silently truncates to
fit the budget.
