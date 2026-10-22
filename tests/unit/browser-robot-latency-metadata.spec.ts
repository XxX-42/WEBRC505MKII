import { describe, expect, it } from 'vitest';
import { BROWSER_FX_ALGORITHM_INFO, BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { getLiveMonoPitchLatencySamples } from '../../src/audio/pitch/liveMono';

const SAMPLE_RATE_LATENCIES = [
  [8_000, 237], [12_000, 355], [16_000, 474], [22_050, 649], [24_000, 708], [32_000, 945],
  [44_100, 1_298], [48_000, 1_416], [88_200, 2_595], [96_000, 2_831], [192_000, 5_661],
] as const;

function makeCore(sampleRate: number): BrowserFxDspCore {
  const core = new BrowserFxDspCore('robot', sampleRate, { mix: 1, robotPitch: 7 });
  core.setBypass(false);
  return core;
}

function render(core: BrowserFxDspCore, input: Float32Array, chunks: readonly number[] = [128]): Float32Array {
  const output = new Float32Array(input.length);
  let frame = 0;
  let chunk = 0;
  while (frame < input.length) {
    const end = Math.min(input.length, frame + chunks[chunk % chunks.length]!);
    const left = output.subarray(frame, end);
    const right = new Float32Array(end - frame);
    const source = input.subarray(frame, end);
    core.processBlock(source, source, left, right, source.length);
    expect(right).toEqual(left);
    frame = end;
    chunk += 1;
  }
  return output;
}

describe('Browser ROBOT core latency metadata', () => {
  it('publishes the 48 kHz default core reference, not the tracker or host-aligned latency', () => {
    const core = makeCore(48_000);
    expect(BROWSER_FX_ALGORITHM_INFO.robot.algorithmicLatencySamples).toBe(1_416);
    expect(core.algorithmicLatencySamples).toBe(1_416);
    expect(core.robotTrackerAcquisitionFrames).toBe(1_880);
    // Acquisition is a separate estimate, not extra serial delay to add to PSOLA.
    expect(core.algorithmicLatencySamples).not.toBe(core.robotTrackerAcquisitionFrames);
  });

  it.each(SAMPLE_RATE_LATENCIES)('reports and renders the unvoiced fixed delay at %i Hz', (sampleRate, latency) => {
    const core = makeCore(sampleRate);
    expect(getLiveMonoPitchLatencySamples(sampleRate, 130)).toBe(latency);
    expect(core.algorithmicLatencySamples).toBe(latency);
    expect(core.robotPsolaLatencySamples).toBe(latency);
    expect(core.lastRobotProcessingMode).toBe('signalsmith');
    expect(core.lastRobotModeReason).toBe('unvoiced');

    // An isolated unvoiced impulse exercises the explicit delayed-input path.
    // It does not estimate the peak/group delay of time-varying pitched synthesis.
    const input = new Float32Array(latency + 257);
    input[0] = 0.5;
    const output = render(core, input, [1, 127, 64, 257]);
    // Ignore the floating-point cos(pi / 2) residue of the shared wet/dry mix.
    expect(output.findIndex((sample) => Math.abs(sample) > 1e-8)).toBe(latency);
    expect(output.slice(0, latency).every((sample) => Math.abs(sample) < 1e-12)).toBe(true);
    expect(output[latency]).toBe(0.5);
    expect(output.slice(latency + 1).every((sample) => sample === 0)).toBe(true);
    expect(core.lastRobotProcessingMode).toBe('signalsmith');
    expect(core.algorithmicLatencySamples).toBe(latency);
  });

  it.each([8_000, 44_100, 48_000, 96_000, 192_000])('keeps core latency separate from the host mode gate at %i Hz', (sampleRate) => {
    const core = makeCore(sampleRate);
    const latency = getLiveMonoPitchLatencySamples(sampleRate, 130);
    const input = Float32Array.from({ length: Math.max(4_096, Math.ceil(sampleRate * 0.15)) },
      (_, frame) => 0.3 * Math.sin(2 * Math.PI * 440 * frame / sampleRate));
    render(core, input);
    expect(core.lastRobotProcessingMode).toBe('psola');
    expect(core.lastRobotModeReason).toBe('stable-voiced');
    expect(core.algorithmicLatencySamples).toBe(latency);

    core.setParameters({ robotFormantSemitones: 3 });
    expect(core.lastRobotProcessingMode).toBe('signalsmith');
    expect(core.lastRobotModeReason).toBe('formant-control-active');
    expect(core.algorithmicLatencySamples).toBe(latency);

    core.setParameters({ robotFormantSemitones: 0 });
    expect(core.lastRobotProcessingMode).toBe('psola');
    expect(core.algorithmicLatencySamples).toBe(latency);

    core.setParameters({ robotPitch: 18 });
    expect(core.lastRobotProcessingMode).toBe('signalsmith');
    expect(core.lastRobotModeReason).toBe('target-shift-out-of-range');
    expect(core.algorithmicLatencySamples).toBe(latency);

    core.setParameters({ robotPitch: 7 });
    expect(core.lastRobotProcessingMode).toBe('psola');
    render(core, new Float32Array(input.length));
    expect(core.lastRobotProcessingMode).toBe('signalsmith');
    expect(core.lastRobotModeReason).toBe('unvoiced');
    expect(core.algorithmicLatencySamples).toBe(latency);

    core.reset();
    expect(core.lastRobotProcessingMode).toBe('signalsmith');
    expect(core.algorithmicLatencySamples).toBe(latency);
  });

  it('describes the wet engine rather than the immediate bypass or dry output', () => {
    const core = makeCore(48_000);
    const input = new Float32Array(128);
    input[0] = 0.5;
    core.setBypass(true);
    expect(render(core, input)).toEqual(input);
    expect(core.algorithmicLatencySamples).toBe(1_416);

    const dry = new BrowserFxDspCore('robot', 48_000, { mix: 0 });
    dry.setBypass(false);
    expect(render(dry, input)).toEqual(input);
    expect(dry.algorithmicLatencySamples).toBe(1_416);
  });
});
