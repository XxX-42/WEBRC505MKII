/** Read-only affine mapping from Web MIDI's performance-time clock to audio frames. */
export type MidiFrameMapFailure =
  | 'unanchored'
  | 'context-suspended'
  | 'context-changed'
  | 'stale-event'
  | 'future-event'
  | 'invalid-anchor'
  | 'outlier-anchor'
  | 'insufficient-drift-evidence'
  | 'invalid-sample-rate';

export interface MidiAudioAnchor {
  readonly performanceTimeMs: number;
  readonly audioTimeSeconds: number;
  readonly sampleRate: number;
  readonly contextKey: object;
  readonly contextState: 'running' | 'suspended' | 'interrupted' | 'closed';
}

export interface MidiAudioFrameMapResult {
  readonly ok: boolean;
  readonly frame: number | null;
  readonly reason: MidiFrameMapFailure | null;
  readonly driftPpm: number | null;
  readonly anchorCount: number;
}

export interface MidiAudioFrameMapperOptions {
  readonly historySize?: number;
  readonly maxAnchorResidualMs?: number;
  readonly maxDriftPpm?: number;
  /** Minimum clock span needed before a drift fit is trusted. */
  readonly minDriftEvidenceMs?: number;
  readonly maxEventAgeMs?: number;
  readonly maxFutureMs?: number;
}

const DEFAULT_HISTORY = 32;
const DEFAULT_RESIDUAL_MS = 8;
const DEFAULT_MAX_DRIFT_PPM = 2_000;
// currentTime may advance in render-quantum-sized steps. A multi-second span
// prevents one quantized edge from looking like meaningful clock drift.
const DEFAULT_MIN_DRIFT_EVIDENCE_MS = 3_000;
const DEFAULT_EVENT_AGE_MS = 250;
const DEFAULT_FUTURE_MS = 100;

/**
 * This class only converts timestamps; it does not establish musical phase or
 * schedule audio. Supply performance.now()/AudioContext.currentTime pairs while
 * the same context is running. Context suspension or replacement invalidates
 * the affine model and requires fresh anchors.
 */
export class MidiAudioFrameMapper {
  private readonly historySize: number;
  private readonly maxAnchorResidualMs: number;
  private readonly maxDriftPpm: number;
  private readonly minDriftEvidenceMs: number;
  private readonly maxEventAgeMs: number;
  private readonly maxFutureMs: number;
  private anchors: Array<{ performanceTimeMs: number; audioTimeSeconds: number }> = [];
  private contextKey: object | null = null;
  private sampleRate: number | null = null;
  private failure: MidiFrameMapFailure | null = 'unanchored';

  constructor(options: MidiAudioFrameMapperOptions = {}) {
    this.historySize = options.historySize ?? DEFAULT_HISTORY;
    this.maxAnchorResidualMs = options.maxAnchorResidualMs ?? DEFAULT_RESIDUAL_MS;
    this.maxDriftPpm = options.maxDriftPpm ?? DEFAULT_MAX_DRIFT_PPM;
    this.minDriftEvidenceMs = options.minDriftEvidenceMs ?? DEFAULT_MIN_DRIFT_EVIDENCE_MS;
    this.maxEventAgeMs = options.maxEventAgeMs ?? DEFAULT_EVENT_AGE_MS;
    this.maxFutureMs = options.maxFutureMs ?? DEFAULT_FUTURE_MS;
    if (!Number.isInteger(this.historySize) || this.historySize < 3) throw new RangeError('historySize must be an integer >= 3');
    if (!(this.maxAnchorResidualMs > 0) || !(this.maxDriftPpm > 0) || !(this.minDriftEvidenceMs > 0)
      || !(this.maxEventAgeMs > 0) || !(this.maxFutureMs >= 0)) {
      throw new RangeError('mapper limits must be positive (maxFutureMs may be zero)');
    }
  }

