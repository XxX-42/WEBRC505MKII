import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_PER_TRACK_FX_TYPES, BROWSER_PER_TRACK_PARAMETER_KEYS, BrowserTrackFxChain } from '../../src/audio/BrowserTrackFxChain';
import { BROWSER_WORKLET_FX_TYPES } from '../../src/audio/fx/BrowserWorkletFX';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';
import { getBrowserTrackFxControls, sanitizeBrowserTrackFxParameters } from '../../src/composables/browserTrackFxParameters';
import { createMockAudioContext } from '../helpers/audioTestUtils';

class ControlWorkletNode {
  static latest: ControlWorkletNode;
  readonly processor: FxProcessor;
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  onprocessorerror: (() => void) | null = null;
  readonly port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (message: unknown) => this.processor.port.onmessage?.({ data: message }),
  };
  constructor(_context: AudioContext, _name: string, options: AudioWorkletNodeOptions) {
    this.processor = new FxProcessor(options);
    this.processor.port.postMessage = (message: unknown) => this.port.onmessage?.({ data: message } as MessageEvent);
    ControlWorkletNode.latest = this;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('Browser per-track named control coverage', () => {
  it.each(BROWSER_PER_TRACK_FX_TYPES)('maps only executable canonical controls and renders %s at every control bound', async (type) => {
    const name = type.replace(' (EXPERIMENTAL)', '') as keyof typeof BROWSER_WORKLET_FX_TYPES;
    const algorithm = BROWSER_WORKLET_FX_TYPES[name];
    const controls = getBrowserTrackFxControls(type);
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(BROWSER_PER_TRACK_PARAMETER_KEYS[algorithm], control.key).toContain(control.key);
    vi.stubGlobal('AudioWorkletNode', ControlWorkletNode);
    const chain = new BrowserTrackFxChain(createMockAudioContext(), async () => {});
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

  it('never exposes unsupported VOCODER formant or spectral FREEZE controls', () => {
    expect(getBrowserTrackFxControls('VOCODER').some((control) => control.key.toLowerCase().includes('formant'))).toBe(false);
    expect(getBrowserTrackFxControls('FREEZE').some((control) => control.key === 'freezeMode')).toBe(false);
    expect(sanitizeBrowserTrackFxParameters('VOCODER', { formant: 4, vocoderCarrier: 1.8, vocoderBands: 12.4 })).toEqual({ vocoderCarrier: 2, vocoderBands: 12 });
  });
});
