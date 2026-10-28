import { Transport } from '../core/Transport';
import { decodeProjectArchive } from './projectArchive';
import { Rc505MemoryCommittedError, encodeRc505Memory, type Rc505Json, type Rc505MemoryDocument, type Rc505MemoryField, type Rc505MemoryRuntime } from './Rc505Memory';
import { isNativeHostIncarnationId, nativeProjectArchiveSha256, type NativeBridgeClient, type NativeCatalogSlotStatus, type NativeDubMode, type NativeStatus } from './NativeBridgeClient';
import { ProjectMemoryStore } from './projectMemoryStore';

export interface NativeMemoryPort {
  bridge: NativeBridgeClient;
  status(): NativeStatus | null;
  editRevision(): string;
  archive(): Promise<Uint8Array>;
  publish(status: NativeStatus, synchronizeRhythmBpm?: boolean): void;
  install?(status: NativeStatus): void;
  syncRhythmBpm?(bpm: number, hostIncarnationId: string): Promise<boolean>;
  suppressTransportSync?(): () => void;
  /** Host publication is confirmed; invalidate previous-generation UI ACKs before any readback. */
  committed?(generation: number): void;
  pendingEdits?(): boolean;
  persistOperationIntent?(operationId: string, hostIncarnationId: string, expectedProjectContentRevision: number, archiveSha256: string): Promise<void>;
  readOperationIntent?(operationId: string): Promise<{ operationId: string; hostIncarnationId: string; expectedProjectContentRevision: number; archiveSha256: string } | null>;
  listOperationIntents?(): Promise<readonly { operationId: string; hostIncarnationId: string; expectedProjectContentRevision: number; archiveSha256: string }[]>;
  clearOperationIntent?(operationId: string): Promise<void>;
}
const copyJson = (value: unknown): Rc505Json => JSON.parse(JSON.stringify(value)) as Rc505Json;

