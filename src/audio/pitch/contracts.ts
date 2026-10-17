/**
 * Keep-pitch and pitch-shift mode contract.
 *
 * Signalsmith Stretch is a polyphonic phase-vocoder-style engine. It does not
 * implement the separate YIN/PSOLA path required for a monophonic voice mode.
 */
export type PitchMode = 'LIVE_MONO' | 'LIVE_POLY' | 'HQ_RENDER';

export type PitchModeStatus = 'implemented' | 'unavailable';

export interface PitchModeContract {
  readonly status: PitchModeStatus;
  readonly engine: string | null;
  readonly latency: string;
  readonly quality: string;
  readonly notes: readonly string[];
}

export const PITCH_MODE_CONTRACT: Readonly<Record<PitchMode, PitchModeContract>> = Object.freeze({
  LIVE_MONO: Object.freeze({
    status: 'implemented',
    engine: 'Clean-room YIN pitch detection + peak-locked PSOLA in AudioWorklet',
    latency: 'Fixed latency from the configured lower-frequency bound; reported in samples at runtime',
    quality: 'Monophonic sustained-source pitch shifting; unvoiced content passes through the fixed-delay path',
    notes: Object.freeze([
      'Per-track opt-in uses a dedicated YIN/PSOLA worklet, separate from the polyphonic engine',
      'Suitable for sustained monophonic sources, not chords',
      'Reverse playback falls back to the ordinary BufferSource path',
      'AudioWorklet/device quality and CPU have not yet been characterized',
    ]),
  }),
  LIVE_POLY: Object.freeze({
    status: 'implemented',
    engine: 'Signalsmith Stretch 1.3.2 (Browser WASM/AudioWorklet, Native C++), cheaper preset',
    latency: 'Queried from the configured AudioWorklet node in Browser and input plus output latency in Native',
    quality: 'Polyphonic pitch/time processing; target-device quality and CPU are not yet characterized',
    notes: Object.freeze([
      'Browser DSP is in the AudioWorklet, not on the UI thread',
      'The cheaper preset uses split computation and has materially audible algorithmic latency',
      'The Native adapter uses the pinned official MIT C++ source and the same cheaper split-computation preset',
      'Native pitch processing is preconfigured before streaming and source tests observe no callback allocations',
      'The upstream Browser Worklet creates typed-array views per callback; allocation-free behavior is not proven there',
      'TrackAudio exposes an explicit per-track opt-in in Browser; the default playback route remains unchanged',
      'Reverse falls back to ordinary playback in both Browser and Native paths',
      'Loops no longer than the measured algorithmic latency use ordinary playback in both paths',
      'Cross-track latency compensation and end-to-end looper sync are not implemented',
    ]),
  }),
  HQ_RENDER: Object.freeze({
    status: 'implemented',
    engine: 'Signalsmith Stretch 1.3.2 WASM, default non-split preset',
    latency: 'Returned as inputLatencySamples + outputLatencySamples; output includes that leading delay',
    quality: 'Higher-window offline configuration; no comparative quality benchmark is claimed',
    notes: Object.freeze([
      'Synchronous batch processing; call from a worker or offline render job, never an audio callback',
      'The result retains leading algorithmic delay and padded tail so the caller can align it explicitly',
    ]),
  }),
});

export function isPitchModeImplemented(mode: PitchMode): boolean {
  return PITCH_MODE_CONTRACT[mode].status === 'implemented';
}
