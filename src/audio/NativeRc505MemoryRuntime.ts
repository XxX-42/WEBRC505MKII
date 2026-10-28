import { Transport } from '../core/Transport';
import { decodeProjectArchive } from './projectArchive';
import { Rc505MemoryCommittedError, encodeRc505Memory, type Rc505Json, type Rc505MemoryDocument, type Rc505MemoryField, type Rc505MemoryRuntime } from './Rc505Memory';
import type { NativeBridgeClient, NativeCatalogSlotStatus, NativeStatus } from './NativeBridgeClient';

export interface NativeMemoryPort {
  bridge: NativeBridgeClient;
  status(): NativeStatus | null;
  editRevision(): string;
  archive(): Promise<Uint8Array>;
  publish(status: NativeStatus): void;
  install?(status: NativeStatus): void;
  /** Host publication is confirmed; invalidate previous-generation UI ACKs before any readback. */
  committed?(generation: number): void;
  pendingEdits?(): boolean;
}
const copyJson = (value: unknown): Rc505Json => JSON.parse(JSON.stringify(value)) as Rc505Json;

function stopped(status: NativeStatus | null): { allowed: boolean; reason: string } {
  const allowed = !!status?.engineRunning && status.nativeTracks?.length === 5
    && status.nativeTracks.every((track) => track.state === 'Empty' || track.state === 'Stopped');
  return { allowed, reason: allowed ? '' : 'Stop all five Native tracks before switching Memory.' };
}
function nativeSettings(status: NativeStatus): Record<string, Rc505Json> {
  const native = (status as NativeStatus & { nativeMemory?: { version: number; loopTransports: Rc505Json[]; bounce?: { bounceSw: boolean; bounceIn: boolean[]; bounceTrack: boolean[] } } }).nativeMemory;
  if (native?.version !== 1 || native.loopTransports.length !== 5 || !status.nativeRhythm) {
    throw new Error('Native host does not support atomic semantic Memory; update the host.');
  }
  const bounce = status.nativeBounce;
  if (!bounce || bounce.requestedRevision !== bounce.appliedRevision || bounce.bounceIn.length !== 5 || bounce.bounceTrack.length !== 5) {
    throw new Error('Wait for Native Bounce callback acknowledgement before Memory capture.');
  }
  if (status.mixerLevels?.length !== 7 || status.mixerLevels.some((value) => !Number.isInteger(value) || value < 0 || value > 200)) {
    throw new Error('Native host does not expose all seven mixer levels.');
  }
  const fx = status.nativeFx;
  const sources = [fx?.inputCatalogSlots, fx?.catalogSlots,
    ...Array.from({ length: 5 }, (_, index) => fx?.perTrackCatalogBanks?.find((bank) => bank.trackId === index + 1)?.slots)];
  const banks = sources.map((slots) => {
    if (slots?.length !== 4) throw new Error('Native Memory requires seven complete FX banks.');
    return slots.map((slot: NativeCatalogSlotStatus) => {
      if (!slot.parameters || slot.requestedRevision !== slot.appliedRevision || slot.bypassed !== slot.appliedBypassed
        || slot.controlFaulted || slot.processingFaulted || (!!slot.effectId && !slot.prepared)) {
        throw new Error('Wait for Native FX settings to be acknowledged before Memory capture.');
      }
      return { effectId: slot.effectId, parameters: { ...slot.parameters }, bypassed: slot.bypassed };
    });
  });
  const rhythm = status.nativeRhythm;
  const gates = status.nativeFx?.trackFxApply;
  if (gates?.length !== 5 || gates.some((gate) => gate.requested !== gate.applied || gate.requestedRevision !== gate.appliedRevision || gate.controlFaulted)) {
    throw new Error('Wait for all five Native FX gate acknowledgements before Memory capture.');
  }
  const record = status.nativeRecordPlay;
  if (record && (record.requestedRevision !== record.appliedRevision || !['REC->PLAY', 'REC->DUB'].includes(record.recAction))) {
    throw new Error('Wait for Native REC ACTION callback acknowledgement.');
  }
  return {
    ...(record?.recActionAvailable ? { recAction: record.recAction } : {}),
    trackFxApply: gates.map((gate) => gate.applied), mixerLevels: [...status.mixerLevels],
    banks, loopTransports: copyJson(native.loopTransports),
    bounce: native.bounce ? copyJson(native.bounce) : { bounceSw: false, bounceIn: [false, false, false, false, false], bounceTrack: [false, false, false, false, false] },
    rhythm: { enabled: rhythm.enabled, bpm: rhythm.bpm, kitIndex: rhythm.kitIndex, patternIndex: rhythm.patternIndex,
      variation: ['A', 'B', 'C', 'D'].indexOf(rhythm.variation), section: ['main', 'intro', 'ending', 'fill'].indexOf(rhythm.section),
      quantizeGrid: ['1/16', '1/8', '1/4'].indexOf(rhythm.quantizeGrid), swingPercent: rhythm.swingPercent, volume: rhythm.volume },
  };
}

