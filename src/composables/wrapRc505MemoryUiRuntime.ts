import { Rc505MemoryCommittedError, type Rc505Json, type Rc505MemoryDocument, type Rc505MemoryRuntime } from '../audio/Rc505Memory';
import { nativeCatalogEffectId, nativeCatalogMacroParameters } from '../audio/nativeFxCatalog';
import { FX_PRESET_BANK_IDS, fxPresetBankStorageKey, parseFxPresetBankDocument,
  type FxPresetBankDocument, type FxPresetLocation, type FxPresetRuntime } from '../ui/rc505/Rc505FxBankStore';
import type { Rc505FxSwitchSettings } from '../ui/rc505/Rc505FxSwitchController';

export interface Rc505MemoryBankUiPort {
  revision(): string;
  canCapture(): boolean;
  capture(): FxPresetBankDocument;
  validate(document: FxPresetBankDocument): void;
  /** Pure UI adoption: never submit FX controls or persist storage from this method. */
  adopt(document: FxPresetBankDocument, storageError?: string, notice?: string): void;
  finishAdoption?(): void;
}
export type Rc505MemorySwitchSnapshot = Record<FxPresetLocation, Record<'A' | 'B' | 'C' | 'D', Rc505FxSwitchSettings>>;
export interface Rc505MemorySwitchUiPort {
  revision(): string;
  capture(): Rc505MemorySwitchSnapshot;
  adopt(snapshot: Rc505MemorySwitchSnapshot, banks: Record<FxPresetLocation, string | null>, storageError?: string): void;
}
interface UiSnapshot {
  version: 1;
  runtime: FxPresetRuntime;
  banks: Record<FxPresetLocation, FxPresetBankDocument>;
  switches: Rc505MemorySwitchSnapshot;
}
const bankPorts = new Map<string, Set<Rc505MemoryBankUiPort>>();
const switchPorts = new Map<FxPresetRuntime, Rc505MemorySwitchUiPort>();
const wrapped = new WeakMap<Rc505MemoryRuntime, Map<FxPresetRuntime, Rc505MemoryRuntime>>();
const afterCommitCallbacks = new WeakMap<Rc505MemoryRuntime, Map<FxPresetRuntime, () => Promise<void>>>();
const locations: FxPresetLocation[] = ['input', 'track'];
const sidecarKey = 'rc505FxUi';
const keyFor = (runtime: FxPresetRuntime, location: FxPresetLocation) => `${runtime}:${location}`;
const switchKey = (runtime: FxPresetRuntime, location: FxPresetLocation, bank: string) => `webrc505_fx_switch_v1_${runtime}_${location}_${bank}`;
const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
};
export function registerRc505MemoryBankUiPort(runtime: FxPresetRuntime, location: FxPresetLocation, port: Rc505MemoryBankUiPort): () => void {
  const key = keyFor(runtime, location), ports = bankPorts.get(key) ?? new Set(); ports.add(port); bankPorts.set(key, ports);
  return () => { ports.delete(port); if (!ports.size) bankPorts.delete(key); };
}
export function registerRc505MemorySwitchUiPort(runtime: FxPresetRuntime, port: Rc505MemorySwitchUiPort): void { switchPorts.set(runtime, port); }

