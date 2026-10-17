import { expect, test } from '@playwright/test';

test('executes Browser VOCODER in the shipped AudioWorklet with modulator-gated carrier energy', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frameCount = sampleRate;
    const context = new OfflineAudioContext({ numberOfChannels: 2, length: frameCount, sampleRate });
    await context.audioWorklet.addModule('/worklets/fx-processor.js');

    const worklet = new AudioWorkletNode(context, 'rc505-fx-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: {
        algorithm: 'vocoder',
        sampleRate,
        bypassed: false,
        parameters: { vocoderBands: 16, vocoderCarrier: 1, mix: 1 },
      },
    });
    const input = context.createBuffer(2, frameCount, sampleRate);
    for (let frame = Math.floor(sampleRate * 0.25); frame < Math.floor(sampleRate * 0.65); frame += 1) {
      const sample = 0.4 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate);
      input.getChannelData(0)[frame] = sample;
      input.getChannelData(1)[frame] = sample;
    }
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(worklet);
    worklet.connect(context.destination);
    source.start(0);

    const rendered = await context.startRendering();
    const output = rendered.getChannelData(0);
    const rms = (start: number, end: number): number => {
      let energy = 0;
      for (let frame = start; frame < end; frame += 1) energy += (output[frame] ?? 0) ** 2;
      return Math.sqrt(energy / (end - start));
    };
    const spectralMagnitude = (frequencyHz: number, start: number, end: number): number => {
      const coefficient = 2 * Math.cos((2 * Math.PI * frequencyHz) / sampleRate);
      let previous = 0;
      let previous2 = 0;
      for (let frame = start; frame < end; frame += 1) {
        const current = (output[frame] ?? 0) + (coefficient * previous) - previous2;
        previous2 = previous;
        previous = current;
      }
      const power = Math.max(0, (previous * previous) + (previous2 * previous2) - (coefficient * previous * previous2));
      return (2 * Math.sqrt(power)) / (end - start);
    };
    let nonFiniteSamples = 0;
    for (let frame = 0; frame < rendered.length; frame += 1) {
      if (!Number.isFinite(output[frame])) nonFiniteSamples += 1;
    }
    return {
      length: rendered.length,
      nonFiniteSamples,
      activeRms: rms(Math.floor(sampleRate * 0.32), Math.floor(sampleRate * 0.55)),
      tailRms: rms(Math.floor(sampleRate * 0.85), Math.floor(sampleRate * 0.98)),
      440: spectralMagnitude(440, Math.floor(sampleRate * 0.32), Math.floor(sampleRate * 0.55)),
    };
  });

  expect(result.length).toBe(48_000);
  expect(result.nonFiniteSamples).toBe(0);
  expect(result.activeRms).toBeGreaterThan(0.002);
  expect(result.activeRms).toBeGreaterThan(result.tailRms * 3);
  expect(result[440]).toBeGreaterThan(0.002);
});
