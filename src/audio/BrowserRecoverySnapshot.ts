import type { TrackState, TransportState } from '../core/types';
import type { NativeLoopTransportConfig } from './NativeBridgeClient';

export type RecoveryFxParameterValue = number | string | boolean;

/** Copy only stable authored scalar values; reject corrupted controls rather than silently restoring defaults. */
export function copyRecoveryFxParameters(value: Readonly<object> | undefined): Readonly<Record<string, RecoveryFxParameterValue>> {
  const entries: Array<[string, RecoveryFxParameterValue]> = [];
  for (const [key, parameter] of Object.entries(value ?? {})) {
    if (parameter === undefined) continue;
    if (typeof parameter === 'number') {
      if (!Number.isFinite(parameter)) throw new Error(`FX parameter ${key} is not finite; Browser recovery snapshot was not captured.`);
      entries.push([key, parameter]);
    } else if (typeof parameter === 'string' || typeof parameter === 'boolean') {
      entries.push([key, parameter]);
    } else {
      throw new Error(`FX parameter ${key} has an unsupported value; Browser recovery snapshot was not captured.`);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

/** A live Browser DSP slot's authored state; AudioWorklet feedback buffers are intentionally absent. */
export interface BrowserRecoveryFxSlot {
  readonly slot: 'A' | 'B' | 'C' | 'D';
  readonly type: string | null;
  readonly requestedType: string | null;
  readonly active: boolean;
  readonly requestedActive: boolean | null;
  readonly state: 'empty' | 'loading' | 'ready' | 'error';
  /** The UI's scalar control; null means untouched and therefore factory default. */
  readonly amount: number | null;
  /** Named authored controls; defaults not explicitly touched are factory defaults. */
  readonly parameters: Readonly<Record<string, RecoveryFxParameterValue>>;
  readonly parametersCaptured: boolean;
  readonly error: string | null;
}

export interface BrowserRecoveryTrackSettings {
  readonly measure: Readonly<{ type: string; value?: string }>;
  readonly loopSyncSw: string;
  readonly tempoSyncSw: string;
  readonly reverse: string;
  readonly oneShot: string;
  readonly pan: string;
  readonly playLevel: number;
  readonly startMode: string;
  readonly stopMode: string;
  readonly dubMode: string;
  readonly fxSw: string;
  readonly filterEnabled: boolean;
  readonly filterValue: number;
  readonly filterResonance: number;
}

/** Persisted pitch controls only. Live worklet history/phase is not recoverable. */
export interface BrowserRecoveryPitchSettings {
  readonly mode: 'off' | 'LIVE_MONO' | 'LIVE_POLY';
  readonly liveMono: Readonly<{
    semitones: number;
    minimumFrequencyHz: number;
    maximumFrequencyHz: number;
  }>;
  readonly livePoly: Readonly<{
    semitones: number;
    playbackRate: number;
    tonalityLimitHz: number;
  }>;
}

export interface BrowserRecoveryTrack {
  readonly trackId: number;
  readonly state: TrackState;
  readonly wasPlaying: boolean;
  readonly projectPcmRevision: number;
  /** AudioBuffer identities are retained directly; this snapshot does not clone PCM. */
  readonly buffer: AudioBuffer | null;
  readonly bufferBytes: number;
  readonly isReverse: boolean;
  readonly settings: BrowserRecoveryTrackSettings;
  readonly pitch: BrowserRecoveryPitchSettings;
  readonly history: Readonly<{
    buffer: AudioBuffer | null;
    direction: 'undo' | 'redo' | null;
    isReverse: boolean | null;
    master: Readonly<{ bpm: number; measureLength: number; lengthSamples: number }> | null;
    retainedBytes: number;
    unavailableReason: string | null;
  }>;
  readonly sourceTransport: ReadonlyArray<Readonly<{
    type: 'BEAT SHIFT' | 'VINYL FLICK';
    beatShiftOffsetBeats: number;
    beatShiftCrossfadeMs: number;
    bpm: number | null;
    vinylFlickSpeed: number;
    vinylFlickMix: number;
    vinylFlickReturnTimeSeconds: number;
    vinylFlickBrakePercent: number;
  }> | null>;
}

export interface BrowserRecoverySnapshot {
  /** Version 2 adds the per-track Keep Pitch controls required for recovery. */
  readonly schemaVersion: 2;
  readonly source: Readonly<{
    contextState: AudioContextState;
    sampleRate: number;
    inputDevicePreference: string | null;
    outputDevicePreference: string | null;
    lastObservedRenderBlockFrames: number;
  }>;
  readonly transport: Readonly<{
    bpm: number;
    timeSignature: readonly [number, number];
    state: TransportState;
    masterTrackId: number | null;
    masterLoopLengthSamples: number;
    measureLength: number;
    projectMutationRevision: number;
  }>;
  readonly rhythm: Readonly<{
    patternIndex: number;
    kitIndex: number;
    variation: string;
    section: string;
    swingPercent: number;
    quantizeGrid: string;
    volumePercent: number;
    wasRunning: boolean;
    error: string;
  }>;
  readonly tracks: readonly BrowserRecoveryTrack[];
  /** One shared ledger for the five tracks, not a per-track allocation allowance. */
  readonly pcmHistoryBudget: Readonly<{ retainedBytes: number; limitBytes: number }>;
  readonly fx: Readonly<{
    input: readonly BrowserRecoveryFxSlot[];
    sharedTrack: readonly BrowserRecoveryFxSlot[];
    privateTracks: readonly (readonly BrowserRecoveryFxSlot[])[];
    sourceOverrides: readonly Readonly<{ trackId: number; config: Readonly<NativeLoopTransportConfig> }>[];
    outputDsp: Readonly<{ algorithm: string | null; parameters: Readonly<Record<string, RecoveryFxParameterValue>>; enabled: boolean }>;
  }>;
  readonly midi: Readonly<{
    sourceInputState: string;
    target: Readonly<{ path: string; slot: string; effectId: string; trackId: number | null }> | null;
  }>;
  readonly monitoringWasEnabled: boolean;
  readonly outputGainValue: number;
  readonly trackMixGainValue: number;
  /** Recovery always starts stopped and muted; a closed-context DSP tail cannot be transferred. */
  readonly recoveryPolicy: Readonly<{
    playback: 'start-stopped';
    monitoring: 'start-muted';
    input: 'explicit-user-reconnect';
    midi: 'target-restored-disconnected';
    dynamicDspState: 'not-captured';
    effectTails: 'discarded';
  }>;
}
