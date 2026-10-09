import { CompressorFX } from './CompressorFX';
import { DelayFX } from './DelayFX';
import { FilterFX } from './FilterFX';
import { PhaserFX } from './PhaserFX';
import { ReverbFX } from './ReverbFX';
import { SlicerFX } from './SlicerFX';
import type { FXApplyOptions, FXBase, FXSnapshot } from './FXBase';

export interface FxNodeGraph {
  input: AudioNode;
  output: AudioNode;
  effects: FXBase[];
  initialize(): Promise<void>;
  dispose(): void;
}

type FXCreator = (context: BaseAudioContext) => FXBase;

/** Shared plugin registry for live and OfflineAudioContext graph construction. */
export class FXRegistry {
  private readonly creators = new Map<string, FXCreator>();

  constructor(registerBuiltins = true) {
    if (!registerBuiltins) return;
    this.register('COMPRESSOR', (context) => new CompressorFX(context));
    this.register('FILTER', (context) => new FilterFX(context));
    this.register('DELAY', (context) => new DelayFX(context));
    this.register('REVERB', (context) => new ReverbFX(context));
    this.register('SLICER', (context) => new SlicerFX(context));
    this.register('PHASER', (context) => new PhaserFX(context));
  }

  register(type: string, create: FXCreator): void {
    const key = this.key(type);
    if (this.creators.has(key)) throw new Error(`FX type ${key} is already registered.`);
    this.creators.set(key, create);
  }

  supports(type: string): boolean { return this.creators.has(this.key(type)); }

  /** Return a stable snapshot of the registered FX type names for UI selectors. */
  getTypes(): string[] { return [...this.creators.keys()]; }

  create(context: BaseAudioContext, type: string): FXBase {
    const creator = this.creators.get(this.key(type));
    if (!creator) throw new Error(`FX type ${type} is not registered.`);
    return creator(context);
  }

  restore(context: BaseAudioContext, snapshot: FXSnapshot, options?: FXApplyOptions): FXBase {
    const effect = this.create(context, snapshot.type);
    try {
      effect.applySnapshot(snapshot, options);
      return effect;
    } catch (error) {
      effect.dispose();
      throw error;
    }
  }

  async createGraph(
    context: BaseAudioContext,
    slots: ReadonlyArray<FXSnapshot | null>,
    options?: FXApplyOptions,
  ): Promise<FxNodeGraph> {
    const input = context.createGain();
    const output = context.createGain();
    const effects: FXBase[] = [];
    let current: AudioNode = input;
    try {
      for (const slot of slots) {
        if (!slot) continue;
        const effect = this.restore(context, slot, options);
        current.connect(effect.input);
        current = effect.output;
        effects.push(effect);
      }
      current.connect(output);
      return {
        input,
        output,
        effects,
        initialize: async () => {
          await Promise.all(effects.map((effect) => {
            const candidate = effect as FXBase & { initialize?: () => Promise<void> };
            return candidate.initialize?.() ?? Promise.resolve();
          }));
          for (const effect of effects) {
            const candidate = effect as FXBase & { isReady?: boolean; backend?: string };
            if (effect.name === 'COMPRESSOR' && (candidate.isReady !== true || candidate.backend !== 'audio-worklet')) {
              throw new Error('The compressor graph did not become ready; refusing to render a dry fallback.');
            }
          }
        },
        dispose: () => {
          for (const effect of effects) effect.dispose();
          try { input.disconnect(); } catch { /* already disconnected */ }
          try { output.disconnect(); } catch { /* already disconnected */ }
        },
      };
    } catch (error) {
      for (const effect of effects) effect.dispose();
      try { input.disconnect(); } catch { /* already disconnected */ }
      try { output.disconnect(); } catch { /* already disconnected */ }
      throw error;
    }
  }

  private key(type: string): string {
    const key = type.trim().toUpperCase();
    if (!key) throw new TypeError('FX type must be a non-empty string.');
    return key;
  }
}

export const defaultFXRegistry = new FXRegistry();
