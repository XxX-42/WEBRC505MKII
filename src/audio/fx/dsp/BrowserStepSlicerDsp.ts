export interface BrowserStepSlicerParameters {
  bpm?: number;
  stepCount?: number;
  rateBeats?: number;
  depthPercent?: number;
  panDepthPercent?: number;
  filterHz?: number;
  step01?: number;
  step02?: number;
  step03?: number;
  step04?: number;
  step05?: number;
  step06?: number;
  step07?: number;
  step08?: number;
  step09?: number;
  step10?: number;
  step11?: number;
  step12?: number;
  step13?: number;
  step14?: number;
  step15?: number;
  step16?: number;
}

const RATE_OPTIONS = [0.25, 0.5, 1, 2, 4] as const;
const DEFAULT_LEVELS = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100] as const;
const STEP_EDGE_MS = 2;

/**
 * Clean-room, sample-clocked editable 16-step stereo amplitude sequencer.
 * Unlike PATTERN SLICER's fixed gate tables, each step has its own user-set
 * amplitude target. Optional alternating stereo balance and a shared low-pass
 * stage are controlled independently. All mutable state and sequence storage
 * are allocated at construction; processSample allocates nothing.
 */
export class BrowserStepSlicerDsp {
  readonly sampleRate: number;
  wetLeft = 0;
  wetRight = 0;
  framesProcessed = 0;
  boundaryCount = 0;
  lastBoundaryFrame = -1;

  private currentBpm: number;
  private currentStepCount: number;
  private currentRateBeats: number;
  private currentDepthPercent: number;
  private currentPanDepthPercent: number;
  private currentFilterHz: number;
  private pendingBpm: number;
  private pendingStepCount: number;
  private pendingRateBeats: number;
  private pendingDepthPercent: number;
  private pendingPanDepthPercent: number;
  private pendingFilterHz: number;
  private readonly stepLevels = new Float64Array(DEFAULT_LEVELS);
  private readonly pendingStepLevels = new Float64Array(DEFAULT_LEVELS);
  private readonly filterState = new Float64Array(2);
  private stepIndex = 0;
  private stepFrames: number;
  private stepElapsedFrames = 0;
  private framesUntilStep: number;
  private filterAlpha: number;
  private previousStepGain = 1;
  private stepTargetGain = 1;
  private previousStepPan = 0;
  private stepTargetPan = 0;

  constructor(sampleRate: number, parameters: BrowserStepSlicerParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    this.currentBpm = this.pendingBpm = this.clampBpm(parameters.bpm ?? 120);
    this.currentStepCount = this.pendingStepCount = this.clampStepCount(parameters.stepCount ?? 16);
    this.currentRateBeats = this.pendingRateBeats = this.quantizeRate(parameters.rateBeats ?? 0.25);
    this.currentDepthPercent = this.pendingDepthPercent = this.clampPercent(parameters.depthPercent ?? 100);
    this.currentPanDepthPercent = this.pendingPanDepthPercent = this.clampPercent(parameters.panDepthPercent ?? 0);
    this.currentFilterHz = this.pendingFilterHz = this.clampFilter(parameters.filterHz ?? 20000);
    this.applyStepParameters(parameters, this.pendingStepLevels);
    this.stepLevels.set(this.pendingStepLevels);
    this.stepFrames = this.intervalFrames(this.currentBpm, this.currentRateBeats);
    this.framesUntilStep = this.stepFrames;
    this.filterAlpha = this.calculateFilterAlpha(this.currentFilterHz);
    this.stepTargetGain = this.gainAtStep(0);
    this.previousStepGain = this.stepTargetGain;
    this.stepTargetPan = this.panAtStep(0);
    this.previousStepPan = this.stepTargetPan;
  }

  get diagnostics(): Readonly<{
    framesProcessed: number;
    boundaryCount: number;
    lastBoundaryFrame: number;
    activeBpm: number;
    activeStepCount: number;
    activeRateBeats: number;
    activeDepthPercent: number;
    activePanDepthPercent: number;
    activeFilterHz: number;
    activeStepIndex: number;
    activeStepLevelPercent: number;
    activeStepFrames: number;
    remainingFramesToBoundary: number;
  }> {
    return {
      framesProcessed: this.framesProcessed,
      boundaryCount: this.boundaryCount,
      lastBoundaryFrame: this.lastBoundaryFrame,
      activeBpm: this.currentBpm,
      activeStepCount: this.currentStepCount,
      activeRateBeats: this.currentRateBeats,
      activeDepthPercent: this.currentDepthPercent,
      activePanDepthPercent: this.currentPanDepthPercent,
      activeFilterHz: this.currentFilterHz,
      activeStepIndex: this.stepIndex,
      activeStepLevelPercent: this.stepLevels[this.stepIndex] ?? 100,
      activeStepFrames: this.stepFrames,
      remainingFramesToBoundary: this.framesUntilStep,
    };
  }

