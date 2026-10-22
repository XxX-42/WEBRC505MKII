import { isOfficialFxSlotAllowed } from './fx/official/parameters';
import { BrowserTrackFxChain } from './BrowserTrackFxChain';
import type { BrowserVocoderCarrierSource } from './fx/BrowserWorkletFX';
import { FilterFX } from './fx/FilterFX';
import type { FXBase } from './fx/FXBase';
import { ReverbFX } from './fx/ReverbFX';
import { SlicerFX } from './fx/SlicerFX';
import { copyRecoveryFxParameters, type BrowserRecoveryFxSlot } from './BrowserRecoverySnapshot';

export type BrowserRecoverySharedFxLocation = 'input' | 'sharedTrack';

export interface BrowserRecoverySharedFxSlotStatus {
  readonly slot: BrowserRecoveryFxSlot['slot'];
  readonly type: string | null;
  readonly active: boolean;
  readonly state: 'empty' | 'loading' | 'ready' | 'error' | 'metadata-only';
  readonly error: string | null;
  readonly recoveryMode: 'audio-node' | 'worklet-chain' | 'source-reader-metadata' | 'empty';
}

export interface BrowserRecoverySharedFxBank {
  readonly location: BrowserRecoverySharedFxLocation;
  readonly input: GainNode;
  readonly output: GainNode;
  getStatuses(): readonly BrowserRecoverySharedFxSlotStatus[];
  getRecoverySnapshot(): readonly BrowserRecoveryFxSlot[];
  dispose(): void;
}

interface WorkletSlot {
  readonly chain: BrowserTrackFxChain;
  readonly savedIndex: number;
}

interface LegacySlot {
  readonly effect: FXBase;
  readonly savedIndex: number;
}

const SLOT_NAMES = ['A', 'B', 'C', 'D'] as const;
const SOURCE_READER_TYPES = new Set(['BEAT SHIFT', 'VINYL FLICK']);

function canonical(type: string): string {
  return type.trim().toUpperCase().replace(/ \(EXPERIMENTAL\)$/, '');
}

function makeLegacyEffect(context: AudioContext, type: string): FXBase | null {
  switch (canonical(type)) {
    case 'FILTER': return new FilterFX(context);
    case 'REVERB': return new ReverbFX(context);
    case 'SLICER': return new SlicerFX(context);
    default: return null;
  }
}

