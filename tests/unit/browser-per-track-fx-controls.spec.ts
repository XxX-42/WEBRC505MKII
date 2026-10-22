import { afterEach, describe, expect, it, vi } from 'vitest';
const pitchHarness = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../src/audio/pitch/signalsmith', () => ({ createLiveInputTransposeNode: pitchHarness.create }));
import { BROWSER_PER_TRACK_FX_TYPES, BROWSER_PER_TRACK_PARAMETER_KEYS, BrowserTrackFxChain } from '../../src/audio/BrowserTrackFxChain';
import { BROWSER_WORKLET_FX_TYPES } from '../../src/audio/fx/BrowserWorkletFX';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { getBrowserTrackFxControls, getBrowserTrackFxMacroKeys, sanitizeBrowserTrackFxParameters } from '../../src/composables/browserTrackFxParameters';
import { createMockAudioContext } from '../helpers/audioTestUtils';

class ControlWorkletNode {
  static latest: ControlWorkletNode;
  readonly processor: FxProcessor;
  readonly options: AudioWorkletNodeOptions;
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  onprocessorerror: (() => void) | null = null;
  readonly port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (message: unknown) => this.processor.port.onmessage?.({ data: message }),
  };
  constructor(_context: AudioContext, _name: string, options: AudioWorkletNodeOptions) {
    this.options = options;
    this.processor = new FxProcessor(options);
    this.processor.port.postMessage = (message: unknown) => this.port.onmessage?.({ data: message } as MessageEvent);
    ControlWorkletNode.latest = this;
  }
}

afterEach(() => { vi.unstubAllGlobals(); pitchHarness.create.mockReset(); });