function requirePorts(runtime: FxPresetRuntime): { banks: Record<FxPresetLocation, Rc505MemoryBankUiPort[]>; switches: Rc505MemorySwitchUiPort } {
  const banks = Object.fromEntries(locations.map((location) => [location, [...(bankPorts.get(keyFor(runtime, location)) ?? [])]])) as Record<FxPresetLocation, Rc505MemoryBankUiPort[]>;
  const switches = switchPorts.get(runtime);
  if (!switches || locations.some((location) => !banks[location].length)) throw new Error('Initialize both runtime FX bank panels before using semantic Memory.');
  return { banks, switches };
}
function validateSwitch(value: unknown): asserts value is Rc505FxSwitchSettings {
  const setting = value as Rc505FxSwitchSettings;
  if (!setting || typeof setting !== 'object' || Object.keys(setting).sort().join(',') !== 'mode,switchModes'
    || !['SINGLE', 'MULTI'].includes(setting.mode) || !setting.switchModes
    || Object.keys(setting.switchModes).sort().join(',') !== 'A,B,C,D'
    || FX_PRESET_BANK_IDS.some((id) => !['TOGGLE', 'MOMENT'].includes(setting.switchModes[id]))) throw new Error('Memory FX switch settings are invalid.');
}
function validateSnapshot(raw: unknown, runtime: FxPresetRuntime): UiSnapshot {
  const value = raw as UiSnapshot;
  if (!value || value.version !== 1 || value.runtime !== runtime || !value.banks || !value.switches
    || Object.keys(value).sort().join(',') !== 'banks,runtime,switches,version'
    || Object.keys(value.banks).sort().join(',') !== 'input,track' || Object.keys(value.switches).sort().join(',') !== 'input,track') throw new Error('Memory has no complete runtime FX UI sidecar.');
  const copy = structuredClone(value);
  const safe = (item: unknown, depth = 0): boolean => {
    if (depth > 12) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= 8192;
    if (Array.isArray(item)) return item.length <= 4096 && item.every((entry) => safe(entry, depth + 1));
    return !!item && typeof item === 'object' && Object.entries(item).every(([key, entry]) => !['__proto__', 'constructor', 'prototype'].includes(key) && safe(entry, depth + 1));
  };
  if (!safe(copy) || JSON.stringify(copy).length > 128 * 1024) throw new Error('Memory FX sidecar contains unsupported or oversized values.');
  for (const location of locations) {
    const document = copy.banks[location];
    const parsed = parseFxPresetBankDocument(JSON.stringify(document), runtime, location);
    if (!parsed || stable(parsed) !== stable(document) || Object.keys(document.banks).sort().join(',') !== 'A,B,C,D') throw new Error('Memory FX bank document is invalid or contains unsupported fields.');
    for (const profile of Object.values(document.banks)) for (const slot of profile.slots) {
      const keys = ['id', 'type', 'value', 'active', 'stepSlicerParameters', 'preampParameters', 'synthParameters', 'g2bParameters', 'rollParameters', 'freezeParameters',
        'pitchBendParameters', 'manualHarmonistParameters', 'octaveParameters', 'vocoderParameters', 'oscVocParameters', 'autoRiffParameters', 'robotParameters', 'hrmAutoParameters', 'electricParameters', 'namedParametersByType'];
      if (slot.value < 0 || slot.value > 100 || slot.type.length > 128 || Object.keys(slot).some((key) => !keys.includes(key))) throw new Error('Memory FX bank controls exceed their supported schema.');
    }
    if (Object.keys(copy.switches[location]).sort().join(',') !== 'A,B,C,D') throw new Error('Memory requires switch settings for all four FX banks.');
    for (const bank of FX_PRESET_BANK_IDS) validateSwitch(copy.switches[location][bank]);
  }
  return copy;
}
function validateActiveProfiles(snapshot: UiSnapshot, document: Rc505MemoryDocument): void {
  const extension = document.extensions.WEBRC as Record<string, any>;
  for (const [index, location] of locations.entries()) {
    const bankDocument = snapshot.banks[location];
    if (bankDocument.activeBank === null) continue; // Unknown confirmation remains visibly unconfirmed.
    const profile = bankDocument.banks[bankDocument.activeBank];
    let unproven = false;
    const actual = snapshot.runtime === 'browser'
      ? (location === 'input' ? extension.browserMemory?.fx?.input : extension.browserMemory?.fx?.sharedTrack)
      : extension.nativeMemory?.banks?.[index];
    if (!Array.isArray(actual) || actual.length !== 4) throw new Error('Memory engine settings cannot validate the selected FX bank.');
    profile.slots.forEach((slot, slotIndex) => {
      const saved = actual[slotIndex];
      const type = slot.type === 'NONE' ? '' : slot.type;
      const matches = snapshot.runtime === 'browser'
        ? (saved.type ?? '') === type && saved.active === (type ? slot.active : false)
          && (!profile.browserParameters || stable(profile.browserParameters[slotIndex] ?? {}) === stable(saved.parameters))
        : (saved.effectId ?? null) === (type ? nativeCatalogEffectId(type) : null) && saved.bypassed === (type ? !slot.active : false);
      if (!matches) throw new Error(`Memory ${location} selected FX bank disagrees with the captured engine configuration.`);
      if (!type) return;
      const authored = slot.namedParametersByType?.[slot.type] ?? {};
      if (Object.entries(authored).some(([key, value]) => saved.parameters[key] !== value)) throw new Error(`Memory ${location} bank named controls contradict its engine snapshot.`);
      // Typed editor objects use adapter-specific aliases. Without an exact
      // conversion proof, retain the profile but never assert its bank identity.
      if (Object.keys(slot).some((key) => key !== 'namedParametersByType' && key.endsWith('Parameters'))) unproven = true;
      if (snapshot.runtime === 'native') {
        const proof = profile.nativeParameters?.[slotIndex];
        if (!proof) { unproven = true; return; }
        if (stable(proof) !== stable(saved.parameters)) throw new Error(`Memory ${location} Native FX proof contradicts its engine snapshot.`);
        const expected = { ...nativeCatalogMacroParameters(slot.type, slot.value), ...authored };
        const derivedClock = new Set(['bpm', 'tempo', 'quarterNotesPerMeasure', 'official_bpm', 'official_quarter_notes_per_measure']);
        if (Object.entries(expected).some(([key, value]) => (!derivedClock.has(key) || Object.prototype.hasOwnProperty.call(authored, key)) && proof[key] !== value)) throw new Error(`Memory ${location} Native FX bank controls contradict their confirmed proof.`);
      } else {
        if (!profile.browserParameters?.[slotIndex] || saved.amount === null || saved.amount === undefined) unproven = true;
        else if (slot.value !== saved.amount) throw new Error(`Memory ${location} Browser FX amount contradicts its engine snapshot.`);
      }
    });
    if (unproven) bankDocument.activeBank = null;
  }
}
function writesFor(snapshot: UiSnapshot): Array<[string, string]> {
  return locations.flatMap((location) => [
    [fxPresetBankStorageKey(snapshot.runtime, location), JSON.stringify(snapshot.banks[location])] as [string, string],
    ...FX_PRESET_BANK_IDS.map((bank) => [switchKey(snapshot.runtime, location, bank), JSON.stringify({ version: 1, settings: snapshot.switches[location][bank] })] as [string, string]),
  ]);
}
let probeId = 0;
function preflight(writes: Array<[string, string]>): void {
  const key = `webrc505_memory_ui_probe_${++probeId}_${Date.now()}`;
  try { localStorage.setItem(key, JSON.stringify(writes)); }
  catch { throw new Error('Memory FX sidecars exceed available writable storage; audio and UI were left unchanged.'); }
  finally { localStorage.removeItem(key); }
}