function restoreLegacyEffect(effect: FXBase, saved: BrowserRecoveryFxSlot): void {
  for (const [key, value] of Object.entries(saved.parameters)) {
    if (key === 'bypassed' && effect instanceof SlicerFX) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Recovery shared ${effect.name} ${saved.slot} parameter ${key} is not a finite number.`);
    }
    effect.setParam(key, value);
  }
  // The acknowledged slot active flag is authoritative. Legacy SLICER's
  // snapshot also contains its local bypass bit, but older engine builds could
  // leave that bit out of sync with the bank's explicit active flag.
  effect.setBypass(!saved.active);
}

/**
 * Build one real shared Browser A–D route in a recovery context. Its endpoints
 * have no source; the caller connects its output only to a zero-gain sink. Old
 * FILTER/REVERB/SLICER aliases keep their original node implementations. The
 * source-reader BEAT SHIFT/VINYL FLICK entries are reported as metadata-only:
 * they are per-loop pre-mix readers and cannot be moved onto this shared bus.
 */
export function createBrowserRecoverySharedFxBank(
  context: AudioContext,
  location: BrowserRecoverySharedFxLocation,
  slots: readonly BrowserRecoveryFxSlot[],
  ensureModule: () => Promise<void>,
  getBpm: () => number,
  getQuarterNotesPerMeasure: () => number = () => 4,
  getVocoderCarrierSource?: BrowserVocoderCarrierSource,
): BrowserRecoverySharedFxBank {
  const input = context.createGain();
  const output = context.createGain();
  const workletSlots: WorkletSlot[] = [];
  const legacySlots: LegacySlot[] = [];
  const metadataOnly = new Set<number>();
  let disposed = false;
  try {
    let tail: AudioNode = input;
    for (let index = 0; index < slots.length; index += 1) {
      const saved = slots[index]!;
      if (saved.slot !== SLOT_NAMES[index]) throw new Error(`Recovery ${location} FX slot ${index} has an invalid identity.`);
      if (!saved.type) continue;
      const type = canonical(saved.type);
      if (Object.keys(saved.parameters ?? {}).some((key) => key.startsWith('official_')) && !isOfficialFxSlotAllowed(type, location === 'input' ? 'input' : 'track', index)) throw new Error('Official Track-only FX requires Track slot A in MULTI mode.');
      if (SOURCE_READER_TYPES.has(type) && location === 'sharedTrack') {
        metadataOnly.add(index);
        continue;
      }

      const legacy = makeLegacyEffect(context, saved.type);
      if (legacy) {
        restoreLegacyEffect(legacy, saved);
        tail.connect(legacy.input);
        tail = legacy.output;
        legacySlots.push({ effect: legacy, savedIndex: index });
        continue;
      }

      const chain = new BrowserTrackFxChain(context, ensureModule, () => {}, getBpm, getQuarterNotesPerMeasure, getVocoderCarrierSource, { legacyVocoderMixPercent: true });
      workletSlots.push({ chain, savedIndex: index });
      if (!chain.setType(0, saved.type)) throw new Error(`Recovery ${location} bank rejected ${saved.type} in slot ${saved.slot}.`);
      if (saved.amount !== null && !chain.setParameter(0, saved.amount)) {
        throw new Error(`Recovery ${location} bank could not restore amount for ${saved.type} in slot ${saved.slot}.`);
      }
      const parameters: Record<string, number> = {};
      for (const [key, value] of Object.entries(saved.parameters)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(`Recovery ${location} ${saved.type} ${saved.slot} parameter ${key} is not supported by the shared Browser adapter.`);
        }
        parameters[key] = value;
      }
      if (Object.keys(parameters).length > 0 && !chain.setNamedParameters(0, parameters)) {
        throw new Error(`Recovery ${location} bank rejected named parameters for ${saved.type} in slot ${saved.slot}.`);
      }
      if (!chain.setActive(0, saved.active)) throw new Error(`Recovery ${location} bank could not restore active state for ${saved.type} in slot ${saved.slot}.`);
      tail.connect(chain.input);
      tail = chain.output;
    }
    tail.connect(output);
  } catch (error) {
    for (const slot of workletSlots) slot.chain.dispose();
    for (const slot of legacySlots) slot.effect.dispose();
    try { input.disconnect(); } catch { /* candidate context is still closed on caller failure */ }
    try { output.disconnect(); } catch { /* candidate context is still closed on caller failure */ }
    throw error;
  }

  return Object.freeze({
    location,
    input,
    output,
    getStatuses() {
      return Object.freeze(slots.map((saved, index): BrowserRecoverySharedFxSlotStatus => {
        if (!saved.type) return { slot: saved.slot, type: null, active: false, state: 'empty', error: null, recoveryMode: 'empty' };
        if (metadataOnly.has(index)) return {
          slot: saved.slot, type: saved.type, active: saved.active, state: 'metadata-only', error: null,
          recoveryMode: 'source-reader-metadata',
        };
        const legacy = legacySlots.find((entry) => entry.savedIndex === index);
        if (legacy) return {
          slot: saved.slot, type: saved.type, active: saved.active, state: 'ready', error: null, recoveryMode: 'audio-node',
        };
        const worklet = workletSlots.find((entry) => entry.savedIndex === index);
        const status = worklet?.chain.getStatus(1).slots[0];
        return {
          slot: saved.slot,
          type: status?.type ?? saved.type,
          active: status?.active ?? saved.active,
          state: status?.state ?? 'error',
          error: status?.error ?? (status ? null : 'Recovery slot was not materialized.'),
          recoveryMode: 'worklet-chain',
        };
      }));
    },
    getRecoverySnapshot() {
      return Object.freeze(slots.map((saved, index) => {
        const legacy = legacySlots.find((entry) => entry.savedIndex === index);
        if (legacy) return Object.freeze({
          ...saved,
          parameters: copyRecoveryFxParameters(legacy.effect.getParameterSnapshot?.()),
          state: 'ready' as const,
        });
        const worklet = workletSlots.find((entry) => entry.savedIndex === index);
        const current = worklet?.chain.getRecoverySnapshot()[0];
        if (!current) return saved;
        return Object.freeze({ ...saved, parameters: current.parameters, active: current.active, state: current.state });
      }));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const slot of workletSlots) slot.chain.dispose();
      for (const slot of legacySlots) slot.effect.dispose();
      try { input.disconnect(); } catch { /* idempotent candidate cleanup */ }
      try { output.disconnect(); } catch { /* idempotent candidate cleanup */ }
    },
  });
}

export function recoverySharedFxSourceReaderSlots(
  location: BrowserRecoverySharedFxLocation,
  slots: readonly BrowserRecoveryFxSlot[],
): readonly BrowserRecoverySharedFxSlotStatus[] {
  if (location !== 'sharedTrack') return Object.freeze([]);
  return Object.freeze(slots.flatMap((slot) => slot.type && SOURCE_READER_TYPES.has(canonical(slot.type))
    ? [{ slot: slot.slot, type: slot.type, active: slot.active, state: 'metadata-only' as const, error: null, recoveryMode: 'source-reader-metadata' as const }]
    : []));
}
