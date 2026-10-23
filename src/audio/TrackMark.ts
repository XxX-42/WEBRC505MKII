export interface TrackMarkState {
  readonly supported: boolean;
  readonly exists: boolean;
  readonly canSet: boolean;
  readonly canClear: boolean;
  readonly backSupported: false;
  readonly busy: boolean;
  readonly retainedPcmBytes: number;
  readonly unavailableReason: string | null;
  readonly requestedGeneration: number;
  readonly appliedGeneration: number;
}

export interface TrackMarkActionResult {
  readonly ok: boolean;
  readonly unsupported?: boolean;
  readonly reason: string | null;
  readonly state: TrackMarkState;
}

export function unsupportedTrackMarkState(reason: string): TrackMarkState {
  return {
    supported: false,
    exists: false,
    canSet: false,
    canClear: false,
    backSupported: false,
    busy: false,
    retainedPcmBytes: 0,
    unavailableReason: reason,
    requestedGeneration: 0,
    appliedGeneration: 0,
  };
}