describe('Browser per-track named control coverage', () => {
  it.each(BROWSER_PER_TRACK_FX_TYPES.filter((type) => type !== 'TRANSPOSE' && type !== 'PITCH BEND' && type !== 'ROBOT' && type !== 'HRM MANUAL' && type !== 'OCTAVE' && type !== 'AUTO RIFF' && type !== 'HRM AUTO (M)'))('maps only executable canonical controls and renders %s at every control bound', async (type) => {
    const name = type.replace(' (EXPERIMENTAL)', '') as keyof typeof BROWSER_WORKLET_FX_TYPES;
    const algorithm = BROWSER_WORKLET_FX_TYPES[name];
    const controls = getBrowserTrackFxControls(type);
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(BROWSER_PER_TRACK_PARAMETER_KEYS[algorithm], control.key).toContain(control.key);
    vi.stubGlobal('AudioWorkletNode', ControlWorkletNode);
    const ctx = createMockAudioContext();
    const carrierSources = Array.from({ length: 5 }, () => ctx.createGain());
    const chain = new BrowserTrackFxChain(ctx, async () => {}, undefined, undefined, undefined, id => carrierSources[id - 1] ?? null);
    expect(chain.setType(0, type)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    for (const control of controls) {
      for (const value of [control.min, control.defaultValue, control.max, control.min + (control.max - control.min) * 0.371]) {
        const parameters = sanitizeBrowserTrackFxParameters(type, { [control.key]: value });
        expect(chain.setNamedParameters(0, parameters), `${control.key} = ${value}`).toBe(true);
        expect(chain.getStatus(1).slots[0]?.error, `${control.key} = ${value}`).toBeNull();
      }
    }
    expect(chain.setActive(0, true)).toBe(true);
    const left = new Float32Array(31);
    const right = new Float32Array(31);
    expect(ControlWorkletNode.latest.processor.process([[new Float32Array(31), new Float32Array(31)]], [[left, right]])).toBe(true);
    expect([...left, ...right].every(Number.isFinite)).toBe(true);
    chain.dispose();
  });

  it('exposes TRANSPOSE shift/mix with the real Signalsmith parameter ranges', () => {
    const controls = getBrowserTrackFxControls('TRANSPOSE').filter(control => control.provenance === 'extension');
    expect(controls.map(({ key }) => key)).toEqual(['shift', 'mix']);
    expect(controls[0]).toMatchObject({ min: -24, max: 24, defaultValue: 0, unit: 'semitones' });
    expect(controls[1]).toMatchObject({ min: 0, max: 100, defaultValue: 100, unit: '%' });
    expect(sanitizeBrowserTrackFxParameters('TRANSPOSE', { shift: 32, mix: 80, formant: 2 })).toEqual({ shift: 24, mix: 80 });
    expect(BROWSER_PER_TRACK_PARAMETER_KEYS.transpose?.filter(key => !key.startsWith('official_'))).toEqual(['shift', 'mix']);
    expect(BROWSER_PER_TRACK_FX_TYPES).toContain('TRANSPOSE');
  });

  it('exposes bounded catalog PITCH BEND controls and a centered twelve-semitone macro', async () => {
    const controls = getBrowserTrackFxControls('PITCH BEND').filter(control => control.provenance === 'extension');
    expect(controls.map(({ key }) => key)).toEqual(['range', 'time_ms', 'direction', 'mix_percent']);
    expect(controls[0]).toMatchObject({ min: 0, max: 24, defaultValue: 12, unit: 'semitones' });
    expect(controls[1]).toMatchObject({ min: 20, max: 4000, defaultValue: 500, unit: 'ms' });
    expect(controls[2]?.options).toEqual([{ value: 0, label: 'Up' }, { value: 1, label: 'Down' }]);
    expect(controls[3]).toMatchObject({ min: 0, max: 100, defaultValue: 100, unit: '%' });
    expect(sanitizeBrowserTrackFxParameters('PITCH BEND', { range: 28, time_ms: 10, direction: 0.8, mix_percent: 120, formant: 1 })).toEqual({
      range: 24, time_ms: 20, direction: 1, mix_percent: 100,
    });
    expect(BROWSER_PER_TRACK_PARAMETER_KEYS['pitch-bend']?.filter(key => !key.startsWith('official_'))).toEqual(['range', 'time_ms', 'direction', 'mix_percent']);
    expect(BROWSER_PER_TRACK_FX_TYPES).toContain('PITCH BEND');
    pitchHarness.create.mockResolvedValue({
      connect: vi.fn(), disconnect: vi.fn(), latencySeconds: 0.02, latencySamples: 960,
      setPitch: vi.fn(async () => undefined),
    });
    vi.stubGlobal('AudioWorkletNode', class {});
    const chain = new BrowserTrackFxChain(createMockAudioContext(), async () => {});
    expect(chain.setType(0, 'PITCH BEND')).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(chain.getStatus(1).slots[0]).toMatchObject({ type: 'PITCH BEND', state: 'ready' });
    for (const control of controls) {
      for (const value of [control.min, control.defaultValue, control.max]) {
        const bounded = sanitizeBrowserTrackFxParameters('PITCH BEND', { [control.key]: value });
        expect(chain.setNamedParameters(0, bounded), `${control.key} = ${value}`).toBe(true);
      }
    }
    expect(chain.setParameter(0, 50)).toBe(true);
    chain.dispose();
  });

  it('exposes ROBOT catalog pitch/formant/mix controls on the existing host adapter', async () => {
    const controls = getBrowserTrackFxControls('ROBOT').filter(control => control.provenance === 'extension');
    expect(controls.map(({ key }) => key)).toEqual(['pitch', 'formant', 'mix']);
    expect(controls[0]).toMatchObject({ min: -24, max: 24, defaultValue: 0, unit: 'semitones' });
    expect(controls[1]).toMatchObject({ min: -12, max: 12, defaultValue: 0, unit: 'semitones' });
    expect(controls[2]).toMatchObject({ min: 0, max: 100, defaultValue: 100, unit: '%' });
    expect(getBrowserTrackFxMacroKeys('ROBOT')).toEqual(['mix']);
    expect(sanitizeBrowserTrackFxParameters('ROBOT', { pitch: 30, formant: -18, mix: 120, tracking: 0.5 })).toEqual({ pitch: 24, formant: -12, mix: 100 });
    expect(BROWSER_PER_TRACK_PARAMETER_KEYS.robot?.filter(key => !key.startsWith('official_'))).toEqual(['pitch', 'formant', 'mix']);

    pitchHarness.create.mockResolvedValue({
      connect: vi.fn(), disconnect: vi.fn(), latencySeconds: 0.02, latencySamples: 960,
      setPitch: vi.fn(async () => undefined),
    });
    vi.stubGlobal('AudioWorkletNode', ControlWorkletNode);
    const chain = new BrowserTrackFxChain(createMockAudioContext(), async () => {});
    expect(chain.setType(0, 'ROBOT')).toBe(true);
    await vi.waitFor(() => expect(chain.getStatus(1).slots[0]).toMatchObject({ type: 'ROBOT', state: 'ready', pendingApply: false }));
    for (const control of controls) {
      for (const value of [control.min, control.defaultValue, control.max]) {
        const bounded = sanitizeBrowserTrackFxParameters('ROBOT', { [control.key]: value });
        expect(chain.setNamedParameters(0, bounded), `${control.key} = ${value}`).toBe(true);
      }
    }
    expect(chain.setParameter(0, 50)).toBe(true);
    chain.dispose();
  });

  it('exposes both independent HRM MANUAL voices, pan and harmony mix on the private host adapter', async () => {
    const controls = getBrowserTrackFxControls('HRM MANUAL').filter(control => control.provenance === 'extension');
    expect(controls.map(({ key }) => key)).toEqual(['voice_1_interval', 'voice_2_interval', 'pan_percent', 'mix_percent']);
    expect(controls[0]).toMatchObject({ min: -24, max: 24, defaultValue: 7, unit: 'semitones' });
    expect(controls[1]).toMatchObject({ min: -24, max: 24, defaultValue: 12, unit: 'semitones' });
    expect(controls[2]).toMatchObject({ min: -100, max: 100, defaultValue: 0, unit: '%' });
    expect(controls[3]).toMatchObject({ min: 0, max: 100, defaultValue: 70, unit: '%' });
    expect(getBrowserTrackFxMacroKeys('HRM MANUAL')).toEqual(['mix_percent']);
    expect(sanitizeBrowserTrackFxParameters('HRM MANUAL', {
      voice_1_interval: -30, voice_2_interval: 7, pan_percent: 150, mix_percent: 80, formant: 2,
    })).toEqual({ voice_1_interval: -24, voice_2_interval: 7, pan_percent: 100, mix_percent: 80 });
    expect(BROWSER_PER_TRACK_PARAMETER_KEYS['hrm-manual']?.filter(key => !key.startsWith('official_'))).toEqual(['voice_1_interval', 'voice_2_interval', 'pan_percent', 'mix_percent']);

    const voice1 = {
      connect: vi.fn(), disconnect: vi.fn(), latencySeconds: 0.02, latencySamples: 960,
      setPitch: vi.fn(async () => undefined),
    };
    const voice2 = {
      connect: vi.fn(), disconnect: vi.fn(), latencySeconds: 0.024, latencySamples: 1152,
      setPitch: vi.fn(async () => undefined),
    };
    pitchHarness.create.mockResolvedValueOnce(voice1).mockResolvedValueOnce(voice2);
    vi.stubGlobal('AudioWorkletNode', ControlWorkletNode);
    const chain = new BrowserTrackFxChain(createMockAudioContext(), async () => {});
    expect(chain.setType(0, 'HRM MANUAL')).toBe(true);
    await vi.waitFor(() => expect(chain.getStatus(1).slots[0]).toMatchObject({ type: 'HRM MANUAL', state: 'ready', pendingApply: false }));
    expect(pitchHarness.create).toHaveBeenCalledTimes(2);
    for (const control of controls) {
      for (const value of [control.min, control.defaultValue, control.max]) {
        const bounded = sanitizeBrowserTrackFxParameters('HRM MANUAL', { [control.key]: value });
        expect(chain.setNamedParameters(0, bounded), `${control.key} = ${value}`).toBe(true);
      }
    }
    expect(chain.setParameter(0, 55)).toBe(true);
    expect(chain.setActive(0, true)).toBe(true);
    expect(voice1.setPitch).toHaveBeenCalled();
    expect(voice2.setPitch).toHaveBeenCalled();
    chain.dispose();
  });

  it('exposes three independent OCTAVE levels and the overall mix without inventing tracking support', async () => {
    const controls = getBrowserTrackFxControls('OCTAVE').filter(control => control.provenance === 'extension');
    expect(controls.map(({ key }) => key)).toEqual(['minus_24_level', 'minus_12_level', 'plus_12_level', 'mix_percent']);
    expect(controls[0]).toMatchObject({ min: 0, max: 100, defaultValue: 0, unit: '%' });
    expect(controls[1]).toMatchObject({ min: 0, max: 100, defaultValue: 40, unit: '%' });
    expect(controls[2]).toMatchObject({ min: 0, max: 100, defaultValue: 0, unit: '%' });
    expect(controls[3]).toMatchObject({ min: 0, max: 100, defaultValue: 70, unit: '%' });
    expect(getBrowserTrackFxMacroKeys('OCTAVE')).toEqual(['mix_percent']);
    expect(sanitizeBrowserTrackFxParameters('OCTAVE', {
      minus_24_level: -1, minus_12_level: 35, plus_12_level: 105, mix_percent: 85, tracking_percent: 50,
    })).toEqual({ minus_24_level: 0, minus_12_level: 35, plus_12_level: 100, mix_percent: 85 });
    expect(BROWSER_PER_TRACK_PARAMETER_KEYS.octave?.filter(key => !key.startsWith('official_'))).toEqual(['minus_24_level', 'minus_12_level', 'plus_12_level', 'mix_percent']);

    const voices = Array.from({ length: 3 }, () => ({
      connect: vi.fn(), disconnect: vi.fn(), latencySeconds: 0.02, latencySamples: 960,
      setPitch: vi.fn(async () => undefined),
    }));
    voices.forEach((voice) => pitchHarness.create.mockResolvedValueOnce(voice));
    vi.stubGlobal('AudioWorkletNode', ControlWorkletNode);
    const chain = new BrowserTrackFxChain(createMockAudioContext(), async () => {});
    expect(chain.setType(0, 'OCTAVE')).toBe(true);
    await vi.waitFor(() => expect(chain.getStatus(1).slots[0]).toMatchObject({ type: 'OCTAVE', state: 'ready', pendingApply: false }));
    expect(pitchHarness.create).toHaveBeenCalledTimes(3);
    for (const control of controls) {
      for (const value of [control.min, control.defaultValue, control.max]) {
        expect(chain.setNamedParameters(0, sanitizeBrowserTrackFxParameters('OCTAVE', { [control.key]: value })), control.key).toBe(true);
      }
    }
    expect(chain.setParameter(0, 55)).toBe(true);
    expect(chain.setNamedParameters(0, { tracking_percent: 50 })).toBe(false);
    expect(chain.setParameter(0, 55)).toBe(false);
    chain.dispose();
  });

  it('exposes the existing experimental AUTO RIFF controls on a private per-track host adapter', async () => {
    const controls = getBrowserTrackFxControls('AUTO RIFF (EXPERIMENTAL)').filter(control => control.provenance === 'extension');
    expect(controls.map(({ key }) => key)).toEqual(['scale', 'rate_beats', 'sensitivity_percent', 'mix_percent']);
    expect(controls[0]?.options).toEqual([
      { value: 0, label: 'Chromatic' }, { value: 1, label: 'Major' }, { value: 2, label: 'Natural minor' },
      { value: 3, label: 'Harmonic minor' }, { value: 4, label: 'Pentatonic' },
    ]);
    expect(controls[1]?.options).toEqual([
      { value: 0.25, label: '1/16' }, { value: 0.5, label: '1/8' }, { value: 1, label: '1/4' },
      { value: 2, label: '1/2' }, { value: 4, label: '1 bar' },
    ]);
    expect(controls[2]).toMatchObject({ min: 0, max: 100, defaultValue: 55, unit: '%' });
    expect(controls[3]).toMatchObject({ min: 0, max: 100, defaultValue: 65, unit: '%' });
    expect(getBrowserTrackFxMacroKeys('AUTO RIFF (EXPERIMENTAL)')).toEqual(['mix_percent']);
    expect(BROWSER_PER_TRACK_PARAMETER_KEYS['auto-riff']?.filter(key => !key.startsWith('official_'))).toEqual(['scale', 'rate_beats', 'sensitivity_percent', 'mix_percent']);
    expect(sanitizeBrowserTrackFxParameters('AUTO RIFF (EXPERIMENTAL)', {
      scale: 8, rate_beats: 0.3, sensitivity_percent: 120, mix_percent: 80, tracking: 0.5,
    })).toEqual({ scale: 4, rate_beats: 0.25, sensitivity_percent: 100, mix_percent: 80 });

    pitchHarness.create.mockResolvedValue({
      connect: vi.fn(), disconnect: vi.fn(), latencySeconds: 0.02, latencySamples: 960,
      setPitch: vi.fn(async () => undefined),
    });
    vi.stubGlobal('AudioWorkletNode', ControlWorkletNode);
    const chain = new BrowserTrackFxChain(createMockAudioContext(), async () => {}, () => {}, () => 174);
    expect(chain.setType(0, 'AUTO RIFF (EXPERIMENTAL)')).toBe(true);
    await vi.waitFor(() => expect(chain.getStatus(1).slots[0]).toMatchObject({ type: 'AUTO RIFF (EXPERIMENTAL)', state: 'ready', pendingApply: false }));
    expect(ControlWorkletNode.latest.options.processorOptions?.parameters).toMatchObject({ bpm: 174 });
    expect(chain.getStatus(1).slots[0]?.resourceNote).toContain('Live Signalsmith WASM reserved');
    expect(chain.setNamedParameters(0, { scale: 1, rate_beats: 0.25, sensitivity_percent: 80, mix_percent: 65 })).toBe(true);
    chain.setBpm(174);
    expect(chain.setParameter(0, 50)).toBe(true);
    expect(chain.setActive(0, true)).toBe(true);
    chain.dispose();
  });

  it('maps executable HRM AUTO catalog controls and keeps its 70 percent mix default', () => {
    expect(BROWSER_PER_TRACK_FX_TYPES).toContain('HRM AUTO (M)');
    const controls = getBrowserTrackFxControls('HRM AUTO (M)').filter(control => control.provenance === 'extension');
    expect(controls.map(({ key }) => key)).toEqual(['key', 'scale', 'midi-channel', 'mix']);
    expect(controls[0]).toMatchObject({ min: 0, max: 11, defaultValue: 0, step: 1, unit: 'choice' });
    expect(controls[0]?.options).toEqual([
      { value: 0, label: 'C' }, { value: 1, label: 'C#' }, { value: 2, label: 'D' },
      { value: 3, label: 'D#' }, { value: 4, label: 'E' }, { value: 5, label: 'F' },
      { value: 6, label: 'F#' }, { value: 7, label: 'G' }, { value: 8, label: 'G#' },
      { value: 9, label: 'A' }, { value: 10, label: 'A#' }, { value: 11, label: 'B' },
    ]);
    expect(controls[1]?.options?.map(({ label }) => label)).toEqual(['Major', 'Natural minor', 'Harmonic minor', 'Dorian', 'Mixolydian']);
    expect(controls[2]).toMatchObject({ min: 1, max: 16, defaultValue: 1, step: 1, unit: 'channel' });
    expect(controls[3]).toMatchObject({ min: 0, max: 100, defaultValue: 70, unit: '%' });
    expect(getBrowserTrackFxMacroKeys('HRM AUTO (M)')).toEqual(['mix']);
    expect(BROWSER_PER_TRACK_PARAMETER_KEYS['hrm-auto']?.filter(key => !key.startsWith('official_'))).toEqual(['key', 'scale', 'midi-channel', 'mix']);
    expect(sanitizeBrowserTrackFxParameters('HRM AUTO (M)', {
      key: 11.8, scale: 3.4, 'midi-channel': 8.6, mix: 105, tracking: 0.5,
    })).toEqual({ key: 11, scale: 3, 'midi-channel': 9, mix: 100 });
  });

  it('never exposes unsupported VOCODER formant or spectral FREEZE controls', () => {
    expect(getBrowserTrackFxControls('VOCODER').some((control) => control.key.toLowerCase().includes('formant'))).toBe(false);
    expect(getBrowserTrackFxControls('FREEZE').some((control) => control.key === 'freezeMode')).toBe(false);
    expect(sanitizeBrowserTrackFxParameters('VOCODER', { formant: 4, vocoderCarrier: 1.8, vocoderBands: 12.4 })).toEqual({ vocoderCarrier: 2, vocoderBands: 12 });
  });

  it('routes the catalog RING.MOD waveform choice into the active per-track DSP core', async () => {
    const controls = getBrowserTrackFxControls('RING.MOD');
    expect(controls.find(({ label }) => label === 'Carrier waveform')).toMatchObject({
      key: 'ringModWaveform', min: 0, max: 1, defaultValue: 0,
      options: [{ value: 0, label: 'Sine' }, { value: 1, label: 'Triangle' }],
    });
    vi.stubGlobal('AudioWorkletNode', ControlWorkletNode);
    const chain = new BrowserTrackFxChain(createMockAudioContext(), async () => {});
    expect(chain.setType(0, 'RING.MOD')).toBe(true);
    await vi.waitFor(() => expect(chain.getStatus(1).slots[0]).toMatchObject({ type: 'RING.MOD', state: 'ready' }));
    expect(chain.setActive(0, true)).toBe(true);
    expect(chain.setNamedParameters(0, { ringModWaveform: 1 })).toBe(true);
    const routedCore = ControlWorkletNode.latest!.processor.core;
    const referenceCore = new BrowserFxDspCore('ring-mod', 48000, {
      ringModHz: 440, ringModDepth: 1, mix: 1, ringModWaveform: 0,
    });
    const inputLeft = new Float32Array(4096).fill(1);
    const inputRight = new Float32Array(4096).fill(1);
    const routedLeft = new Float32Array(4096);
    const routedRight = new Float32Array(4096);
    const referenceLeft = new Float32Array(4096);
    const referenceRight = new Float32Array(4096);
    routedCore.processBlock(inputLeft, inputRight, routedLeft, routedRight, 4096);
    referenceCore.processBlock(inputLeft, inputRight, referenceLeft, referenceRight, 4096);
    expect(routedLeft.some((sample, index) => Math.abs(sample - referenceLeft[index]!) > 1e-3)).toBe(true);
    expect([...routedLeft, ...routedRight].every(Number.isFinite)).toBe(true);
    chain.dispose();
  });
});