/** Add authored bank/switch sidecars without moving any writes into an audio callback. */
export function wrapRc505MemoryUiRuntime(base: Rc505MemoryRuntime, runtime: FxPresetRuntime, afterCommit?: () => Promise<void>): Rc505MemoryRuntime {
  if (afterCommit) { const callbacks = afterCommitCallbacks.get(base) ?? new Map(); callbacks.set(runtime, afterCommit); afterCommitCallbacks.set(base, callbacks); }
  const cache = wrapped.get(base) ?? new Map(); wrapped.set(base, cache);
  const existing = cache.get(runtime); if (existing) return existing;
  const revision = () => JSON.stringify([base.revision(), locations.map((location) => [...(bankPorts.get(keyFor(runtime, location)) ?? [])].map((port) => port.revision())), switchPorts.get(runtime)?.revision() ?? 'uninitialized']);
  const captureUi = (): UiSnapshot => {
    const ports = requirePorts(runtime);
    const banks = Object.fromEntries(locations.map((location) => {
      const documents = ports.banks[location].map((port) => port.capture());
      if (documents.some((document) => stable(document) !== stable(documents[0]))) throw new Error('Mounted FX bank panels disagree; finish reconciliation before Memory capture.');
      return [location, documents[0]];
    })) as UiSnapshot['banks'];
    return validateSnapshot({ version: 1, runtime, banks, switches: ports.switches.capture() }, runtime);
  };
  const result: Rc505MemoryRuntime = {
    revision,
    canSwitch: () => {
      const readiness = base.canSwitch(); if (!readiness.allowed) return readiness;
      try { const ports = requirePorts(runtime); if (locations.some((location) => ports.banks[location].some((port) => !port.canCapture()))) throw new Error('Finish pending FX bank operations before switching Memory.'); ports.switches.capture(); }
      catch (error) { return { allowed: false, reason: error instanceof Error ? error.message : String(error) }; }
      return readiness;
    },
    capture: async () => {
      const before = revision(), ui = captureUi(), document = await base.capture();
      if (before !== revision()) throw new Error('FX UI changed during Memory capture.');
      validateActiveProfiles(ui, document);
      return { ...document, extensions: { WEBRC: { ...document.extensions.WEBRC, [sidecarKey]: ui as unknown as Rc505Json } } };
    },
    prepare: async (document, expectedRevision) => {
      if (expectedRevision !== revision()) throw new Error('Memory FX UI candidate is stale.');
      const ports = requirePorts(runtime);
      const partial = document.extensions.WEBRC[sidecarKey] === undefined;
      const ui = partial ? captureUi() : validateSnapshot(document.extensions.WEBRC[sidecarKey], runtime);
      if (partial) for (const location of locations) ui.banks[location].activeBank = null;
      validateActiveProfiles(ui, document);
      for (const location of locations) for (const port of ports.banks[location]) port.validate(ui.banks[location]);
      const writes = writesFor(ui); preflight(writes);
      const previousStorage = writes.map(([key]) => [key, localStorage.getItem(key)] as const);
      const baseRevision = base.revision();
      const candidate = await base.prepare(document, baseRevision);
      if (expectedRevision !== revision()) { await candidate.dispose(); throw new Error('Memory FX UI changed during preparation.'); }
      let committed = false;
      return {
        commit: async () => {
          if (committed || expectedRevision !== revision()) throw new Error('Memory FX UI changed before commit.');
          preflight(writes);
          let committedFailure: unknown;
          try { await candidate.commit(); }
          catch (error) { if (!(error instanceof Rc505MemoryCommittedError)) throw error; committedFailure = error; }
          committed = true;
          let storageError = '';
          try { for (const [key, value] of writes) localStorage.setItem(key, value); }
          catch {
            storageError = 'Memory audio committed, but FX bank/switch storage could not be published; bank confirmation is cleared.';
            // Restore persistent sidecars only. The confirmed audio publication is never rolled back.
            for (const [key, value] of previousStorage) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* retained recovery/export remains authoritative */ } }
          }
          try {
            for (const location of locations) for (const port of ports.banks[location]) port.adopt(ui.banks[location], storageError,
              partial ? 'Older Memory has no FX bank/switch sidecar; existing bank profiles were retained and bank identity is unknown.' : '');
            ports.switches.adopt(ui.switches, { input: ui.banks.input.activeBank, track: ui.banks.track.activeBank }, storageError);
            const hydrate = afterCommitCallbacks.get(base)?.get(runtime);
            if (hydrate) {
              await hydrate();
              for (const location of locations) for (const port of ports.banks[location]) port.finishAdoption?.();
            }
          } catch (error) { throw new Rc505MemoryCommittedError('Memory audio committed, but FX UI adoption failed.', null, { cause: error }); }
          if (storageError) throw new Rc505MemoryCommittedError(storageError);
          if (committedFailure) throw committedFailure;
        },
        dispose: async () => {
          try { await candidate.dispose(); }
          catch (error) { if (committed) throw new Rc505MemoryCommittedError('Memory audio committed, but candidate cleanup failed.', null, { cause: error }); throw error; }
        },
      };
    },
  };
  cache.set(runtime, result); return result;
}
