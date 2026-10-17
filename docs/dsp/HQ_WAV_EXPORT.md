# HQ_RENDER WAV export

The Track Strip exposes an offline `HQ_RENDER` WAV flow in Browser and Native
runtime modes. It accepts pitch shift (−24 to +24 semitones), playback rate
(0.5–2), and PCM16, PCM24, or Float32 WAV. Browser uses pinned MIT-licensed
Signalsmith Stretch 1.3.2 in a module Worker. Native requires the optional C++
Rubber Band R2/R3 renderer; it uses a metadata preflight, then submits a
callback-pinned loop to the C++ offline endpoint. The Native endpoint is
disabled by default at build time and reports unavailable explicitly when it
is not linked. It never substitutes Signalsmith, varispeed, or a silent path.
Neither renderer runs on the audio callback.

The Browser path copies the completed `AudioBuffer` channel data before
transferring it to the Worker, leaving the live loop attached and unchanged.
The Native path requests metadata first, applies a configurable temporary
memory estimate, and asks the Native bridge for interleaved float PCM from
Rubber Band R2/R3. The UI deinterleaves the rendered channels and encodes the
selected WAV format. Native recording and overdubbing are rejected; Browser
recording/finalization are rejected. The Native snapshot, rendered PCM,
deinterleaved channel arrays, and encoded WAV may coexist in memory. Both the
UI and C++ host reject renders over their configured estimates before large
render buffers are allocated. See [HQ WAV memory admission](HQ_WAV_MEMORY_ADMISSION.md).

`HQ_RENDER` returns its algorithmic leading delay. The adapter drops that delay
and render padding, then keeps exactly `ceil(inputFrames / playbackRate)` frames
so loop duration is deterministic. The WAV writer emits little-endian RIFF
headers, mono/stereo interleaving, block alignment and byte rate, and the IEEE
Float32 `fact` chunk. PCM integer formats clip to ±1; Float32 preserves finite
headroom within its finite range. RIFF's 32-bit size limit is checked before
rendering.

## Evidence and limits

- Unit tests cover WAV headers, channel interleaving, formats, padding,
  overflow, finite samples, Signalsmith alignment and Browser/Native renderer
  routing: `tests/unit/wav-export.spec.ts`, `tests/unit/hqWavExport.spec.ts`,
  `tests/unit/trackAudioHqExport.spec.ts`, and
  `tests/unit/native-hq-wav-export.spec.ts`.
- `tests/e2e/browser-hq-wav-export.spec.ts` exercises the Browser Track Strip,
  real Signalsmith-WASM HQ rendering, file download and output pitch.
  `tests/e2e/native-simulated-hq-render.spec.ts` exercises the Native UI,
  metadata endpoint, CORS bridge, Rubber Band R2 output and WAV download through
  the explicitly labeled no-audio synthetic host. It does not test physical
  device input or Native hardware.
- The production build bundles `hq-wav-export.worker` for the Browser path.
- No perceptual HQ-quality admission, 30-minute offline render, real physical
  Native host export, acoustic-latency, or hardware test is claimed. Memory
  admission is a conservative estimate rather than an OS memory guarantee.
- The first-party source is GPL-3.0-or-later. Native Rubber Band v4.0.0 is an
  optional GPL-2.0-or-later dependency, disabled by default. Its exact upstream
  license and reproducible build instructions are in
  `native-mvp/engine-cpp/third_party/rubberband/COPYING` and
  `native-mvp/engine-cpp/RUBBERBAND_BUILD.md`.
