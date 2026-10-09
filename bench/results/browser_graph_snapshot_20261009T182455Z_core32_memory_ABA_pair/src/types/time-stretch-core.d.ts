declare module '/worklets/time-stretch-core.js' {
  export const TIME_STRETCH_WINDOW_FRAMES: 1024;
  export const TIME_STRETCH_HOP_FRAMES: 512;

  export interface TimeStretchState {
    readonly windowFrames: number;
    readonly hopFrames: number;
    readonly binCount: number;
    readonly window: Float32Array;
    readonly binAngles: Float64Array;
    readonly bitReverse: Uint32Array;
    readonly twiddleReal: Float64Array;
    readonly twiddleImag: Float64Array;
    readonly realLeft: Float64Array;
    readonly imagLeft: Float64Array;
    readonly previousPhaseLeft: Float64Array;
    readonly previousPhaseRight: Float64Array;
    readonly currentPhaseLeft: Float64Array;
    readonly currentPhaseRight: Float64Array;
    readonly magnitudeLeft: Float64Array;
    readonly magnitudeRight: Float64Array;
    readonly synthesisPhaseLeft: Float64Array;
    readonly synthesisPhaseRight: Float64Array;
    readonly overlapLeft: Float32Array;
    readonly overlapRight: Float32Array;
    readonly overlapWeight: Float32Array;
    pendingLeft: Float32Array;
    pendingRight: Float32Array;
    nextPendingLeft: Float32Array;
    nextPendingRight: Float32Array;
    pendingIndex: number;
    nextPendingIndex: number;
    nextReady: boolean;
    nextSourceFrame: number;
    previousAnalysisHop: number;
    previousReverse: boolean;
    phaseInitialized: boolean;
    speed: number;
    playbackFrame: number;
    underruns: number;
    consecutiveUnderrunHops: number;
    autoResets: number;
    readUnderrun: boolean;
    outLeft: number;
    outRight: number;
  }

  export type TimeStretchReader = (absoluteSourceFrame: number) => number;

  export function createTimeStretchState(windowFrames: number, hopFrames: number): TimeStretchState;
  export function resetTimeStretchState(state: TimeStretchState, sourceFrame?: number, playbackFrame?: number): void;
  export function processTimeStretchFrame(
    state: TimeStretchState,
    loopFrames: number,
    speed: number,
    reverse: boolean,
    readLeft: TimeStretchReader,
    readRight: TimeStretchReader,
  ): void;
  export function prepareTimeStretchHop(
    state: TimeStretchState,
    loopFrames: number,
    speed: number,
    reverse: boolean,
    readLeft: TimeStretchReader,
    readRight: TimeStretchReader,
  ): boolean;
}
