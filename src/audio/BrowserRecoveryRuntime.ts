import { RhythmEngine } from './RhythmEngine';
import { getDrumKitByIndex, getRhythmPatternByIndex, RHYTHM_QUANTIZE_GRIDS } from './rhythm';
import { createLiveMonoPitchNode, createLivePolyPitchNode, type LiveMonoPitchNode, type LivePolyPitchNode } from './pitch';
import type { BrowserRecoveryPitchSettings, BrowserRecoverySnapshot } from './BrowserRecoverySnapshot';
import { withBrowserAudioTimeout, BROWSER_AUDIO_WORKLET_TIMEOUT_MS } from './browserAudioStartup';
import { isNativeLoopTransportConfig } from './NativeBridgeClient';

export interface BrowserRecoveryPreparedTrackRuntime {
  readonly trackId: number;
  readonly pitch: BrowserRecoveryPitchSettings;
  /** Per-loop source-reader state is applied lazily when the stopped TrackAudio is installed. */
  readonly sourceTransport: BrowserRecoverySnapshot['tracks'][number]['sourceTransport'];
  /** Prepared, muted worklet; it has no source, PCM schedule, or playback state. */
  readonly liveMonoNode: LiveMonoPitchNode | null;
  /** Prepared, muted worklet; it has no source, PCM schedule, or playback state. */
  readonly livePolyNode: LivePolyPitchNode | null;
  readonly pitchLatencySamples: number | null;
}

/**
 * A stopped, context-owned runtime package. Its DSP nodes are prepared but
 * disconnected from track sources; the AudioEngine singleton has not adopted it.
 * Transfer this whole package once, then let its new owner dispose the context.
 */
export interface BrowserRecoveryPreparedRuntime {
  readonly context: AudioContext;
  readonly rhythmEngine: RhythmEngine;
  readonly tracks: readonly BrowserRecoveryPreparedTrackRuntime[];
  readonly phase: 'prepared-not-installed';
}

function validatePitchSettings(snapshot: BrowserRecoverySnapshot, trackIndex: number): void {
  const pitch = snapshot.tracks[trackIndex]!.pitch;
  const sampleRate = snapshot.source.sampleRate;
  if (!pitch || !['off', 'LIVE_MONO', 'LIVE_POLY'].includes(pitch.mode)) {
    throw new Error(`Track ${trackIndex + 1} has an unsupported Keep Pitch mode; recovery candidate was not built.`);
  }
  const mono = pitch.liveMono;
  const detectorNyquist = (sampleRate / Math.max(1, Math.ceil(sampleRate / 12_000))) / 2;
  if (!mono || !Number.isFinite(mono.semitones) || mono.semitones < -12 || mono.semitones > 12
    || !Number.isFinite(mono.minimumFrequencyHz) || mono.minimumFrequencyHz < 20
    || !Number.isFinite(mono.maximumFrequencyHz) || mono.maximumFrequencyHz < mono.minimumFrequencyHz + 1
    || mono.maximumFrequencyHz > detectorNyquist) {
    throw new Error(`Track ${trackIndex + 1} has invalid LIVE_MONO controls; recovery candidate was not built.`);
  }
  const poly = pitch.livePoly;
  if (!poly || !Number.isFinite(poly.semitones) || poly.semitones < -24 || poly.semitones > 24
    || !Number.isFinite(poly.playbackRate) || poly.playbackRate < 0.5 || poly.playbackRate > 2
    || !Number.isFinite(poly.tonalityLimitHz) || poly.tonalityLimitHz <= 0
    || poly.tonalityLimitHz > sampleRate / 2) {
    throw new Error(`Track ${trackIndex + 1} has invalid LIVE_POLY controls; recovery candidate was not built.`);
  }
  if (pitch.mode === 'LIVE_MONO' && sampleRate > 192_000) {
    throw new Error(`Track ${trackIndex + 1} LIVE_MONO does not support ${sampleRate} Hz; the old context remains available.`);
  }
  if (pitch.mode === 'LIVE_POLY' && sampleRate > 192_000) {
    throw new Error(`Track ${trackIndex + 1} LIVE_POLY does not support ${sampleRate} Hz; the old context remains available.`);
  }
}

