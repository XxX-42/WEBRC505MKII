import { Transport } from '../core/Transport';
import { isNativeHostIncarnationId, isNativeRhythmConfig, type NativeBridgeClient, type NativeRhythmConfig, type NativeStatus } from './NativeBridgeClient';
import type { RhythmPattern, RhythmPlaybackSettings } from './RhythmEngine';
import { getDrumKitByIndex, getDrumKitByName, getRhythmPatternByIndex, type RhythmQuantizeGrid, type RhythmSection, type RhythmVariation } from './rhythm';

const LEGACY_CATALOG_INDEX: Record<RhythmPattern, number> = { ROCK: 106, TECHNO: 198, METRONOME: 210 };

interface NativeRhythmHost {
  bridge(): NativeBridgeClient;
  status(): NativeStatus | null;
  bridgeAvailable(): boolean;
  applyStatus(status: NativeStatus, synchronizeRhythmBpm?: boolean): void;
  reportError(error: unknown): void;
  notify(): void;
}

/** Native-only rhythm transport. State is acknowledged by the host, never inferred from clicks. */
export class NativeRhythmEngine {
  private commandTail: Promise<void> = Promise.resolve();
  private lastError = '';

  private readonly host: NativeRhythmHost;

  constructor(host: NativeRhythmHost) { this.host = host; }

  get available(): boolean {
    const status = this.host.status();
    return this.host.bridgeAvailable() && status?.bridgeHealthy === true
      && status.nativeRhythm?.available === true && isNativeRhythmConfig(status.nativeRhythm);
  }

  get unavailableReason(): string {
    if (!this.host.bridgeAvailable()) return 'Connect the Native bridge to use rhythm.';
    const status = this.host.status();
    if (!status?.bridgeHealthy) return 'Native rhythm is unavailable while the bridge is unhealthy.';
    if (!status.nativeRhythm?.available) {
      return status.nativeRhythm?.statusNote || 'Native rhythm is unavailable in the current bridge status.';
    }
    if (!isNativeRhythmConfig(status.nativeRhythm)) return 'This Native bridge does not report the supported rhythm settings. Update the bridge.';
    return '';
  }

  get isRunning(): boolean {
    return this.available && this.host.status()?.engineRunning === true && this.host.status()?.nativeRhythm?.enabled === true;
  }

  get error(): string { return this.lastError; }
  get settings(): NativeRhythmConfig | null {
    const rhythm = this.host.status()?.nativeRhythm;
    if (!rhythm || !isNativeRhythmConfig(rhythm)) return null;
    return {
      enabled: rhythm.enabled, bpm: rhythm.bpm, kitIndex: rhythm.kitIndex, patternIndex: rhythm.patternIndex,
      variation: rhythm.variation, section: rhythm.section, swingPercent: rhythm.swingPercent,
      quantizeGrid: rhythm.quantizeGrid, volume: rhythm.volume,
    };
  }
  get patternMetadata() { return getRhythmPatternByIndex(this.settings?.patternIndex ?? 106)!; }
  get selectedKit() { return getDrumKitByIndex(this.settings?.kitIndex ?? 1)!; }
  get selectedVariation(): RhythmVariation { return this.settings?.variation ?? 'A'; }
  get selectedSection(): RhythmSection { return this.settings?.section ?? 'main'; }
  get swingPercent(): number { return this.settings?.swingPercent ?? 50; }
  get quantizeGrid(): RhythmQuantizeGrid { return this.settings?.quantizeGrid ?? '1/16'; }
  get volume(): number { return this.settings?.volume ?? 50; }
  get eventProvenance(): 'clean-room-generated' { return 'clean-room-generated'; }

  start(): Promise<boolean> { return this.configure({ enabled: true, bpm: Transport.getInstance().bpm }); }
  stop(): Promise<boolean> { return this.configure({ enabled: false }); }
  setPattern(pattern: RhythmPattern): Promise<boolean> { return this.setCatalogPattern(LEGACY_CATALOG_INDEX[pattern]); }
  setCatalogPattern(patternIndex: number): Promise<boolean> { return this.configure({ patternIndex }); }
  setKit(kit: number | string): Promise<boolean> {
    const profile = typeof kit === 'number' ? getDrumKitByIndex(kit) : getDrumKitByName(kit);
    return profile ? this.configure({ kitIndex: profile.index }) : this.reject('Native rhythm kit must be one of the 16 supported kits.');
  }
  setVariation(variation: RhythmVariation): Promise<boolean> { return this.configure({ variation }); }
  setSection(section: RhythmSection): Promise<boolean> { return this.configure({ section }); }
  setSwingPercent(swingPercent: number): Promise<boolean> { return this.configure({ swingPercent }); }
  setQuantizeGrid(quantizeGrid: RhythmQuantizeGrid): Promise<boolean> { return this.configure({ quantizeGrid }); }
  setVolume(volume: number): Promise<boolean> { return this.configure({ volume }); }
  setBpm(bpm: number, hostIncarnationId?: string): Promise<boolean> { return this.configure({ bpm }, hostIncarnationId); }
  setSettings(settings: RhythmPlaybackSettings): Promise<boolean> { return this.configure(settings); }

  private configure(patch: Partial<NativeRhythmConfig>, hostIncarnationId?: string): Promise<boolean> {
    // Serialize partial edits against the last ACK. Rapid volume/pattern/start/stop
    // changes cannot race and overwrite a newer selection with an older response.
    const command = this.commandTail.then(async (): Promise<boolean> => {
      if (!this.available) return this.reject(this.unavailableReason);
      const current = this.settings;
      if (!current) return this.reject('Native rhythm settings are missing from the current bridge status.');
      const config = { ...current, ...patch };
      if (!isNativeRhythmConfig(config)) return this.reject('Unsupported Native rhythm settings. Check BPM, pattern, kit, variation, section, swing, quantize, and volume.');
      this.lastError = '';
      try {
        const status = hostIncarnationId === undefined
          ? await this.host.bridge().setRhythm(config)
          : await this.host.bridge().setRhythm(config, hostIncarnationId);
        if (hostIncarnationId !== undefined &&
            (!isNativeHostIncarnationId(status.hostIncarnationId) || status.hostIncarnationId !== hostIncarnationId)) {
          throw new Error('Native host incarnation changed during rhythm BPM synchronization; stale status was not applied.');
        }
        this.host.applyStatus(status, hostIncarnationId === undefined);
        if (!this.available) return this.reject(this.unavailableReason);
        const acknowledged = this.settings;
        if (!acknowledged || (Object.keys(config) as Array<keyof NativeRhythmConfig>).some((key) => acknowledged[key] !== config[key])) {
          return this.reject('Native rhythm returned different settings; the requested change was not acknowledged.');
        }
        return true;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.host.reportError(error);
        return false;
      } finally {
        this.host.notify();
      }
    });
    this.commandTail = command.then(() => {});
    return command;
  }

  private reject(message: string): Promise<false> {
    this.lastError = message;
    this.host.notify();
    return Promise.resolve(false);
  }
}