  /** Latch edits on the next step edge, keeping the stereo clock coherent. */
  setParameters(parameters: BrowserStepSlicerParameters): void {
    if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm as number);
    if (Number.isFinite(parameters.stepCount)) this.pendingStepCount = this.clampStepCount(parameters.stepCount as number);
    if (Number.isFinite(parameters.rateBeats)) this.pendingRateBeats = this.quantizeRate(parameters.rateBeats as number);
    if (Number.isFinite(parameters.depthPercent)) this.pendingDepthPercent = this.clampPercent(parameters.depthPercent as number);
    if (Number.isFinite(parameters.panDepthPercent)) this.pendingPanDepthPercent = this.clampPercent(parameters.panDepthPercent as number);
    if (Number.isFinite(parameters.filterHz)) this.pendingFilterHz = this.clampFilter(parameters.filterHz as number);
    this.applyStepParameters(parameters, this.pendingStepLevels);
  }

  processSample(left: number, right: number): void {
    let fade = 1;
    const edgeFrames = Math.min(this.stepFrames, Math.max(1, Math.round((STEP_EDGE_MS * this.sampleRate) / 1000)));
    if (edgeFrames > 1 && this.stepElapsedFrames < edgeFrames) {
      const position = this.stepElapsedFrames / (edgeFrames - 1);
      fade = 0.5 - (0.5 * Math.cos(Math.PI * position));
    }

    const gain = this.previousStepGain + ((this.stepTargetGain - this.previousStepGain) * fade);
    const pan = this.previousStepPan + ((this.stepTargetPan - this.previousStepPan) * fade);
    const filteredLeft = this.filterState[0]! += this.filterAlpha * (left - this.filterState[0]!);
    const filteredRight = this.filterState[1]! += this.filterAlpha * (right - this.filterState[1]!);
    const panAmount = Math.abs(pan);
    this.wetLeft = filteredLeft * gain * (pan > 0 ? 1 - panAmount : 1);
    this.wetRight = filteredRight * gain * (pan < 0 ? 1 - panAmount : 1);

    this.stepElapsedFrames += 1;
    this.framesUntilStep -= 1;
    this.framesProcessed += 1;
    if (this.framesUntilStep <= 0) this.onStepBoundary();
  }

  reset(): void {
    this.currentBpm = this.pendingBpm;
    this.currentStepCount = this.pendingStepCount;
    this.currentRateBeats = this.pendingRateBeats;
    this.currentDepthPercent = this.pendingDepthPercent;
    this.currentPanDepthPercent = this.pendingPanDepthPercent;
    this.currentFilterHz = this.pendingFilterHz;
    this.stepLevels.set(this.pendingStepLevels);
    this.stepIndex = 0;
    this.stepFrames = this.intervalFrames(this.currentBpm, this.currentRateBeats);
    this.framesUntilStep = this.stepFrames;
    this.stepElapsedFrames = 0;
    this.filterAlpha = this.calculateFilterAlpha(this.currentFilterHz);
    this.filterState.fill(0);
    this.stepTargetGain = this.gainAtStep(0);
    this.previousStepGain = this.stepTargetGain;
    this.stepTargetPan = this.panAtStep(0);
    this.previousStepPan = this.stepTargetPan;
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
    this.previousStepPan = this.stepTargetPan;
    this.stepLevels.set(this.pendingStepLevels);
    this.currentBpm = this.pendingBpm;
    this.currentStepCount = this.pendingStepCount;
    this.currentRateBeats = this.pendingRateBeats;
    this.currentDepthPercent = this.pendingDepthPercent;
    this.currentPanDepthPercent = this.pendingPanDepthPercent;
    this.currentFilterHz = this.pendingFilterHz;
    this.stepIndex = (this.stepIndex + 1) % this.currentStepCount;
    this.stepFrames = this.intervalFrames(this.currentBpm, this.currentRateBeats);
    this.framesUntilStep = this.stepFrames;
    this.stepElapsedFrames = 0;
    this.filterAlpha = this.calculateFilterAlpha(this.currentFilterHz);
    this.stepTargetGain = this.gainAtStep(this.stepIndex);
    this.stepTargetPan = this.panAtStep(this.stepIndex);
  }

  private gainAtStep(step: number): number {
    const level = (this.stepLevels[step] ?? 100) / 100;
    return 1 - ((this.currentDepthPercent / 100) * (1 - level));
  }

  private panAtStep(step: number): number {
    const direction = (step & 1) === 0 ? -1 : 1;
    return direction * (this.currentPanDepthPercent / 100);
  }

  private applyStepParameters(parameters: BrowserStepSlicerParameters, target: Float64Array): void {
    for (let index = 0; index < 16; index += 1) {
      const key = `step${String(index + 1).padStart(2, '0')}` as keyof BrowserStepSlicerParameters;
      const value = parameters[key];
      if (Number.isFinite(value)) target[index] = this.clampPercent(value as number);
    }
  }

  private intervalFrames(bpm: number, rateBeats: number): number {
    return Math.max(1, Math.round((60 * this.sampleRate * rateBeats) / bpm));
  }

  private calculateFilterAlpha(filterHz: number): number {
    return 1 - Math.exp((-2 * Math.PI * filterHz) / this.sampleRate);
  }

  private clampBpm(value: number): number { return Math.max(30, Math.min(300, value)); }
  private clampPercent(value: number): number { return Math.max(0, Math.min(100, value)); }
  private clampFilter(value: number): number { return Math.max(20, Math.min(Math.min(20000, this.sampleRate * 0.499), value)); }
  private clampStepCount(value: number): number {
    const rounded = Math.round(value);
    if (rounded <= 0) return 4;
    if (rounded <= 2) return 4 << rounded;
    return rounded < 6 ? 4 : rounded < 12 ? 8 : 16;
  }

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