function stopped(status: NativeStatus | null): { allowed: boolean; reason: string } {
  const allowed = !!status?.engineRunning && status.nativeTracks?.length === 5
    && status.nativeTracks.every((track) => track.state === 'Empty' || track.state === 'Stopped');
  return { allowed, reason: allowed ? '' : 'Stop all five Native tracks before switching Memory.' };
}
function assertLoopTransportReadback(status: NativeStatus): void {
  const tracks = status.nativeTracks;
  const transports = status.nativeMemory?.loopTransports;
  if (!Array.isArray(tracks) || tracks.length !== 5 || !Array.isArray(transports) || transports.length !== 5) {
    throw new Error('Native host cannot confirm all five loop transport settings; Memory operation was refused.');
  }
  for (let index = 0; index < 5; index += 1) {
    const track = tracks.find((candidate) => candidate.trackId === index + 1);
    const requested = track?.loopTransportRequestedRevision;
    const applied = track?.loopTransportAppliedRevision;
    const fault = track?.loopTransportFaultRevision;
    const appliedOneShot = track?.loopTransportAppliedOneShot;
    const savedOneShot = transports[index]?.oneShot;
    const appliedReverse = track?.loopTransportAppliedReverse;
    const savedReverse = transports[index]?.reverse;
    if (typeof requested !== 'number' || typeof applied !== 'number' || typeof fault !== 'number'
      || !Number.isSafeInteger(requested) || !Number.isSafeInteger(applied) || !Number.isSafeInteger(fault)
      || (appliedOneShot !== undefined && typeof appliedOneShot !== 'boolean')
      || (savedOneShot !== undefined && typeof savedOneShot !== 'boolean')
      || ((appliedOneShot === undefined) !== (savedOneShot === undefined))) {
      throw new Error('Native host lacks complete loop transport revision/readback capability; Memory operation was refused.');
    }
    if (requested !== applied || (requested > 0 && fault === requested)) {
      throw new Error(`Wait for Track ${index + 1} Native loop transport callback acknowledgement before Memory capture or import.`);
    }
    // Older Native hosts had no 1SHOT control at all. Preserve their legacy
    // Memory compatibility only when both sides omit the field; the applied
    // revision pair is still required to prove the remaining transport config.
    if (appliedOneShot !== undefined && appliedOneShot !== savedOneShot) {
      throw new Error(`Track ${index + 1} Native loop transport readback is inconsistent; Memory operation was refused.`);
    }
    if ((appliedReverse !== undefined && typeof appliedReverse !== 'boolean')
      || (savedReverse !== undefined && typeof savedReverse !== 'boolean')
      || ((appliedReverse === undefined) !== (savedReverse === undefined))) {
      throw new Error('Native host lacks complete REVERSE readback capability; Memory operation was refused.');
    }
    if (appliedReverse !== undefined && appliedReverse !== savedReverse) {
      throw new Error(`Track ${index + 1} Native REVERSE readback is inconsistent; Memory operation was refused.`);
    }
  }
}
function nativeSettings(status: NativeStatus): Record<string, Rc505Json> {
  const native = status.nativeMemory;
  if (native?.version !== 1 || native.loopTransports.length !== 5 || !status.nativeRhythm) {
    throw new Error('Native host does not support atomic semantic Memory; update the host.');
  }
  assertLoopTransportReadback(status);
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
  const dubModes: NativeDubMode[] | undefined = native.dubModes === undefined
    ? undefined
    : native.dubModes.length === 5 && native.dubModes.every((mode): mode is NativeDubMode =>
      mode === 'OVERDUB' || mode === 'REPLACE1' || mode === 'REPLACE2')
      ? [...native.dubModes]
      : (() => { throw new Error('Native host returned invalid per-track DUB MODE Memory settings.'); })();
  if (dubModes) {
    for (let track = 1; track <= 5; track += 1) {
      const readback = status.nativeTracks?.find((item) => item.trackId === track)?.dubMode;
      if (!readback || readback.requested !== readback.applied || readback.requestedRevision !== readback.appliedRevision
        || readback.applied !== dubModes[track - 1]) {
        throw new Error(`Wait for Native Track ${track} DUB MODE callback acknowledgement before Memory capture.`);
      }
    }
  }
  return {
    ...(record?.recActionAvailable ? { recAction: record.recAction } : {}),
    trackFxApply: gates.map((gate) => gate.applied), mixerLevels: [...status.mixerLevels],
    banks, loopTransports: copyJson(native.loopTransports), ...(dubModes ? { dubModes } : {}),
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
  let preservedHostIncarnationId: string | null = null;
  const revision = () => {
    const status = port.status();
    return `${status?.hostIncarnationId ?? 'unknown'}:${status?.projectContentRevision ?? 'unknown'}:${Transport.getInstance().projectMutationRevision}:${port.editRevision()}`;
  };
  const assertStopped = (status: NativeStatus | null) => { const result = stopped(status); if (!result.allowed) throw new Error(result.reason); };
  return {
    revision,
    canSwitch: () => port.pendingEdits?.() ? { allowed: false, reason: 'Wait for pending Native FX edits before switching Memory.' } : stopped(port.status()),
    capture: async () => {
      if (port.pendingEdits?.()) throw new Error('Wait for pending Native FX edits before Memory capture.');
      const initial = await port.bridge.getStatus();
      if (!isNativeHostIncarnationId(initial.hostIncarnationId)) throw new Error('Native host incarnation is unavailable; Memory semantics cannot be safely captured.');
      if (preservedHostIncarnationId !== null && preservedHostIncarnationId !== initial.hostIncarnationId) {
        // Opaque data is meaningful only for the host that acknowledged its
        // import. A restarted host starts with a fresh semantic namespace.
        preservedExtensions = {};
        preservedFields = {};
        preservedHostIncarnationId = null;
      }
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
      if (initial.hostIncarnationId !== after.hostIncarnationId || before !== after.projectContentRevision || after.projectContentRevisionSnapshotStable !== true
        || local !== port.editRevision() || transportRevision !== Transport.getInstance().projectMutationRevision) {
        throw new Error('Native Memory changed during capture.');
      }
      const fields: Record<string, Rc505MemoryField> = structuredClone(preservedFields);
      // NativeTrackProxy defaults are display placeholders, never device evidence.
      for (let track = 1; track <= 5; track += 1) {
        for (const key of ['level', 'pan', 'reverse', 'oneShot', 'tempoSync', 'loopSync', 'measure', 'startMode', 'stopMode']) {
          fields[`track.${track}.${key}`] ??= { value: null, availability: 'unsupported', reason: 'Native host does not implement this hardware setting.' };
        }
        fields[`track.${track}.dubMode`] = settings.dubModes
          ? { value: (settings.dubModes as Rc505Json[])[track - 1]!, availability: 'supported' }
          : { value: null, availability: 'unsupported', reason: 'Native host does not implement DUB MODE Memory.' };
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
      const transport = Transport.getInstance();
      const operationStartTransportMutationRevision = transport.projectMutationRevision;
      const expectedHostRevision = port.status()?.projectContentRevision;
      const expectedHostIncarnationId = port.status()?.hostIncarnationId;
      const current = await port.bridge.getStatus();
      assertStopped(current);
      assertLoopTransportReadback(current);
      if (!isNativeHostIncarnationId(expectedHostIncarnationId) || !isNativeHostIncarnationId(current.hostIncarnationId) ||
          current.hostIncarnationId !== expectedHostIncarnationId ||
          current.projectContentRevision !== expectedHostRevision || current.projectContentRevisionSnapshotStable !== true) {
        throw new Error('Native Memory changed on the host before preparation.');
      }
      if (!document.extensions.WEBRC.nativeMemory) throw new Error('This Memory has no Native engine settings.');
      const settings = document.extensions.WEBRC.nativeMemory as Record<string, Rc505Json>;
      const dubModes: NativeDubMode[] | undefined = settings.dubModes === undefined
        ? undefined
        : Array.isArray(settings.dubModes) && settings.dubModes.length === 5
          && settings.dubModes.every((mode): mode is NativeDubMode => mode === 'OVERDUB' || mode === 'REPLACE1' || mode === 'REPLACE2')
          ? [...settings.dubModes]
          : (() => { throw new Error('Native Memory requires five valid per-track DUB MODE values.'); })();
      if (dubModes && (!current.nativeMemory?.dubModes || current.nativeMemory.dubModes.length !== 5)) {
        throw new Error('The connected Native host does not support DUB MODE Memory restore.');
      }
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
        if (dubModes) expectedFields[`track.${track}.dubMode`] = dubModes[track - 1]!;
      }
      if (dubModes) {
        for (let track = 1; track <= 5; track += 1) {
          const field = document.semantics.fields[`track.${track}.dubMode`];
          if (field?.availability !== 'supported' || field.value !== dubModes[track - 1]) {
            throw new Error(`Native Memory DUB MODE semantic field for Track ${track} is missing or inconsistent.`);
          }
        }
      }
      for (const [address, field] of Object.entries(document.semantics.fields)) {
        if (field.availability === 'supported' && (!(address in expectedFields) || JSON.stringify(field.value) !== JSON.stringify(expectedFields[address]))) {
          throw new Error(`Native Memory has an unsupported or inconsistent semantic field: ${address}`);
        }
      }
      const decodedArchive = await decodeProjectArchive(document.archive);
      const importHostStatus = await port.bridge.getStatus();
      if (!isNativeHostIncarnationId(importHostStatus.hostIncarnationId) ||
          importHostStatus.hostIncarnationId !== expectedHostIncarnationId ||
          importHostStatus.projectContentRevision !== expectedHostRevision) {
        throw new Error('Native host changed during Memory preparation; the prior Memory snapshot is preserved.');
      }
      if (decodedArchive.version === 2 && importHostStatus.projectArchiveV2Supported !== true) {
        throw new Error('This Native host does not advertise ProjectArchive v2 support; the archive was not uploaded and current loops were left unchanged. Use Browser mode or a Native host with v2 support.');
      }
      const savedTransport = decodedArchive.transport;
      const bytes = await encodeRc505Memory(document);
      const targetExtensions = structuredClone(document.extensions.WEBRC);
      const targetFields = structuredClone(document.semantics.fields);
      if (revision() !== expectedRevision || transport.projectMutationRevision !== operationStartTransportMutationRevision) {
        throw new Error('Native Memory or transport changed during preparation; no import was submitted.');
      }
      const operationIntentStore = new ProjectMemoryStore();
      const oldIntents = port.listOperationIntents
        ? await port.listOperationIntents()
        : await operationIntentStore.listNativeImportOperationIntents();
      for (const oldIntent of oldIntents) {
        if (oldIntent.hostIncarnationId !== expectedHostIncarnationId) {
          throw new Error('A previous Native Memory operation belongs to another host incarnation; preserve it and resolve status before another import.');
        }
        const oldStatus = await port.bridge.getProjectArchiveImportStatusByOperationId(oldIntent.operationId, oldIntent.hostIncarnationId);
        if (oldStatus.operationId !== oldIntent.operationId || oldStatus.hostIncarnationId !== oldIntent.hostIncarnationId ||
            oldStatus.expectedProjectContentRevision !== oldIntent.expectedProjectContentRevision || oldStatus.archiveSha256 !== oldIntent.archiveSha256) {
          throw new Error('A previous Native Memory operation fingerprint did not match the host; no new import was submitted.');
        }
        if (oldStatus.state !== 'cancelled') {
          throw new Error(`Native Memory operation ${oldIntent.operationId} remains ${oldStatus.state}; query/export it before another import.`);
        }
        await operationIntentStore.clearNativeImportOperationIntent(oldIntent.operationId);
      }
      const operationId = createNativeMemoryOperationId();
      const archiveSha256 = await nativeProjectArchiveSha256(bytes);
      if (port.persistOperationIntent) await port.persistOperationIntent(operationId, expectedHostIncarnationId, expectedHostRevision!, archiveSha256);
      else await operationIntentStore.persistNativeImportOperationIntent(operationId, expectedHostIncarnationId, expectedHostRevision!, archiveSha256);
      const persistedIntent = port.readOperationIntent
        ? await port.readOperationIntent(operationId)
        : await operationIntentStore.readNativeImportOperationIntent(operationId);
      if (!persistedIntent || persistedIntent.operationId !== operationId || persistedIntent.hostIncarnationId !== expectedHostIncarnationId ||
          persistedIntent.expectedProjectContentRevision !== expectedHostRevision || persistedIntent.archiveSha256 !== archiveSha256) {
        throw new Error('Native Memory operation intent did not round-trip from durable storage; no archive was uploaded.');
      }
      const acceptance = await port.bridge.beginProjectArchiveImport(bytes, expectedHostRevision!, expectedHostIncarnationId, operationId);
      const { generation } = acceptance;
      let releaseTransportSync = port.suppressTransportSync?.() ?? (() => undefined);
      const releaseSuppression = (): void => {
        releaseTransportSync();
        releaseTransportSync = () => undefined;
      };
      let state: 'prepared' | 'committed' | 'disposed' = 'prepared';
      return {
        commit: async () => {
          if (state !== 'prepared' || revision() !== expectedRevision ||
              transport.projectMutationRevision !== operationStartTransportMutationRevision) {
            releaseSuppression();
            throw new Error('Native Memory candidate is stale because project or transport changed before commit.');
          }
          try {
          await port.bridge.commitPreparedMemory(generation, acceptance.hostIncarnationId);
          const result = await port.bridge.waitForProjectArchiveImport(generation, acceptance.hostIncarnationId, 10_000);
          if (result.state === 'unavailable') throw new Error('Native host restarted during Memory commit; status is unverifiable and no follow-up sync was applied.');
          if (result.state !== 'committed') throw new Error(result.error || 'Native Memory generation was not committed.');
          // The same-incarnation committed ACK makes B the authoritative
          // opaque payload even if later readback or local synchronization
          // fails. Never let a prior candidate A leak into future captures.
          preservedExtensions = targetExtensions;
          preservedFields = targetFields;
          preservedHostIncarnationId = acceptance.hostIncarnationId;
          state = 'committed';
          try {
          port.committed?.(generation);
          const deadline = Date.now() + 10_000;
          const readbackAcknowledged = (status: NativeStatus): boolean => {
            const gates = status.nativeFx?.trackFxApply;
            const bounce = status.nativeBounce;
            const bounceAcknowledged = bounce && bounce.requestedRevision === bounce.appliedRevision;
            const targetDubModes = (settings.dubModes as NativeDubMode[] | undefined)
              ?? (status.nativeMemory?.dubModes ? Array.from({ length: 5 }, () => 'OVERDUB' as NativeDubMode) : undefined);
            const dubModesAcknowledged = !targetDubModes || targetDubModes.length === 5
              && status.nativeMemory?.dubModes?.length === 5
              && targetDubModes.every((mode, index) => {
                const readback = status.nativeTracks?.find((track) => track.trackId === index + 1)?.dubMode;
                return status.nativeMemory!.dubModes![index] === mode && readback?.requested === mode && readback.applied === mode
                  && readback.requestedRevision === readback.appliedRevision;
              });
            return Boolean(bounceAcknowledged && dubModesAcknowledged && gates?.length === 5
              && gates.every((gate) => gate.requestedRevision === gate.appliedRevision && gate.requested === gate.applied && !gate.controlFaulted));
          };
          for (;;) {
            const status = await port.bridge.getStatus();
            if (!isNativeHostIncarnationId(status.hostIncarnationId) || status.hostIncarnationId !== acceptance.hostIncarnationId) {
              throw new Error('Native host restarted during Memory readback; generation status is unverifiable and no stale settings were installed.');
            }
            port.publish(status, false);
            if (readbackAcknowledged(status)) {
              if (transport.projectMutationRevision !== operationStartTransportMutationRevision) {
                throw new Error('Native Memory committed, but transport changed during callback acknowledgement; imported transport was not applied and archive BPM was not synchronized to Native rhythm, preserving the user edit.');
              }
              if (!status.nativeRhythm?.available) {
                throw new Error('Native Memory committed, but Native rhythm readback is unavailable; archive BPM was not synchronized and transport metadata was not applied.');
              }
              if (status.nativeRhythm.bpm !== document.semantics.tempo) {
                if (!port.syncRhythmBpm || !await port.syncRhythmBpm(document.semantics.tempo, acceptance.hostIncarnationId)) {
                  throw new Error('Native Memory committed, but archive BPM was not acknowledged by Native rhythm; transport metadata was not synchronized.');
                }
                if (transport.projectMutationRevision !== operationStartTransportMutationRevision) {
                  throw new Error('Native rhythm acknowledged archive BPM while the user changed transport; the user transport was preserved, and rhythm may still be set to the imported archive BPM.');
                }
              }
              // Close the window between the ACK poll and semantic installation
              // with a second, final readback from the same host incarnation.
              const finalStatus = await port.bridge.getStatus();
              if (!isNativeHostIncarnationId(finalStatus.hostIncarnationId) || finalStatus.hostIncarnationId !== acceptance.hostIncarnationId) {
                throw new Error('Native host restarted before Memory installation; generation status is unverifiable and no stale settings were installed.');
              }
              if (transport.projectMutationRevision !== operationStartTransportMutationRevision) {
                throw new Error('Native Memory committed, but transport changed before final synchronization; imported transport was not applied and Native rhythm may remain at the imported archive BPM.');
              }
              if (readbackAcknowledged(finalStatus) &&
                  finalStatus.nativeRhythm?.available === true && finalStatus.nativeRhythm.bpm === document.semantics.tempo) {
                // Commit opaque target metadata only after all ACKs survive the
                // final same-incarnation readback.
                preservedExtensions = targetExtensions;
                preservedFields = targetFields;
                preservedHostIncarnationId = acceptance.hostIncarnationId;
                port.publish(finalStatus, false);
                port.install?.(finalStatus);
                break;
              }
            }
            if (Date.now() >= deadline) throw new Error(`Memory generation ${generation} committed, but DUB MODE, Bounce, or FX gate render acknowledgements timed out.`);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (transport.projectMutationRevision !== operationStartTransportMutationRevision) {
            throw new Error('Native Memory committed, but transport changed before local transport update; user values were preserved.');
          }
          transport.timeSignature = [...document.semantics.meter];
          transport.masterTrackId = savedTransport.masterTrackId;
          transport.measureLength = savedTransport.measureLengthSeconds;
          transport.masterLoopLengthSamples = savedTransport.masterLoopLengthSamples;
          transport.setBpm(document.semantics.tempo);
          if (port.clearOperationIntent) await port.clearOperationIntent(operationId);
          else await operationIntentStore.clearNativeImportOperationIntent(operationId);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Rc505MemoryCommittedError(`Native Memory generation ${generation} committed; application synchronization failed: ${detail}`, generation, { cause: error });
          }
          } finally {
            releaseSuppression();
          }
        },
        dispose: async () => {
          try {
            if (state === 'prepared') await port.bridge.cancelProjectArchiveImport(generation, acceptance.hostIncarnationId);
          } finally {
            releaseSuppression();
            state = 'disposed';
          }
        },
      };
    },
  };
}

function createNativeMemoryOperationId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('Secure Native Memory operation identifiers are unavailable; no archive was uploaded.');
  }
  return crypto.randomUUID().replace(/-/g, '').toLowerCase();
}
