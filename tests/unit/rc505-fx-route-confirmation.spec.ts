import { describe, expect, it } from 'vitest';
import { assertTrackFxApplyConfirmed, type TrackFxApplyStatus } from '../../src/audio/TrackFxApplyStatus';
import { resolveRc505TrackControls, type Rc505TrackControlInput } from '../../src/ui/rc505/Rc505ControlStateResolver';
import { formatRc505TrackMeter } from '../../src/ui/rc505/Rc505TrackMeter';

const route = (patch: Partial<TrackFxApplyStatus> = {}): TrackFxApplyStatus => ({ trackId: 1, available: true,
  requested: true, applied: true, requestedRevision: 8, appliedRevision: 8, semanticRevision: 3,
  inputAppliedRevision: 8, trackAppliedRevision: 8, pending: false, controlFaulted: false,
  peak: 0.5, rms: 0.25, error: '', ...patch });
const input = (fxApplyState: TrackFxApplyStatus): Rc505TrackControlInput => ({ state: 'PLAYING', hasPhrase: true,
  selected: false, available: true, ready: true, layer: 'NORMAL', history: { canUndo: false, canRedo: false, busy: false }, fxApplyState });

describe('Classic FX controls consume joint render confirmation', () => {
  it('retains the previous confirmed lamp while a new request is pending', () => {
    expect(resolveRc505TrackControls(input(route({ requested: false, requestedRevision: 9, pending: true }))).fx)
      .toMatchObject({ enabled: false, ledOn: true, ledColor: 'red' });
    expect(resolveRc505TrackControls(input(route({ requested: true, applied: false, requestedRevision: 9, pending: true }))).fx)
      .toMatchObject({ enabled: false, ledOn: false });
  });
  it.each([{ pending: true }, { controlFaulted: true }, { available: false }, { requested: false },
    { applied: false }, { appliedRevision: 7 }, { inputAppliedRevision: 7 }, { trackAppliedRevision: 7 }])(
    'rejects accepted or partially applied requests: %j', (patch) => {
      expect(() => assertTrackFxApplyConfirmed(route(patch), true)).toThrow(/not confirmed/);
    });
  it('accepts both ON and OFF only after matching input and playback acknowledgement', () => {
    expect(() => assertTrackFxApplyConfirmed(route(), true)).not.toThrow();
    expect(() => assertTrackFxApplyConfirmed(route({ requested: false, applied: false }), false)).not.toThrow();
  });
  it('disables an unsupported or faulted host without lighting a requested-only state', () => {
    expect(resolveRc505TrackControls(input(route({ controlFaulted: true, error: 'input ACK missing' }))).fx)
      .toMatchObject({ enabled: false, ledOn: false, unavailableReason: 'input ACK missing' });
  });
});

describe('Classic LOOP LEVEL uses actual peak/RMS', () => {
  it('formats signal, silence and above-full-scale tap readings without substituting fader values', () => {
    expect(formatRc505TrackMeter({ available: true, peak: 0.5, rms: 0.25, reason: '' })).toBe('-6.0/-12.0 dB');
    expect(formatRc505TrackMeter({ available: true, peak: 0, rms: 0, reason: '' })).toBe('-INF/-INF dB');
    expect(formatRc505TrackMeter({ available: true, peak: 2, rms: 1, reason: '' })).toBe('6.0/0.0 dB');
  });
  it('does not publish stale or invalid readings as an available meter', () => {
    expect(formatRc505TrackMeter(undefined)).toBe('UNAVAILABLE');
    for (const reading of [{ available: false, peak: 0.5, rms: 0.25 }, { available: true, peak: NaN, rms: 0 },
      { available: true, peak: 1, rms: -1 }, { available: true, peak: Infinity, rms: 1 }]) {
      expect(formatRc505TrackMeter({ ...reading, reason: '' })).toBe('UNAVAILABLE');
    }
  });
});
