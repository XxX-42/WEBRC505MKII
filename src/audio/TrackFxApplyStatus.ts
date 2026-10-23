export interface TrackFxApplyStatus {
  readonly trackId: number;
  readonly available: boolean;
  readonly requested: boolean;
  /** Last jointly render-confirmed gate value; false means the raw/dry route. */
  readonly applied: boolean;
  readonly requestedRevision: number;
  readonly appliedRevision: number;
  /** Changes only when the applied gate value changes, suitable for PCM cache tokens. */
  readonly semanticRevision: number;
  /** Browser capture tap acknowledgement, separate from playback routing. */
  readonly inputAppliedRevision: number;
  /** Browser shared wet/dry playback routing acknowledgement. */
  readonly trackAppliedRevision: number;
  readonly pending: boolean;
  readonly controlFaulted: boolean;
  /** Post-fader, pre-shared-Track-FX linear peak and RMS. */
  readonly peak: number;
  readonly rms: number;
  readonly error: string;
}

/** A request being accepted is not proof that either audio path rendered it. */
export function assertTrackFxApplyConfirmed(status: TrackFxApplyStatus, enabled: boolean): void {
  if (!status.available || status.pending || status.controlFaulted || status.requested !== enabled
    || status.applied !== enabled || status.requestedRevision !== status.appliedRevision
    || status.requestedRevision !== status.inputAppliedRevision || status.requestedRevision !== status.trackAppliedRevision) {
    throw new Error(status.error || 'The audio renderer has not confirmed both FX routes.');
  }
}
