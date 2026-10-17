import { describe, expect, it, vi } from 'vitest';
import { BROWSER_WORKLET_FX_TYPES, type BrowserWorkletFxName } from '../../src/audio/fx/BrowserWorkletFX';
import { BROWSER_FX_ALGORITHM_INFO, type BrowserFxAlgorithm } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';

describe('Browser AudioWorklet FX registry', () => {
  it('constructs the exact algorithm for every user-selectable Browser Worklet FX', () => {
    const registered = Object.entries(BROWSER_WORKLET_FX_TYPES) as Array<[BrowserWorkletFxName, BrowserFxAlgorithm]>;
    expect(registered.length).toBeGreaterThan(30);
    expect([...new Set(registered.map(([, algorithm]) => algorithm))].sort())
      .toEqual(Object.keys(BROWSER_FX_ALGORITHM_INFO)
        .filter((algorithm) => !['auto-riff', 'hrm-auto', 'robot'].includes(algorithm))
        .sort());
    // AUTO RIFF is a host-composed processor: FxProcessor supplies the
    // sample-clocked analyzer while BrowserAutoRiffFX connects Signalsmith.
    expect(BROWSER_FX_ALGORITHM_INFO['auto-riff'].implementationStatus).toBe('experimental');
    expect(BROWSER_FX_ALGORITHM_INFO['hrm-auto'].implementationStatus).toBe('experimental');
    // ROBOT has a dedicated host adapter and sample-clocked Signalsmith fallback.
    expect(BROWSER_FX_ALGORITHM_INFO.robot.implementationStatus).toBe('experimental');
    for (const [displayName, algorithm] of registered) {
      const processor = new FxProcessor({
        processorOptions: {
          algorithm,
          sampleRate: 48_000,
          bypassed: false,
        },
      });
      expect(processor.core.algorithm, `${displayName} must not silently map to another DSP`).toBe(algorithm);
    }
    expect(BROWSER_FX_ALGORITHM_INFO['reverse-reverb'].implementationStatus)
      .toBe('experimental');
  });

  it('rejects an explicitly unknown algorithm instead of silently running LPF', () => {
    expect(() => new FxProcessor({
      processorOptions: { algorithm: 'unknown-effect' as BrowserFxAlgorithm, sampleRate: 48_000, bypassed: false },
    })).toThrow('Unsupported Browser FX algorithm: unknown-effect');
  });

  it('rejects a missing algorithm instead of silently defaulting to LPF', () => {
    expect(() => new FxProcessor()).toThrow('Unsupported Browser FX algorithm: missing');
    expect(() => new FxProcessor({ processorOptions: { sampleRate: 48_000 } }))
      .toThrow('Unsupported Browser FX algorithm: missing');
  });

  it('reports unsupported spectral FREEZE mode explicitly', () => {
    const processor = new FxProcessor({
      processorOptions: { algorithm: 'freeze', sampleRate: 48_000, bypassed: false },
    });
    const postMessage = vi.fn();
    processor.port.postMessage = postMessage;
    processor.port.onmessage?.({
      data: { type: 'configure', parameters: { freezeMode: 1 } },
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'error',
      message: 'Spectral FREEZE mode is unavailable; only micro-loop mode is wired.',
    });
    expect(processor.core.algorithm).toBe('freeze');
  });

  it('emits sample-clocked AUTO RIFF pitch commands while preserving analysis audio', () => {
    const oldFrame = (globalThis as unknown as { currentFrame?: number }).currentFrame;
    const currentFrameHost = globalThis as unknown as { currentFrame?: number };
    const processor = new FxProcessor({
      processorOptions: {
        algorithm: 'auto-riff',
        sampleRate: 8_000,
        parameters: {
          bpm: 300,
          autoRiffRateBeats: 0.25,
          autoRiffScale: 1,
          autoRiffSensitivityPercent: 75,
        },
        bypassed: false,
      },
    });
    const postMessage = vi.fn();
    processor.port.postMessage = postMessage;
    const blockLengths = [31, 64, 97, 128] as const;
    const totalFrames = 16_000;
    let frame = 0;
    try {
      while (frame < totalFrames) {
        const length = Math.min(blockLengths[(frame >>> 5) & 3]!, totalFrames - frame);
        currentFrameHost.currentFrame = frame;
        const input = new Float32Array(length);
        const output = new Float32Array(length);
        for (let i = 0; i < length; i += 1) {
          const absolute = frame + i;
          const attack = absolute < 160 ? absolute / 160 : 1;
          input[i] = 0.32 * attack * Math.sin((2 * Math.PI * 220 * absolute) / 8_000);
        }
        processor.process([[input]], [[output, new Float32Array(length)]]);
        expect(output).toEqual(input);
        frame += length;
      }
    } finally {
      if (oldFrame === undefined) delete currentFrameHost.currentFrame;
      else currentFrameHost.currentFrame = oldFrame;
    }

    const commands = postMessage.mock.calls
      .map(([message]) => message as { type?: string; frame?: number; semitones?: number })
      .filter((message) => message.type === 'auto-riff-pitch');
    expect(commands.length).toBeGreaterThanOrEqual(3);
    expect(commands.every((event) => Number.isSafeInteger(event.frame) && Number.isFinite(event.semitones))).toBe(true);
    const eventFrames = commands.map((event) => event.frame as number);
    expect(eventFrames).toEqual([...eventFrames].sort((a, b) => a - b));
    expect(eventFrames.every((eventFrame) => eventFrame >= 0 && eventFrame < totalFrames)).toBe(true);
  });
});