  addAnchor(anchor: MidiAudioAnchor): MidiAudioFrameMapResult {
    if (!Number.isFinite(anchor.performanceTimeMs) || !Number.isFinite(anchor.audioTimeSeconds)
      || !Number.isFinite(anchor.sampleRate) || anchor.sampleRate <= 0) {
      this.failure = 'invalid-anchor';
      return this.result(null, false, this.failure);
    }
    if (anchor.contextState !== 'running') {
      this.anchors = [];
      this.contextKey = anchor.contextKey;
      this.sampleRate = anchor.sampleRate;
      this.failure = 'context-suspended';
      return this.result(null, false, this.failure);
    }
    if (this.contextKey !== null && this.contextKey !== anchor.contextKey) {
      this.anchors = [];
      this.contextKey = anchor.contextKey;
      this.sampleRate = anchor.sampleRate;
      this.failure = 'context-changed';
      return this.result(null, false, this.failure);
    } else if (this.sampleRate !== null && this.sampleRate !== anchor.sampleRate) {
      this.anchors = [];
      this.sampleRate = anchor.sampleRate;
      this.contextKey = anchor.contextKey;
      this.failure = 'context-changed';
      return this.result(null, false, this.failure);
    } else {
      this.contextKey = anchor.contextKey;
      this.sampleRate = anchor.sampleRate;
    }
    const previous = this.anchors[this.anchors.length - 1];
    if (previous) {
      const elapsedMs = anchor.performanceTimeMs - previous.performanceTimeMs;
      const audioElapsedMs = (anchor.audioTimeSeconds - previous.audioTimeSeconds) * 1000;
      // UI refresh callbacks may sample the same clock pair more than once in
      // one task. Treat an identical repeat as a no-op instead of poisoning
      // an otherwise valid map with a zero-duration anchor.
      if (elapsedMs === 0 && audioElapsedMs === 0) {
        this.failure = null;
        return this.result(null, true, null);
      }
      if (!(elapsedMs > 0) || !(audioElapsedMs > 0)) {
        this.failure = 'invalid-anchor';
        return this.result(null, false, this.failure);
      }
      // Until the retained anchors span enough time, a slope outside the
      // allowed range is not evidence of a bad anchor: clock quantization can
      // dominate short intervals. Keep sampling, but never map from that fit.
      const fit = this.fit();
      if (fit && Math.abs(this.predictAudioMs(anchor.performanceTimeMs, fit) - anchor.audioTimeSeconds * 1000) > this.maxAnchorResidualMs) {
        this.failure = 'outlier-anchor';
        return this.result(null, false, this.failure);
      }
    }
    this.anchors.push(anchor);
    if (this.anchors.length > this.historySize) this.anchors.shift();
    this.failure = this.fit() ? null : 'insufficient-drift-evidence';
    return this.result(null, true, this.failure);
  }

  map(timestampMs: number, nowPerformanceTimeMs: number): MidiAudioFrameMapResult {
    if (this.failure && this.failure !== 'insufficient-drift-evidence') return this.result(null, false, this.failure);
    if (!Number.isFinite(timestampMs) || !Number.isFinite(nowPerformanceTimeMs)) return this.result(null, false, 'invalid-anchor');
    if (nowPerformanceTimeMs - timestampMs > this.maxEventAgeMs) return this.result(null, false, 'stale-event');
    if (timestampMs - nowPerformanceTimeMs > this.maxFutureMs) return this.result(null, false, 'future-event');
    if (this.failure) return this.result(null, false, this.failure);
    if (!this.anchors.length || this.sampleRate === null) return this.result(null, false, 'unanchored');
    const fit = this.fit();
    if (!fit) return this.result(null, false, 'unanchored');
    const audioTimeMs = this.predictAudioMs(timestampMs, fit);
    if (audioTimeMs < 0) return this.result(null, false, 'invalid-anchor');
    const frame = Math.round(audioTimeMs * this.sampleRate / 1000);
    if (!Number.isSafeInteger(frame) || frame < 0) return this.result(null, false, 'invalid-anchor');
    const driftPpm = this.anchors.length < 2 ? null : (fit.slope - 1) * 1_000_000;
    return Object.freeze({ ok: true, frame, reason: null, driftPpm, anchorCount: this.anchors.length });
  }

  reset(): void {
    this.anchors = [];
    this.contextKey = null;
    this.sampleRate = null;
    this.failure = 'unanchored';
  }

  private fit(): { slope: number; intercept: number } | null {
    if (this.anchors.length < 3) return null;
    const spanMs = this.anchors[this.anchors.length - 1]!.performanceTimeMs - this.anchors[0]!.performanceTimeMs;
    if (spanMs < this.minDriftEvidenceMs) return null;
    const origin = this.anchors[0]!.performanceTimeMs;
    const x = this.anchors.map((a) => a.performanceTimeMs - origin);
    const y = this.anchors.map((a) => a.audioTimeSeconds * 1000);
    const meanX = x.reduce((a, b) => a + b, 0) / x.length;
    const meanY = y.reduce((a, b) => a + b, 0) / y.length;
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < x.length; i += 1) {
      numerator += (x[i]! - meanX) * (y[i]! - meanY);
      denominator += (x[i]! - meanX) ** 2;
    }
    if (!(denominator > 0)) return null;
    const slope = numerator / denominator;
    if (Math.abs(slope - 1) * 1_000_000 > this.maxDriftPpm) return null;
    return { slope, intercept: meanY - slope * meanX - slope * origin };
  }

  private predictAudioMs(performanceTimeMs: number, fit: { slope: number; intercept: number }): number {
    return fit.slope * performanceTimeMs + fit.intercept;
  }

  private result(frame: number | null, ok: boolean, reason: MidiFrameMapFailure | null): MidiAudioFrameMapResult {
    const fit = this.fit();
    return Object.freeze({
      ok, frame, reason,
      driftPpm: fit && this.anchors.length >= 2 ? (fit.slope - 1) * 1_000_000 : null,
      anchorCount: this.anchors.length,
    });
  }
}
