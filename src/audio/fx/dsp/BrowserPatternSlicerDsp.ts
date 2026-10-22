import { BROWSER_AUTHORED_SLICER_PATTERNS, BrowserOfficialPatternSlicerDsp, type BrowserOfficialPatternSlicerParameters } from './BrowserOfficialPatternSlicerDsp';
export interface BrowserPatternSlicerParameters {
  bpm?: number;
  pattern?: number;
  rateBeats?: number;
  depthPercent?: number;
  edgeMs?: number;
}

const RATE_OPTIONS = [0.25, 0.5, 1, 2, 4] as const;

// Authored 16-step gate tables for the documented “preset step table”
// behavior. These are functional clean-room patterns, not hardware presets.
const PATTERNS = BROWSER_AUTHORED_SLICER_PATTERNS;

/**
 * Sample-clocked, tempo-synchronized rhythmic gate. Each 16-step table is
 * repeated at the selected step duration; transitions use a bounded raised-
 * cosine envelope, and all parameter changes latch at the next step boundary.
 * This is an authored clean-room functional implementation, not a Roland
 * preset or sound-quality reproduction.
 */
export class BrowserPatternSlicerDsp {
  readonly sampleRate: number;
  wetLeft = 0;
  wetRight = 0;
  framesProcessed = 0;
  boundaryCount = 0;
  lastBoundaryFrame = -1;

  private official: BrowserOfficialPatternSlicerDsp | null = null;
  private currentBpm: number;
  private currentPattern: number;
  private currentRateBeats: number;
  private currentDepthPercent: number;
  private currentEdgeMs: number;
  private pendingBpm: number;
  private pendingPattern: number;
  private pendingRateBeats: number;
  private pendingDepthPercent: number;
  private pendingEdgeMs: number;
  private stepIndex = 0;
  private stepFrames: number;
  private stepElapsedFrames = 0;
  private framesUntilStep: number;
  private previousStepGain = 1;
  private stepTargetGain = 1;

  constructor(sampleRate: number, parameters: BrowserPatternSlicerParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    this.currentBpm = this.pendingBpm = this.clampBpm(parameters.bpm ?? 120);
    this.currentPattern = this.pendingPattern = this.clampPattern(parameters.pattern ?? 0);
    this.currentRateBeats = this.pendingRateBeats = this.quantizeRate(parameters.rateBeats ?? 0.25);
    this.currentDepthPercent = this.pendingDepthPercent = this.clampPercent(parameters.depthPercent ?? 100);
    this.currentEdgeMs = this.pendingEdgeMs = this.clampEdge(parameters.edgeMs ?? 2);
    this.stepFrames = this.intervalFrames(this.currentBpm, this.currentRateBeats);
    this.framesUntilStep = this.stepFrames;
    this.stepTargetGain = this.gainAtStep(this.stepIndex, this.currentPattern, this.currentDepthPercent);
    this.previousStepGain = this.stepTargetGain;
  }

  get diagnostics(): Readonly<{
    framesProcessed: number;
    boundaryCount: number;
    lastBoundaryFrame: number;
    activeBpm: number;
    activePattern: number;
    activeRateBeats: number;
    activeDepthPercent: number;
    activeEdgeMs: number;
    activeStepIndex: number;
    activeStepFrames: number;
    remainingFramesToBoundary: number;
  }> {
    return {
      framesProcessed: this.framesProcessed,
      boundaryCount: this.boundaryCount,
      lastBoundaryFrame: this.lastBoundaryFrame,
      activeBpm: this.currentBpm,
      activePattern: this.currentPattern,
      activeRateBeats: this.currentRateBeats,
      activeDepthPercent: this.currentDepthPercent,
      activeEdgeMs: this.currentEdgeMs,
      activeStepIndex: this.stepIndex,
      activeStepFrames: this.stepFrames,
      remainingFramesToBoundary: this.framesUntilStep,
    };
  }

  setOfficialParameters(parameters: BrowserOfficialPatternSlicerParameters): void {
    this.official ??= new BrowserOfficialPatternSlicerDsp(this.sampleRate, { softwarePattern: this.pendingPattern });
    this.official.setParameters(parameters);
  }

