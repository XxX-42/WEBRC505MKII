import { TrackState } from '../core/types';

export interface BrowserMidiTempoFollowTrack {
  readonly hasCommittedPhrase?: boolean;
  readonly originalRecordingBpm?: number | null;
  readonly livePolyPitchActive?: boolean;
  readonly loopTransportActive?: boolean;
  readonly loopTransportUnavailableReason?: string | null;
  readonly historyBusy?: boolean;
  readonly track?: { readonly oneShot?: 'ON' | 'OFF' };
  readonly state: TrackState;
}

export interface BrowserMidiTempoFollowEligibility<T extends BrowserMidiTempoFollowTrack> {
  readonly candidates: readonly { readonly track: T; readonly sourceBpm: number }[];
  readonly candidate: { readonly track: T; readonly sourceBpm: number } | null;
  readonly reason: string | null;
}

/** Every committed loop must have known provenance and qualify before group follow is allowed. */
export function getBrowserMidiTempoFollowEligibility<T extends BrowserMidiTempoFollowTrack>(
  tracks: readonly T[],
): BrowserMidiTempoFollowEligibility<T> {
  const unavailable = (reason: string): BrowserMidiTempoFollowEligibility<T> => Object.freeze({ candidates: Object.freeze([]), candidate: null, reason });
  const committed = tracks.filter((track) => track.hasCommittedPhrase === true);
  if (committed.length === 0) return unavailable('Tempo follow requires at least one committed loop.');
  const candidates: { track: T; sourceBpm: number }[] = [];
  for (const track of committed) {
    const sourceBpm = track.originalRecordingBpm;
    if (typeof sourceBpm !== 'number' || !Number.isFinite(sourceBpm) || sourceBpm < 40 || sourceBpm > 300) {
      return unavailable('Tempo follow requires a known recording BPM between 40 and 300 for every committed loop.');
    }
    if (track.track?.oneShot === 'ON') return unavailable('Tempo follow requires repeating loops; one-shot tracks are unsupported.');
    const loopTransportReason = track.loopTransportUnavailableReason;
    if (track.loopTransportActive === true || /BEAT SHIFT|VINYL FLICK|source-aware loop transport/i.test(loopTransportReason ?? '')) {
      return unavailable('Tempo follow is unavailable while a source-aware loop transport effect is configured.');
    }
    if (loopTransportReason != null) return unavailable(`Tempo follow is unavailable: ${loopTransportReason}.`);
    if (track.livePolyPitchActive !== true) return unavailable('Enable LIVE_POLY and start every committed loop before enabling tempo follow.');
    if (track.state !== TrackState.PLAYING) return unavailable('Tempo follow requires every committed loop to be playing.');
    if (track.historyBusy === true) return unavailable('Tempo follow is unavailable while any committed loop is recording, overdubbing, or changing PCM history.');
    candidates.push(Object.freeze({ track, sourceBpm }));
  }
  const frozen = Object.freeze(candidates);
  return Object.freeze({ candidates: frozen, candidate: frozen.length === 1 ? frozen[0]! : null, reason: null });
}

/** Candidate-only compatibility helper for callers that need a simple fail-closed gate. */
export function getSingleBrowserMidiTempoFollowCandidate<T extends BrowserMidiTempoFollowTrack>(
  tracks: readonly T[],
): { readonly track: T; readonly sourceBpm: number } | null {
  return getBrowserMidiTempoFollowEligibility(tracks).candidate;
}

/** Serializes asynchronous retargets while retaining only the newest queued value. */
export class LatestTargetRunner<T> {
  private generation = 0;
  private latestTarget: { readonly value: T } | null = null;
  private running: Promise<void> | null = null;
  private readonly applyTarget: (target: T) => Promise<void>;

  constructor(applyTarget: (target: T) => Promise<void>) {
    this.applyTarget = applyTarget;
  }

  offer(target: T): void {
    this.latestTarget = { value: target };
    if (!this.running) this.start();
  }

  /** Cancels queued work and prevents an in-flight completion from draining it. */
  invalidate(): void {
    this.generation += 1;
    this.latestTarget = null;
  }

  async waitForIdle(): Promise<void> {
    const current = this.running;
    if (current) await current;
    if (this.running && this.running !== current) await this.waitForIdle();
  }

  private start(): void {
    const generation = this.generation;
    const task = this.drain(generation);
    this.running = task;
    void task.finally(() => {
      if (this.running === task) this.running = null;
      if (generation === this.generation && this.latestTarget !== null) this.start();
    });
  }

  private async drain(generation: number): Promise<void> {
    while (generation === this.generation && this.latestTarget !== null) {
      const target = this.latestTarget.value;
      this.latestTarget = null;
      try {
        await this.applyTarget(target);
      } catch {
        // Product callbacks own failure policy; do not leak an unhandled rejection.
      }
    }
  }
}
