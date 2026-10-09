import {
  DEFAULT_CONTROL_STATE,
  PROJECT_MEMORY_SLOT_MAX,
  PROJECT_MEMORY_SLOT_MIN,
  PROJECT_SCHEMA_VERSION,
  PROJECT_TRACK_COUNT,
  type ProjectGlobalSettings,
  type ProjectDocument,
  type ProjectFxUnit,
  type ProjectMemoryRecord,
} from './projectTypes';
import { isBlobLike } from './blobUtils';
import { assertControlState } from '../controls/commandDispatcher';
import { parseBrowserRoutingState } from '../audio/browserRouting';

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function finite(value: unknown, label: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${label} must be a finite number between ${min} and ${max}.`);
  }
  return value;
}

function text(value: unknown, label: string, maxLength = 1024): string {
  if (typeof value !== 'string' || value.length > maxLength) throw new TypeError(`${label} must be a string of at most ${maxLength} characters.`);
  return value;
}

function validateFxUnit(value: unknown, label: string): asserts value is ProjectFxUnit {
  const fx = record(value, label);
  text(fx.type, `${label}.type`, 64);
  if (typeof fx.enabled !== 'boolean') throw new TypeError(`${label}.enabled must be boolean.`);
  const params = record(fx.params, `${label}.params`);
  for (const [key, parameter] of Object.entries(params)) {
    text(key, `${label}.params key`, 64);
    finite(parameter, `${label}.params.${key}`);
  }
}

/** Validates imported JSON before any audio allocations or engine mutations. */
export function assertProjectDocument(value: unknown): asserts value is ProjectDocument {
  const document = record(value, 'project');
  if (document.schemaVersion !== PROJECT_SCHEMA_VERSION) throw new TypeError(`Unsupported project schema version: ${String(document.schemaVersion)}`);
  text(document.id, 'project.id', 128);
  text(document.name, 'project.name', 256);
  text(document.createdAt, 'project.createdAt', 64);
  text(document.updatedAt, 'project.updatedAt', 64);

  const global = record(document.global, 'project.global');
  finite(global.bpm, 'project.global.bpm', 40, 300);
  if (global.masterTrackId !== null && (!Number.isInteger(global.masterTrackId) || Number(global.masterTrackId) < 1 || Number(global.masterTrackId) > PROJECT_TRACK_COUNT)) {
    throw new TypeError('project.global.masterTrackId must be null or a track id from 1 through 5.');
  }
  finite(global.autoRecSens, 'project.global.autoRecSens', 1, 100);
  finite(global.bounceTrack, 'project.global.bounceTrack', 1, 5);
  finite(global.currentTrack, 'project.global.currentTrack', 1, 5);
  validateGlobalEnums(global as unknown as ProjectGlobalSettings);
  text(global.fadeTimeIn, 'project.global.fadeTimeIn', 32);
  text(global.fadeTimeOut, 'project.global.fadeTimeOut', 32);
  if (typeof global.loopLength !== 'string') finite(global.loopLength, 'project.global.loopLength', 0);
  else text(global.loopLength, 'project.global.loopLength', 32);
  for (const key of ['allStartTrk', 'allStopTrk']) {
    const flags = global[key];
    if (!Array.isArray(flags) || flags.length !== PROJECT_TRACK_COUNT || flags.some((flag) => typeof flag !== 'boolean')) {
      throw new TypeError(`project.global.${key} must contain five booleans.`);
    }
  }

  const routing = record(document.routing, 'project.routing');
  for (const key of ['inputMic1', 'inputMic2', 'inputInst1L', 'inputInst1R', 'inputInst2L', 'inputInst2R', 'inputRhythm']) {
    if (routing[key] !== 'ON' && routing[key] !== 'OFF') throw new TypeError(`project.routing.${key} must be ON or OFF.`);
  }
  if (typeof routing.monitoringEnabled !== 'boolean') throw new TypeError('project.routing.monitoringEnabled must be boolean.');
  for (const key of ['inputDeviceId', 'outputDeviceId']) {
    if (routing[key] !== null) text(routing[key], `project.routing.${key}`, 512);
  }
  if (routing.engine !== undefined) {
    const engineRouting = parseBrowserRoutingState(routing.engine);
    if (engineRouting.outputs.main.sinkId !== routing.outputDeviceId) {
      throw new TypeError('project.routing.outputDeviceId must match the browser routing main sink.');
    }
  }

  const mixer = record(document.mixer, 'project.mixer');
  finite(mixer.masterLevel, 'project.mixer.masterLevel', 0, 2);
  if (!Array.isArray(mixer.tracks) || mixer.tracks.length !== PROJECT_TRACK_COUNT) throw new TypeError('project.mixer.tracks must contain five tracks.');
  mixer.tracks.forEach((value, index) => {
    const track = record(value, `project.mixer.tracks[${index}]`);
    if (track.trackId !== index + 1) throw new TypeError('Mixer tracks must be ordered from 1 through 5.');
    finite(track.level, 'mixer track level', 0, 2);
    finite(track.pan, 'mixer track pan', -1, 1);
    if (typeof track.muted !== 'boolean' || typeof track.solo !== 'boolean') throw new TypeError('Mixer mute/solo fields must be boolean.');
  });

  text(document.activeFxBankId, 'project.activeFxBankId', 128);
  if (!Array.isArray(document.fxBanks) || document.fxBanks.length !== 4) throw new TypeError('project.fxBanks must contain exactly four banks.');
  for (const [bankIndex, value] of document.fxBanks.entries()) {
    const bank = record(value, `project.fxBanks[${bankIndex}]`);
    text(bank.id, `project.fxBanks[${bankIndex}].id`, 128);
    text(bank.name, `project.fxBanks[${bankIndex}].name`, 256);
    for (const key of ['input', 'track', 'output']) {
      const slots = bank[key];
      if (!Array.isArray(slots) || slots.length !== 4) throw new TypeError(`FX bank ${key} must contain four slots.`);
      slots.forEach((slot, index) => { if (slot !== null) validateFxUnit(slot, `fxBanks[${bankIndex}].${key}[${index}]`); });
    }
  }
  if (!document.fxBanks.some((bank) => (bank as { id?: unknown }).id === document.activeFxBankId)) throw new TypeError('project.activeFxBankId must reference an FX bank.');
  for (const key of ['inputFxChain', 'masterFxChain']) {
    const chain = record(document[key], `project.${key}`);
    Object.entries(chain).forEach(([name, unit]) => validateFxUnit(unit, `project.${key}.${name}`));
  }

  if (!Array.isArray(document.tracks) || document.tracks.length !== PROJECT_TRACK_COUNT) throw new TypeError('project.tracks must contain exactly five tracks.');
  document.tracks.forEach((value, index) => {
    const track = record(value, `project.tracks[${index}]`);
    if (track.id !== index + 1) throw new TypeError('Project tracks must be ordered from 1 through 5.');
    text(track.name, `project.tracks[${index}].name`, 128);
    if (track.audioAssetId !== null) text(track.audioAssetId, `project.tracks[${index}].audioAssetId`, 128);
    const settings = record(track.settings, `project.tracks[${index}].settings`);
    finite(settings.pan, 'track pan', -50, 50);
    finite(settings.playLevel, 'track playLevel', 0, 200);
    finite(settings.filterValue, 'track filterValue', 0, 1);
    finite(settings.filterResonance, 'track filterResonance', 0, 1);
    finite(settings.loopFrames, 'track loopFrames', 0, 259_200_000);
    if (!Number.isInteger(settings.loopFrames)) throw new TypeError('track loopFrames must be an integer.');
    for (const key of ['loopSyncSw', 'tempoSyncSw', 'fxSw']) {
      if (settings[key] !== 'ON' && settings[key] !== 'OFF') throw new TypeError(`track setting ${key} must be ON or OFF.`);
    }
    if (!['HALF', 'NORMAL', 'DOUBLE'].includes(String(settings.tempoSyncSpeed))) throw new TypeError('track tempoSyncSpeed is invalid.');
    if (typeof settings.filterEnabled !== 'boolean') throw new TypeError('Track filterEnabled must be boolean.');
    const measure = record(settings.measure, 'track measure');
    if (!['AUTO', 'FREE', 'NOTE'].includes(String(measure.type))) throw new TypeError('track measure type is invalid.');
    if (measure.value !== undefined) text(measure.value, 'track measure.value', 32);
    validateRuntimeSettings(settings.runtime, `project.tracks[${index}].settings.runtime`);
    const fxChain = record(settings.fxChain, 'track fxChain');
    Object.entries(fxChain).forEach(([name, unit]) => validateFxUnit(unit, `track fxChain.${name}`));
    if (!Array.isArray(settings.fxSlots) || settings.fxSlots.length !== 4) throw new TypeError('track fxSlots must contain four slots.');
    settings.fxSlots.forEach((slot, slotIndex) => { if (slot !== null) validateFxUnit(slot, `track fxSlots[${slotIndex}]`); });
  });

  assertControlState(document.controlState);
  const extensions = record(document.extensions, 'project.extensions');
  if (Object.keys(extensions).length > 128) throw new TypeError('project.extensions exceeds the extension count limit.');
}

function validateGlobalEnums(global: ProjectGlobalSettings): void {
  const enums: Record<string, readonly string[]> = {
    loopSyncMode: ['IMMEDIATE', 'MEASURE', 'LOOP LENGTH'],
    tempoSyncMode: ['PITCH', 'XFADE'],
    bounceIn: ['ON', 'OFF'],
    playMode: ['MULTI', 'SINGLE'],
    recAction: ['REC->DUB', 'REC->PLAY'],
    quantize: ['OFF', 'MEASURE'],
    autoRecSw: ['ON', 'OFF'],
    bounceSw: ['ON', 'OFF'],
    singleTrackChange: ['IMMEDIATE', 'LOOP END', 'MEASURE'],
    speedChange: ['IMMEDIATE', 'LOOP_END'],
    syncAdjust: ['MEASURE', 'BEAT'],
  };
  for (const [key, allowed] of Object.entries(enums)) {
    if (!allowed.includes(String((global as unknown as Record<string, unknown>)[key]))) throw new TypeError(`project.global.${key} is invalid.`);
  }
  if (!['AUTO', 'FREE'].includes(String(global.loopLength)) && !/^[1-9]\d*$/.test(String(global.loopLength))) {
    throw new TypeError('project.global.loopLength must be AUTO, FREE, or a positive measure count.');
  }
  if (!/^(OFF|[1-9]\d*MEAS|[1-9]\d*BEAT)$/.test(global.fadeTimeIn) || !/^(OFF|[1-9]\d*MEAS|[1-9]\d*BEAT)$/.test(global.fadeTimeOut)) {
    throw new TypeError('Project fade time is invalid.');
  }
}

function validateRuntimeSettings(value: unknown, label: string): void {
  const runtime = record(value, label);
  for (const key of ['reverse', 'oneShot', 'keepPitch']) {
    if (typeof runtime[key] !== 'boolean') throw new TypeError(`${label}.${key} must be boolean.`);
  }
  if (runtime.startMode !== 'IMMEDIATE' && runtime.startMode !== 'FADE') throw new TypeError(`${label}.startMode is invalid.`);
  if (!['IMMEDIATE', 'FADE', 'LOOP'].includes(String(runtime.stopMode))) throw new TypeError(`${label}.stopMode is invalid.`);
  if (!['OVERDUB', 'REPLACE1', 'REPLACE2'].includes(String(runtime.dubMode))) throw new TypeError(`${label}.dubMode is invalid.`);
  if (typeof runtime.tempoSyncEnabled !== 'boolean') throw new TypeError(`${label}.tempoSyncEnabled must be boolean.`);
  if (!['HALF', 'NORMAL', 'DOUBLE'].includes(String(runtime.tempoSyncSpeed))) throw new TypeError(`${label}.tempoSyncSpeed is invalid.`);
  if (!['PITCH', 'XFADE'].includes(String(runtime.tempoSyncMode))) throw new TypeError(`${label}.tempoSyncMode is invalid.`);
  if (runtime.recordBpm !== null) finite(runtime.recordBpm, `${label}.recordBpm`, 1, 300);
  finite(runtime.fadeInMs, `${label}.fadeInMs`, 0, 10_000);
  finite(runtime.fadeOutMs, `${label}.fadeOutMs`, 0, 10_000);
  finite(runtime.speed, `${label}.speed`, 0.25, 4);
  const autoRec = record(runtime.autoRec, `${label}.autoRec`);
  if (typeof autoRec.enabled !== 'boolean') throw new TypeError(`${label}.autoRec.enabled must be boolean.`);
  finite(autoRec.threshold, `${label}.autoRec.threshold`, 0, 1);
  const debounce = finite(autoRec.debounceMs, `${label}.autoRec.debounceMs`, 1, 1000);
  if (!Number.isInteger(debounce)) throw new TypeError(`${label}.autoRec.debounceMs must be an integer.`);
}

export function cloneProjectDocument(document: ProjectDocument): ProjectDocument {
  return JSON.parse(JSON.stringify(document)) as ProjectDocument;
}

export function assertMemorySlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < PROJECT_MEMORY_SLOT_MIN || slot > PROJECT_MEMORY_SLOT_MAX) {
    throw new RangeError(`Memory slot must be an integer from ${PROJECT_MEMORY_SLOT_MIN} through ${PROJECT_MEMORY_SLOT_MAX}.`);
  }
}

export function assertProjectMemoryRecord(value: unknown): asserts value is ProjectMemoryRecord {
  const candidate = record(value, 'memory record');
  assertMemorySlot(finite(candidate.slot, 'memory slot', PROJECT_MEMORY_SLOT_MIN, PROJECT_MEMORY_SLOT_MAX));
  text(candidate.name, 'memory name', 256);
  text(candidate.updatedAt, 'memory updatedAt', 64);
  assertProjectDocument(candidate.document);
  const assets = record(candidate.audioAssets, 'memory audioAssets');
  const ids = new Set(candidate.document.tracks.map((track) => track.audioAssetId).filter((id): id is string => id !== null));
  for (const id of ids) {
    if (!isBlobLike(assets[id])) {
      throw new TypeError(`Memory audio asset "${id}" is missing or invalid.`);
    }
  }
  if (Object.keys(assets).some((id) => !ids.has(id))) throw new TypeError('Memory record contains unreferenced audio assets.');
}

export function createDefaultProjectDocument(name = 'Untitled Project', now = new Date()): ProjectDocument {
  const stamp = now.toISOString();
  const projectId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `project-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: projectId,
    name,
    createdAt: stamp,
    updatedAt: stamp,
    global: {
      bpm: 120,
      masterTrackId: null,
      loopSyncMode: 'MEASURE',
      tempoSyncMode: 'PITCH',
      bounceIn: 'OFF',
      playMode: 'MULTI',
      recAction: 'REC->DUB',
      quantize: 'OFF',
      autoRecSw: 'OFF',
      autoRecSens: 50,
      bounceSw: 'OFF',
      bounceTrack: 5,
      singleTrackChange: 'IMMEDIATE',
      currentTrack: 1,
      fadeTimeIn: '2MEAS',
      fadeTimeOut: '2MEAS',
      allStartTrk: [false, false, false, false, false],
      allStopTrk: [false, false, false, false, false],
      loopLength: 'AUTO',
      speedChange: 'IMMEDIATE',
      syncAdjust: 'MEASURE',
    },
    routing: {
      inputMic1: 'ON', inputMic2: 'ON', inputInst1L: 'ON', inputInst1R: 'ON',
      inputInst2L: 'ON', inputInst2R: 'ON', inputRhythm: 'ON',
      monitoringEnabled: false, inputDeviceId: null, outputDeviceId: null,
      engine: {
        version: 1,
        sources: [],
        inputChannels: [],
        routes: [],
        outputs: {
          main: { available: true, enabled: true, sinkId: null, availableSinks: [] },
          sub: { available: false, enabled: false, sinkId: null, availableSinks: [] },
          headphones: { available: false, enabled: false, sinkId: null, availableSinks: [] },
        },
      },
    },
    mixer: {
      masterLevel: 1,
      tracks: Array.from({ length: 5 }, (_, i) => ({ trackId: i + 1, level: 1, pan: 0, muted: false, solo: false })),
    },
    activeFxBankId: 'bank-1',
    fxBanks: Array.from({ length: 4 }, (_, index) => ({
      id: `bank-${index + 1}`,
      name: `Bank ${index + 1}`,
      input: [null, null, null, null],
      track: [null, null, null, null],
      output: [null, null, null, null],
    })),
    tracks: Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      name: `Track ${i + 1}`,
      audioAssetId: null,
      settings: {
        measure: { type: 'AUTO' },
        loopSyncSw: 'OFF', tempoSyncSw: 'ON', tempoSyncSpeed: 'NORMAL',
        pan: 0, playLevel: 100, fxSw: 'ON',
        filterEnabled: false, filterValue: 0.5, filterResonance: 1,
        loopFrames: 0,
        runtime: {
          reverse: false, oneShot: false, startMode: 'IMMEDIATE', stopMode: 'IMMEDIATE',
          fadeInMs: 0, fadeOutMs: 0, speed: 1, keepPitch: false,
          tempoSyncEnabled: true, tempoSyncSpeed: 'NORMAL', tempoSyncMode: 'PITCH', recordBpm: null,
          autoRec: { enabled: false, threshold: 0.5, debounceMs: 100 }, dubMode: 'OVERDUB',
        },
        fxChain: {
          compressor: { type: 'COMPRESSOR', enabled: false, params: { amount: 0, thresholdDb: -24, ratio: 4, kneeDb: 30, attackSeconds: 0.003, releaseSeconds: 0.25 } },
          filter: { type: 'FILTER', enabled: false, params: { frequency: 0.5, resonance: 1 } },
          delay: { type: 'DELAY', enabled: false, params: { time: 0.25, feedback: 0.2, mix: 0 } },
          reverb: { type: 'REVERB', enabled: false, params: { decay: 1, mix: 0 } },
        },
        fxSlots: [null, null, null, null],
      },
    })),
    inputFxChain: createDefaultFxChain(),
    masterFxChain: createDefaultFxChain(),
    controlState: { version: DEFAULT_CONTROL_STATE.version, assignments: [...DEFAULT_CONTROL_STATE.assignments] },
    extensions: {},
  };
}

function createDefaultFxChain(): ProjectDocument['inputFxChain'] {
  return {
    compressor: { type: 'COMPRESSOR', enabled: false, params: { amount: 0, thresholdDb: -24, ratio: 4, kneeDb: 30, attackSeconds: 0.003, releaseSeconds: 0.25 } },
    filter: { type: 'FILTER', enabled: false, params: { frequency: 0.5, resonance: 1 } },
    delay: { type: 'DELAY', enabled: false, params: { time: 0.25, feedback: 0.2, mix: 0 } },
    reverb: { type: 'REVERB', enabled: false, params: { decay: 1, mix: 0 } },
  };
}