  setParameters(parameters: BrowserPatternSlicerParameters): void {
    if (Number.isFinite(parameters.pattern)) this.official?.setParameters({ softwarePattern: parameters.pattern });
    if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm as number);
    if (Number.isFinite(parameters.pattern)) this.pendingPattern = this.clampPattern(parameters.pattern as number);
    if (Number.isFinite(parameters.rateBeats)) this.pendingRateBeats = this.quantizeRate(parameters.rateBeats as number);
    if (Number.isFinite(parameters.depthPercent)) this.pendingDepthPercent = this.clampPercent(parameters.depthPercent as number);
    if (Number.isFinite(parameters.edgeMs)) this.pendingEdgeMs = this.clampEdge(parameters.edgeMs as number);
  }

  /** Applies the raised-cosine gate directly to the stereo frame, with no allocations. */
  processSample(left: number, right: number): void {
    if (this.official) {
      this.official.processSample(left, right); this.wetLeft = this.official.wetLeft; this.wetRight = this.official.wetRight;
      this.framesProcessed += 1; return;
    }
    let gain = this.stepTargetGain;
    const edgeFrames = Math.min(this.stepFrames, Math.max(1, Math.round((this.currentEdgeMs * this.sampleRate) / 1000)));
    if (edgeFrames > 1 && this.stepElapsedFrames < edgeFrames && this.previousStepGain !== this.stepTargetGain) {
      const position = this.stepElapsedFrames / (edgeFrames - 1);
      const fade = 0.5 - (0.5 * Math.cos(Math.PI * position));
      gain = this.previousStepGain + ((this.stepTargetGain - this.previousStepGain) * fade);
    }
    this.wetLeft = left * gain;
    this.wetRight = right * gain;

    this.stepElapsedFrames += 1;
    this.framesUntilStep -= 1;
    this.framesProcessed += 1;
    if (this.framesUntilStep <= 0) this.onStepBoundary();
  }

  reset(): void {
    this.official?.reset();
    this.currentBpm = this.pendingBpm;
    this.currentPattern = this.pendingPattern;
    this.currentRateBeats = this.pendingRateBeats;
    this.currentDepthPercent = this.pendingDepthPercent;
    this.currentEdgeMs = this.pendingEdgeMs;
    this.stepIndex = 0;
    this.stepFrames = this.intervalFrames(this.currentBpm, this.currentRateBeats);
    this.framesUntilStep = this.stepFrames;
    this.stepElapsedFrames = 0;
    this.stepTargetGain = this.gainAtStep(this.stepIndex, this.currentPattern, this.currentDepthPercent);
    this.previousStepGain = this.stepTargetGain;
    this.wetLeft = 0;
    this.wetRight = 0;
    this.framesProcessed = 0;
    this.boundaryCount = 0;
    this.lastBoundaryFrame = -1;
  }

  private onStepBoundary(): void {
    this.boundaryCount += 1;
    this.lastBoundaryFrame = this.framesProcessed - 1;
    this.previousStepGain = this.stepTargetGain;
    this.stepIndex = (this.stepIndex + 1) & 15;
    this.currentBpm = this.pendingBpm;
    this.currentPattern = this.pendingPattern;
    this.currentRateBeats = this.pendingRateBeats;
    this.currentDepthPercent = this.pendingDepthPercent;
    this.currentEdgeMs = this.pendingEdgeMs;
    this.stepFrames = this.intervalFrames(this.currentBpm, this.currentRateBeats);
    this.framesUntilStep = this.stepFrames;
    this.stepElapsedFrames = 0;
    this.stepTargetGain = this.gainAtStep(this.stepIndex, this.currentPattern, this.currentDepthPercent);
  }

  private gainAtStep(step: number, pattern: number, depthPercent: number): number {
    const gateOpen = PATTERNS[pattern]?.[step] ?? 1;
    return 1 - ((depthPercent / 100) * (1 - gateOpen));
  }

  private intervalFrames(bpm: number, rateBeats: number): number {
    return Math.max(1, Math.round((60 * this.sampleRate * rateBeats) / bpm));
  }

  private clampBpm(value: number): number { return Math.max(40, Math.min(300, value)); }
  private clampPattern(value: number): number { return Math.round(Math.max(0, Math.min(7, value))); }
  private clampPercent(value: number): number { return Math.max(0, Math.min(100, value)); }
  private clampEdge(value: number): number { return Math.max(0.5, Math.min(20, value)); }

  private quantizeRate(value: number): number {
    let nearest: number = RATE_OPTIONS[0];
    let distance = Math.abs(value - nearest);
    for (let index = 1; index < RATE_OPTIONS.length; index += 1) {
      const option = RATE_OPTIONS[index]!;
      const nextDistance = Math.abs(value - option);
      if (nextDistance < distance) {
        nearest = option;
        distance = nextDistance;
      }
    }
    return nearest;
  }
}