function outputSettings(status: NativeStatus): Rc505Json {
  const source = status.nativeFx as unknown as Record<string, unknown>;
  const fx: Record<string, unknown> = {};
  for (const key of ['outputLowPassEnabled', 'outputHighPassEnabled', 'outputReverbEnabled', 'outputReverbWetMix',
    'outputReverbRt60Seconds', 'outputReverbDampingCutoffHz', 'fractionalDelay', 'compressor', 'chorus', 'phaser', 'autoPan']) {
    fx[key] = source[key];
  }
  const pitch = status.nativePitch;
  return copyJson({ fx, pitch: pitch ? { enabled: pitch.enabled, trackId: pitch.trackId, semitones: pitch.semitones,
    mode: pitch.mode, reversePlayback: pitch.reversePlayback } : null });
}

export function createNativeRc505MemoryRuntime(port: NativeMemoryPort): Rc505MemoryRuntime {
  let preservedExtensions: Record<string, Rc505Json> = {};
  let preservedFields: Rc505MemoryDocument['semantics']['fields'] = {};
  const revision = () => `${port.status()?.projectContentRevision ?? 'unknown'}:${Transport.getInstance().projectMutationRevision}:${port.editRevision()}`;
  const assertStopped = (status: NativeStatus | null) => { const result = stopped(status); if (!result.allowed) throw new Error(result.reason); };
  return {
    revision,
    canSwitch: () => port.pendingEdits?.() ? { allowed: false, reason: 'Wait for pending Native FX edits before switching Memory.' } : stopped(port.status()),
    capture: async () => {
      if (port.pendingEdits?.()) throw new Error('Wait for pending Native FX edits before Memory capture.');
      const initial = await port.bridge.getStatus();
      if (!Number.isSafeInteger(initial.projectContentRevision) || initial.projectContentRevision! >= Number.MAX_SAFE_INTEGER) throw new Error('Native Memory revision is unavailable or exhausted.');
      assertStopped(initial);
      const settings = nativeSettings(initial);
      const before = initial.projectContentRevision;
      const local = port.editRevision();
      const transport = Transport.getInstance();
      const transportRevision = transport.projectMutationRevision;
      const tempo = transport.bpm;
      const meter: [number, number] = [...transport.timeSignature];
      const archive = await port.archive();
      const after = await port.bridge.getStatus();
      assertStopped(after);
      if (before !== after.projectContentRevision || after.projectContentRevisionSnapshotStable !== true
        || local !== port.editRevision() || transportRevision !== Transport.getInstance().projectMutationRevision) {
        throw new Error('Native Memory changed during capture.');
      }
      const fields: Record<string, Rc505MemoryField> = structuredClone(preservedFields);
      // NativeTrackProxy defaults are display placeholders, never device evidence.
      for (let track = 1; track <= 5; track += 1) {
        for (const key of ['level', 'pan', 'reverse', 'oneShot', 'tempoSync', 'loopSync', 'measure', 'startMode', 'stopMode']) {
          fields[`track.${track}.${key}`] ??= { value: null, availability: 'unsupported', reason: 'Native host does not implement this hardware setting.' };
        }
      }
      for (const address of ['record.overdubMode', 'record.quantize', 'play.allStart', 'play.allStop', 'routing.output', 'assign.controls', 'mixer.level']) {
        fields[address] ??= { value: null, availability: 'unsupported', reason: 'Native host does not implement this hardware setting.' };
      }
      for (let track = 1; track <= 5; track += 1) {
        fields[`track.${track}.level`] = { value: (settings.mixerLevels as Rc505Json[])[track + 1]!, availability: 'supported' };
        fields[`track.${track}.fxApply`] = { value: (settings.trackFxApply as Rc505Json[])[track - 1]!, availability: 'supported' };
      }
      fields['mixer.mainLevel'] = { value: (settings.mixerLevels as Rc505Json[])[0]!, availability: 'supported' };
      fields['mixer.masterLevel'] = { value: (settings.mixerLevels as Rc505Json[])[1]!, availability: 'supported' };
      if (settings.recAction !== undefined) fields['record.recAction'] = { value: settings.recAction, availability: 'supported' };
      fields['rhythm.settings'] = { value: settings.rhythm!, availability: 'supported' };
      fields['inputFx.bank'] = { value: (settings.banks as Rc505Json[])[0]!, availability: 'supported' };
      fields['trackFx.banks'] = { value: (settings.banks as Rc505Json[]).slice(1), availability: 'supported' };
      const bounceSettings = settings.bounce as { bounceSw: boolean; bounceIn: boolean[]; bounceTrack: boolean[] };
      fields['record.bounceSw'] = { value: bounceSettings.bounceSw, availability: 'supported' };
      for (let track = 1; track <= 5; track += 1) {
        fields[`track.${track}.bounceIn`] = { value: bounceSettings.bounceIn[track - 1]!, availability: 'supported' };
        fields[`track.${track}.bounceTrack`] = { value: bounceSettings.bounceTrack[track - 1]!, availability: 'supported' };
      }
      port.publish(after);
      return { version: 1, memoryNumber: null, name: '', archive,
        semantics: { tempo, meter, fields },
        extensions: { WEBRC: { ...structuredClone(preservedExtensions), nativeMemory: settings, nativeOutputState: outputSettings(initial) } } };
    },
    prepare: async (document: Rc505MemoryDocument, expectedRevision: string) => {
      if (port.pendingEdits?.() || revision() !== expectedRevision) throw new Error('Native Memory changed before preparation.');
      const expectedHostRevision = port.status()?.projectContentRevision;
      const current = await port.bridge.getStatus();
      assertStopped(current);
      if (current.projectContentRevision !== expectedHostRevision || current.projectContentRevisionSnapshotStable !== true) {
        throw new Error('Native Memory changed on the host before preparation.');
      }
      if (!document.extensions.WEBRC.nativeMemory) throw new Error('This Memory has no Native engine settings.');
      const settings = document.extensions.WEBRC.nativeMemory as Record<string, Rc505Json>;
      const expectedFields: Record<string, Rc505Json> = {
        'rhythm.settings': settings.rhythm!, 'inputFx.bank': (settings.banks as Rc505Json[])[0]!,
        'trackFx.banks': (settings.banks as Rc505Json[]).slice(1),
        'mixer.mainLevel': (settings.mixerLevels as Rc505Json[])[0]!, 'mixer.masterLevel': (settings.mixerLevels as Rc505Json[])[1]!,
      };
      if (settings.recAction !== undefined) expectedFields['record.recAction'] = settings.recAction;
      const bounceSettings = settings.bounce as { bounceSw: boolean; bounceIn: boolean[]; bounceTrack: boolean[] };
      expectedFields['record.bounceSw'] = bounceSettings.bounceSw;
      for (let track = 1; track <= 5; track += 1) {
        expectedFields[`track.${track}.fxApply`] = (settings.trackFxApply as Rc505Json[])[track - 1]!;
        expectedFields[`track.${track}.level`] = (settings.mixerLevels as Rc505Json[])[track + 1]!;
        expectedFields[`track.${track}.bounceIn`] = bounceSettings.bounceIn[track - 1]!;
        expectedFields[`track.${track}.bounceTrack`] = bounceSettings.bounceTrack[track - 1]!;
      }
      for (const [address, field] of Object.entries(document.semantics.fields)) {
        if (field.availability === 'supported' && (!(address in expectedFields) || JSON.stringify(field.value) !== JSON.stringify(expectedFields[address]))) {
          throw new Error(`Native Memory has an unsupported or inconsistent semantic field: ${address}`);
        }
      }
      const savedTransport = (await decodeProjectArchive(document.archive)).transport;
      const bytes = await encodeRc505Memory(document);
      const targetExtensions = structuredClone(document.extensions.WEBRC);
      const targetFields = structuredClone(document.semantics.fields);
      if (revision() !== expectedRevision) throw new Error('Native Memory changed during preparation.');
      const generation = await port.bridge.beginProjectArchiveImport(bytes, expectedHostRevision!);
      let state: 'prepared' | 'committed' | 'disposed' = 'prepared';
      return {
        commit: async () => {
          if (state !== 'prepared' || revision() !== expectedRevision) throw new Error('Native Memory candidate is stale.');
          await port.bridge.commitPreparedMemory(generation);
          const result = await port.bridge.waitForProjectArchiveImport(generation, 10_000);
          if (result.state !== 'committed') throw new Error(result.error || 'Native Memory generation was not committed.');
          state = 'committed';
          try {
          // The host ACK owns the target metadata even if later UI/readback
          // synchronization fails. A future capture combines this opaque data
          // with fresh authoritative Native settings and exact archive bytes.
          preservedExtensions = targetExtensions;
          preservedFields = targetFields;
          port.committed?.(generation);
          const deadline = Date.now() + 10_000;
          for (;;) {
            const status = await port.bridge.getStatus();
            port.publish(status);
            const gates = status.nativeFx?.trackFxApply;
            if (gates?.length === 5 && gates.every((gate) => gate.requestedRevision === gate.appliedRevision && gate.requested === gate.applied && !gate.controlFaulted)) {
              port.install?.(status);
              break;
            }
            if (Date.now() >= deadline) throw new Error(`Memory generation ${generation} committed, but FX gate render acknowledgements timed out.`);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          const transport = Transport.getInstance();
          transport.timeSignature = [...document.semantics.meter];
          transport.masterTrackId = savedTransport.masterTrackId;
          transport.measureLength = savedTransport.measureLengthSeconds;
          transport.masterLoopLengthSamples = savedTransport.masterLoopLengthSamples;
          transport.setBpm(document.semantics.tempo);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Rc505MemoryCommittedError(`Native Memory generation ${generation} committed; application synchronization failed: ${detail}`, generation, { cause: error });
          }
        },
        dispose: async () => {
          if (state === 'prepared') await port.bridge.cancelProjectArchiveImport(generation);
          state = 'disposed';
        },
      };
    },
  };
}