/** Validate every stopped-runtime setting before a context or PCM copy is allocated. */
export function validateBrowserRecoveryRuntimeSettings(snapshot: BrowserRecoverySnapshot): void {
  if (!snapshot || snapshot.schemaVersion !== 4 || snapshot.tracks.length !== 5) {
    throw new Error('Recovery requires the complete version-4 five-track runtime snapshot.');
  }
  for (let index = 0; index < snapshot.tracks.length; index += 1) {
    const track = snapshot.tracks[index]!;
    validatePitchSettings(snapshot, index);
    if (!Array.isArray(track.sourceTransport) || track.sourceTransport.length !== 4) {
      throw new Error(`Track ${index + 1} source-reader runtime snapshot must contain exactly four ordered slots.`);
    }
    for (let slotIndex = 0; slotIndex < track.sourceTransport.length; slotIndex += 1) {
      const slot = track.sourceTransport[slotIndex];
      if (!slot) continue;
      const prefix = `Track ${index + 1} source-reader slot ${slotIndex + 1}`;
      if (slot.type === 'BEAT SHIFT') {
        if (!Number.isFinite(slot.beatShiftOffsetBeats) || slot.beatShiftOffsetBeats < -4 || slot.beatShiftOffsetBeats > 4
          || !Number.isFinite(slot.beatShiftCrossfadeMs) || slot.beatShiftCrossfadeMs < 1 || slot.beatShiftCrossfadeMs > 10
          || (slot.bpm !== null && (!Number.isFinite(slot.bpm) || slot.bpm < 20 || slot.bpm > 300))) {
          throw new Error(`${prefix} contains invalid BEAT SHIFT controls.`);
        }
      } else if (slot.type === 'VINYL FLICK') {
        if (!Number.isFinite(slot.vinylFlickSpeed) || slot.vinylFlickSpeed < -100 || slot.vinylFlickSpeed > 100
          || !Number.isFinite(slot.vinylFlickMix) || slot.vinylFlickMix < 0 || slot.vinylFlickMix > 1
          || !Number.isFinite(slot.vinylFlickReturnTimeSeconds) || slot.vinylFlickReturnTimeSeconds < 0.05 || slot.vinylFlickReturnTimeSeconds > 10
          || !Number.isFinite(slot.vinylFlickBrakePercent) || slot.vinylFlickBrakePercent < 0 || slot.vinylFlickBrakePercent > 100) {
          throw new Error(`${prefix} contains invalid VINYL FLICK controls.`);
        }
      } else {
        throw new Error(`${prefix} has an unsupported source-reader type.`);
      }
    }
  }
  for (const override of snapshot.fx.sourceOverrides) {
    if (!Number.isInteger(override.trackId) || override.trackId < 1 || override.trackId > 5
      || !isNativeLoopTransportConfig(override.config)) {
      throw new Error('Recovery source-reader override is invalid; the old context remains available.');
    }
  }
  const rhythm = snapshot.rhythm;
  const pattern = getRhythmPatternByIndex(rhythm.patternIndex);
  if (!pattern || !getDrumKitByIndex(rhythm.kitIndex)
    || !pattern.variations.includes(rhythm.variation as 'A' | 'B' | 'C')
    || !['intro', 'main', 'fill', 'ending'].includes(rhythm.section)
    || !Number.isInteger(rhythm.swingPercent) || rhythm.swingPercent < 50 || rhythm.swingPercent > 75
    || !(RHYTHM_QUANTIZE_GRIDS as readonly string[]).includes(rhythm.quantizeGrid)
    || !Number.isFinite(rhythm.volumePercent) || rhythm.volumePercent < 0 || rhythm.volumePercent > 100) {
    throw new Error('Saved rhythm settings are invalid; recovery candidate was not built.');
  }
}

/** Prepare only stopped configuration and pitch processors; never resumes or starts a source. */
export async function prepareBrowserRecoveryRuntime(
  context: AudioContext,
  silentSink: GainNode,
  snapshot: BrowserRecoverySnapshot,
): Promise<BrowserRecoveryPreparedRuntime> {
  if (context.state !== 'suspended' || silentSink.gain.value !== 0 || snapshot.tracks.length !== 5) {
    throw new Error('Recovery runtime requires five tracks on a suspended, muted candidate context.');
  }
  validateBrowserRecoveryRuntimeSettings(snapshot);
  const rhythmEngine = new RhythmEngine(context);
  const prepared: BrowserRecoveryPreparedTrackRuntime[] = [];
  try {
    const rhythmApplied = rhythmEngine.setSettings({
      patternIndex: snapshot.rhythm.patternIndex,
      kitIndex: snapshot.rhythm.kitIndex,
      variation: snapshot.rhythm.variation as 'A' | 'B' | 'C',
      section: snapshot.rhythm.section as 'intro' | 'main' | 'fill' | 'ending',
      swingPercent: snapshot.rhythm.swingPercent,
      quantizeGrid: snapshot.rhythm.quantizeGrid as '1/16' | '1/8' | '1/4',
    });
    if (!rhythmApplied || !Number.isFinite(snapshot.rhythm.volumePercent)
      || snapshot.rhythm.volumePercent < 0 || snapshot.rhythm.volumePercent > 100) {
      throw new Error('Saved rhythm settings are invalid; recovery candidate was not built.');
    }
    rhythmEngine.setVolume(snapshot.rhythm.volumePercent);
    rhythmEngine.connect(silentSink);
    if (rhythmEngine.isRunning) throw new Error('Recovery rhythm unexpectedly started while preparing stopped state.');

    for (let index = 0; index < snapshot.tracks.length; index += 1) {
      const track = snapshot.tracks[index]!;
      validatePitchSettings(snapshot, index);
      let liveMonoNode: LiveMonoPitchNode | null = null;
      let livePolyNode: LivePolyPitchNode | null = null;
      let pitchLatencySamples: number | null = null;
      if (track.pitch.mode === 'LIVE_MONO') {
        liveMonoNode = await createLiveMonoPitchNode(context, {
          semitones: track.pitch.liveMono.semitones,
          minimumFrequencyHz: track.pitch.liveMono.minimumFrequencyHz,
          maximumFrequencyHz: track.pitch.liveMono.maximumFrequencyHz,
          outputChannels: 2,
        });
        liveMonoNode.connect(silentSink);
        await withBrowserAudioTimeout(() => liveMonoNode!.ready, 'Recovery LIVE_MONO worklet readiness', BROWSER_AUDIO_WORKLET_TIMEOUT_MS);
        pitchLatencySamples = liveMonoNode.latencySamples;
      } else if (track.pitch.mode === 'LIVE_POLY') {
        const channels = (track.buffer?.numberOfChannels ?? 1) as 1 | 2;
        livePolyNode = await createLivePolyPitchNode(context, {
          mode: 'LIVE_POLY', channels,
          semitones: track.pitch.livePoly.semitones,
          playbackRate: track.pitch.livePoly.playbackRate,
          tonalityLimitHz: track.pitch.livePoly.tonalityLimitHz,
        });
        livePolyNode.connect(silentSink);
        pitchLatencySamples = livePolyNode.latencySamples;
      }
      prepared.push(Object.freeze({
        trackId: track.trackId,
        pitch: track.pitch,
        sourceTransport: track.sourceTransport,
        liveMonoNode,
        livePolyNode,
        pitchLatencySamples,
      }));
    }

    return Object.freeze({
      context,
      rhythmEngine,
      tracks: Object.freeze(prepared),
      phase: 'prepared-not-installed' as const,
    });
  } catch (error) {
    rhythmEngine.dispose();
    throw error;
  }
}
