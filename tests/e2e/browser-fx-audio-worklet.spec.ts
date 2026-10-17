import { expect, test } from '@playwright/test';

test('executes the shipped VIBRATO processor in a real Chromium AudioWorklet', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frameCount = 8_192;
    const context = new OfflineAudioContext({ numberOfChannels: 2, length: frameCount, sampleRate });
    await context.audioWorklet.addModule('/worklets/fx-processor.js');

    const worklet = new AudioWorkletNode(context, 'rc505-fx-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2],
      processorOptions: {
        algorithm: 'vibrato',
        sampleRate,
        bypassed: false,
        parameters: {
          vibratoRateHz: 0.7,
          vibratoDepthPercent: 40,
          vibratoDelayMs: 3.5,
          mix: 1,
        },
      },
    });

    const input = context.createBuffer(2, frameCount, sampleRate);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const time = frame / sampleRate;
      input.getChannelData(0)[frame] = 0.18 * Math.sin(2 * Math.PI * 440 * time);
      input.getChannelData(1)[frame] = 0.12 * Math.sin(2 * Math.PI * 660 * time + 0.2);
    }

    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(worklet);
    worklet.connect(context.destination);
    source.start(0);

    const rendered = await context.startRendering();
    const left = rendered.getChannelData(0);
    const right = rendered.getChannelData(1);
    let nonFiniteSamples = 0;
    let nonZeroSamples = 0;
    let peak = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const leftSample = left[frame] ?? 0;
      const rightSample = right[frame] ?? 0;
      if (!Number.isFinite(leftSample) || !Number.isFinite(rightSample)) nonFiniteSamples += 1;
      if (leftSample !== 0 || rightSample !== 0) nonZeroSamples += 1;
      peak = Math.max(peak, Math.abs(leftSample), Math.abs(rightSample));
    }
    return { sampleRate: rendered.sampleRate, length: rendered.length, nonFiniteSamples, nonZeroSamples, peak };
  });

  expect(result.sampleRate).toBe(48_000);
  expect(result.length).toBe(8_192);
  expect(result.nonFiniteSamples).toBe(0);
  expect(result.nonZeroSamples).toBeGreaterThan(1_000);
  expect(result.peak).toBeGreaterThan(0.01);
});

test('executes clean-room OSC BOT carrier-bank synthesis in the shipped AudioWorklet', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frameCount = sampleRate;
    const context = new OfflineAudioContext({ numberOfChannels: 2, length: frameCount, sampleRate });
    await context.audioWorklet.addModule('/worklets/fx-processor.js');
    const worklet = new AudioWorkletNode(context, 'rc505-fx-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2],
      processorOptions: {
        algorithm: 'osc-bot',
        sampleRate,
        bypassed: false,
        parameters: { oscBotWaveform: 0, oscBotPattern: 3, oscBotToneHz: 3000, bpm: 120, mix: 1 },
      },
    });
    const input = context.createBuffer(2, frameCount, sampleRate);
    for (let frame = Math.floor(sampleRate * 0.15); frame < Math.floor(sampleRate * 0.75); frame += 1) {
      const sample = 0.35 * Math.sin((2 * Math.PI * 180 * frame) / sampleRate);
      input.getChannelData(0)[frame] = sample;
      input.getChannelData(1)[frame] = sample;
    }
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(worklet);
    worklet.connect(context.destination);
    source.start(0);

    const rendered = await context.startRendering();
    const left = rendered.getChannelData(0);
    const right = rendered.getChannelData(1);
    const rms = (channel: Float32Array, start: number, end: number): number => {
      let energy = 0;
      for (let frame = start; frame < end; frame += 1) energy += (channel[frame] ?? 0) ** 2;
      return Math.sqrt(energy / (end - start));
    };
    let nonFinite = 0;
    let maxStereoDifference = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const l = left[frame] ?? 0;
      const r = right[frame] ?? 0;
      if (!Number.isFinite(l) || !Number.isFinite(r)) nonFinite += 1;
      maxStereoDifference = Math.max(maxStereoDifference, Math.abs(l - r));
    }
    return {
      length: rendered.length,
      nonFinite,
      activeRms: rms(left, Math.floor(sampleRate * 0.28), Math.floor(sampleRate * 0.62)),
      tailRms: rms(left, Math.floor(sampleRate * 0.88), Math.floor(sampleRate * 0.98)),
      maxStereoDifference,
    };
  });

  expect(result.length).toBe(48_000);
  expect(result.nonFinite).toBe(0);
  expect(result.activeRms).toBeGreaterThan(0.001);
  expect(result.activeRms).toBeGreaterThan(result.tailRms * 2);
  expect(result.maxStereoDifference).toBeLessThan(1e-6);
});

test('executes experimental REVERSE REVERB segment capture and diffuse tail in Chromium AudioWorklet', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const segmentFrames = Math.round(sampleRate * (60 / 300) * 0.25);
    const frameCount = sampleRate * 0.25;
    const context = new OfflineAudioContext({ numberOfChannels: 2, length: frameCount, sampleRate });
    await context.audioWorklet.addModule('/worklets/fx-processor.js');
    const worklet = new AudioWorkletNode(context, 'rc505-fx-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2],
      processorOptions: {
        algorithm: 'reverse-reverb',
        sampleRate,
        bypassed: false,
        parameters: {
          bpm: 300,
          reverseReverbSegmentBeats: 0.25,
          reverseReverbFeedbackPercent: 0,
          reverseReverbCrossfadeMs: 20,
          reverseReverbDecaySeconds: 2,
          reverseReverbDampingCutoffHz: 8000,
          mix: 1,
        },
      },
    });
    const input = context.createBuffer(2, frameCount, sampleRate);
    input.getChannelData(0)[100] = 0.8;
    input.getChannelData(1)[100] = -0.6;
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(worklet);
    worklet.connect(context.destination);
    source.start(0);

    const rendered = await context.startRendering();
    const left = rendered.getChannelData(0);
    const right = rendered.getChannelData(1);
    let beforeCaptureEnergy = 0;
    let returnedEnergy = 0;
    let peak = 0;
    let nonFiniteSamples = 0;
    let firstWetFrame = -1;
    for (let frame = 0; frame < rendered.length; frame += 1) {
      const l = left[frame] ?? 0;
      const r = right[frame] ?? 0;
      if (!Number.isFinite(l) || !Number.isFinite(r)) nonFiniteSamples += 1;
      const energy = (l * l) + (r * r);
      if (frame < segmentFrames) beforeCaptureEnergy += energy;
      if (frame >= segmentFrames) returnedEnergy += energy;
      if (firstWetFrame < 0 && energy > 1e-12) firstWetFrame = frame;
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
    }
    return { frameCount: rendered.length, segmentFrames, beforeCaptureEnergy, returnedEnergy, peak, nonFiniteSamples, firstWetFrame };
  });

  expect(result.frameCount).toBe(12_000);
  expect(result.segmentFrames).toBe(2_400);
  expect(result.beforeCaptureEnergy).toBeLessThan(1e-16);
  expect(result.returnedEnergy).toBeGreaterThan(1e-8);
  expect(result.peak).toBeGreaterThan(1e-5);
  expect(result.nonFiniteSamples).toBe(0);
  expect(result.firstWetFrame).toBeGreaterThan(result.segmentFrames);
});

test('executes sample-clocked stereo ROLL capture and retrigger in Chromium AudioWorklet', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const sliceFrames = 6_000; // 0.25 beat at 120 BPM
    const frameCount = sliceFrames * 3;
    const context = new OfflineAudioContext({ numberOfChannels: 2, length: frameCount, sampleRate });
    await context.audioWorklet.addModule('/worklets/fx-processor.js');
    const worklet = new AudioWorkletNode(context, 'rc505-fx-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2],
      processorOptions: {
        algorithm: 'roll',
        sampleRate,
        bypassed: false,
        parameters: {
          bpm: 120,
          rollSliceBeats: 0.25,
          rollDecayPercent: 100,
          rollPitchSemitones: 0,
          rollDirection: 0,
          mix: 1,
        },
      },
    });

    const input = context.createBuffer(2, frameCount, sampleRate);
    for (let frame = 0; frame < sliceFrames; frame += 1) {
      input.getChannelData(0)[frame] = 0.3 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate);
      input.getChannelData(1)[frame] = 0.2 * Math.sin((2 * Math.PI * 660 * frame) / sampleRate + 0.2);
    }
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(worklet);
    worklet.connect(context.destination);
    source.start(0);

    const rendered = await context.startRendering();
    const left = rendered.getChannelData(0);
    const right = rendered.getChannelData(1);
    const rms = (channel: Float32Array, start: number, end: number) => {
      let energy = 0;
      for (let frame = start; frame < end; frame += 1) energy += (channel[frame] ?? 0) ** 2;
      return Math.sqrt(energy / (end - start));
    };
    let nonFiniteSamples = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      if (!Number.isFinite(left[frame]) || !Number.isFinite(right[frame])) nonFiniteSamples += 1;
    }
    return {
      sampleRate: rendered.sampleRate,
      nonFiniteSamples,
      initialDryLeft: rms(left, 0, sliceFrames),
      initialDryRight: rms(right, 0, sliceFrames),
      retriggerLeft: rms(left, sliceFrames + 64, sliceFrames * 2),
      retriggerRight: rms(right, sliceFrames + 64, sliceFrames * 2),
      replacedSliceLeft: rms(left, sliceFrames * 2 + 64, frameCount),
      replacedSliceRight: rms(right, sliceFrames * 2 + 64, frameCount),
    };
  });

  expect(result.sampleRate).toBe(48_000);
  expect(result.nonFiniteSamples).toBe(0);
  expect(result.initialDryLeft).toBeGreaterThan(0.18);
  expect(result.initialDryRight).toBeGreaterThan(0.12);
  expect(result.retriggerLeft).toBeGreaterThan(0.18);
  expect(result.retriggerRight).toBeGreaterThan(0.12);
  expect(result.replacedSliceLeft).toBeLessThan(1e-6);
  expect(result.replacedSliceRight).toBeLessThan(1e-6);
});

test('executes Browser FREEZE capture and hold in the shipped AudioWorklet', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const captureFrames = Math.round(sampleRate * 0.02);
    const frameCount = Math.round(sampleRate * 0.2);
    const context = new OfflineAudioContext({ numberOfChannels: 2, length: frameCount, sampleRate });
    await context.audioWorklet.addModule('/worklets/fx-processor.js');
    const worklet = new AudioWorkletNode(context, 'rc505-fx-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2],
      processorOptions: {
        algorithm: 'freeze',
        sampleRate,
        bypassed: false,
        parameters: {
          mix: 1,
          freezeCaptureLengthMs: 20,
          freezePitchSemitones: 0,
          freezeMode: 0,
          freezeEnabled: 1,
        },
      },
    });
    const input = context.createBuffer(2, frameCount, sampleRate);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const frequency = frame < captureFrames ? 250 : 1100;
      const sample = 0.25 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
      input.getChannelData(0)[frame] = sample;
      input.getChannelData(1)[frame] = -0.8 * sample;
    }
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(worklet);
    worklet.connect(context.destination);
    source.start(0);

    const rendered = await context.startRendering();
    const left = rendered.getChannelData(0);
    const right = rendered.getChannelData(1);
    const start = Math.round(sampleRate * 0.08);
    const end = Math.round(sampleRate * 0.18);
    const magnitude = (frequency: number): number => {
      const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
      let previous = 0;
      let previous2 = 0;
      for (let frame = start; frame < end; frame += 1) {
        const current = (left[frame] ?? 0) + (coefficient * previous) - previous2;
        previous2 = previous;
        previous = current;
      }
      const power = Math.max(0, (previous * previous) + (previous2 * previous2) - (coefficient * previous * previous2));
      return (2 * Math.sqrt(power)) / (end - start);
    };
    let nonFiniteSamples = 0;
    let peak = 0;
    for (let frame = 0; frame < rendered.length; frame += 1) {
      const leftSample = left[frame] ?? 0;
      const rightSample = right[frame] ?? 0;
      if (!Number.isFinite(leftSample) || !Number.isFinite(rightSample)) nonFiniteSamples += 1;
      peak = Math.max(peak, Math.abs(leftSample), Math.abs(rightSample));
    }
    return {
      length: rendered.length,
      nonFiniteSamples,
      peak,
      capturedTone: magnitude(250),
      competingLiveTone: magnitude(1100),
    };
  });

  expect(result.length).toBe(9_600);
  expect(result.nonFiniteSamples).toBe(0);
  expect(result.peak).toBeGreaterThan(0.05);
  expect(result.peak).toBeLessThan(1);
  expect(result.capturedTone).toBeGreaterThan(0.05);
  expect(result.capturedTone).toBeGreaterThan(result.competingLiveTone * 2);
});

test('executes experimental WARP granular capture and FDN8 in the shipped AudioWorklet', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frameCount = Math.round(sampleRate * 0.3);
    const context = new OfflineAudioContext({ numberOfChannels: 2, length: frameCount, sampleRate });
    await context.audioWorklet.addModule('/worklets/fx-processor.js');
    const worklet = new AudioWorkletNode(context, 'rc505-fx-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2],
      processorOptions: {
        algorithm: 'warp',
        sampleRate,
        bypassed: false,
        parameters: {
          mix: 1,
          bpm: 300,
          warpCaptureBeats: 0.25,
          warpSmearPercent: 80,
          warpPitchSemitones: 5,
          warpFeedbackPercent: 65,
          warpFreezeEnabled: 1,
        },
      },
    });
    const input = context.createBuffer(2, frameCount, sampleRate);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const frequency = frame < Math.round(sampleRate * 0.1) ? 220 : 880;
      const phase = (2 * Math.PI * frequency * frame) / sampleRate;
      input.getChannelData(0)[frame] = 0.3 * Math.sin(phase);
      input.getChannelData(1)[frame] = 0.21 * Math.sin(phase + 0.25);
    }
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(worklet);
    worklet.connect(context.destination);
    source.start(0);

    const rendered = await context.startRendering();
    const left = rendered.getChannelData(0);
    const right = rendered.getChannelData(1);
    let nonFiniteSamples = 0;
    let peak = 0;
    let activeSamplesAfterCapture = 0;
    for (let frame = 0; frame < rendered.length; frame += 1) {
      const l = left[frame] ?? 0;
      const r = right[frame] ?? 0;
      if (!Number.isFinite(l) || !Number.isFinite(r)) nonFiniteSamples += 1;
      if (frame >= Math.round(sampleRate * 0.15) && (Math.abs(l) > 1e-5 || Math.abs(r) > 1e-5)) {
        activeSamplesAfterCapture += 1;
      }
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
    }
    return { sampleRate: rendered.sampleRate, length: rendered.length, nonFiniteSamples, activeSamplesAfterCapture, peak };
  });

  expect(result.sampleRate).toBe(48_000);
  expect(result.length).toBe(14_400);
  expect(result.nonFiniteSamples).toBe(0);
  expect(result.peak).toBeGreaterThan(0.01);
  expect(result.peak).toBeLessThan(8);
  expect(result.activeSamplesAfterCapture).toBeGreaterThan(1_000);
});

test('executes PREAMP in a real Chromium AudioWorklet and applies model/tone controls', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frameCount = 16_384;
    const render = async (parameters: Record<string, number>, configureThroughPort = false) => {
      const context = new OfflineAudioContext({ numberOfChannels: 2, length: frameCount, sampleRate });
      await context.audioWorklet.addModule('/worklets/fx-processor.js');
      const worklet = new AudioWorkletNode(context, 'rc505-fx-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'explicit',
        outputChannelCount: [2],
        processorOptions: {
          algorithm: 'preamp', sampleRate, bypassed: false,
          parameters: configureThroughPort
            ? { preampModel: 0, preampGainPercent: 36, preampBassDb: 0, preampMiddleDb: 0, preampTrebleDb: 0, preampLevelDb: 0 }
            : parameters,
        },
      });
      if (configureThroughPort) {
        // Use the same incremental configure messages sent by BrowserWorkletFX
        // after a user edits the six named controls.
        const updates = Object.entries(parameters).filter(([key]) => key !== 'mix');
        const acknowledgedKeys = new Set<string>();
        let resolveConfigured: (() => void) | null = null;
        let rejectConfigured: ((error: Error) => void) | null = null;
        const configured = new Promise<void>((resolve, reject) => {
          resolveConfigured = resolve;
          rejectConfigured = reject;
        });
        worklet.port.onmessage = (event: MessageEvent) => {
          if (event.data?.type === 'error') {
            rejectConfigured?.(new Error(`PREAMP worklet rejected named controls: ${String(event.data.message ?? 'unknown error')}`));
            return;
          }
          if (event.data?.type !== 'configure-ack' || !Array.isArray(event.data.parameterKeys)) return;
          for (const key of event.data.parameterKeys) acknowledgedKeys.add(String(key));
          if (updates.every(([key]) => acknowledgedKeys.has(key))) resolveConfigured?.();
        };
        for (const [key, value] of updates) {
          worklet.port.postMessage({ type: 'configure', parameters: { [key]: value } });
        }
        await Promise.race([
          configured,
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('PREAMP named controls were not acknowledged by the worklet')), 3000)),
        ]);
      }
      const input = context.createBuffer(2, frameCount, sampleRate);
      for (let frame = 0; frame < frameCount; frame += 1) {
        const time = frame / sampleRate;
        input.getChannelData(0)[frame] = 0.42 * Math.sin(2 * Math.PI * 220 * time) + 0.19 * Math.sin(2 * Math.PI * 1770 * time);
        input.getChannelData(1)[frame] = 0.31 * Math.sin(2 * Math.PI * 311 * time + 0.17);
      }
      const source = context.createBufferSource();
      source.buffer = input;
      source.connect(worklet);
      worklet.connect(context.destination);
      source.start(0);
      const rendered = await context.startRendering();
      const left = rendered.getChannelData(0);
      const right = rendered.getChannelData(1);
      let nonFiniteSamples = 0;
      let nonZeroSamples = 0;
      let peak = 0;
      let rmsEnergy = 0;
      for (let frame = 0; frame < frameCount; frame += 1) {
        const leftSample = left[frame] ?? 0;
        const rightSample = right[frame] ?? 0;
        if (!Number.isFinite(leftSample) || !Number.isFinite(rightSample)) nonFiniteSamples += 1;
        if (leftSample !== 0 || rightSample !== 0) nonZeroSamples += 1;
        peak = Math.max(peak, Math.abs(leftSample), Math.abs(rightSample));
        rmsEnergy += leftSample * leftSample + rightSample * rightSample;
      }
      return { left: Array.from(left), nonFiniteSamples, nonZeroSamples, peak, rms: Math.sqrt(rmsEnergy / (2 * frameCount)) };
    };

    const base = await render({
      preampModel: 0, preampGainPercent: 36, preampBassDb: 0,
      preampMiddleDb: 0, preampTrebleDb: 0, preampLevelDb: 0, mix: 0,
    });
    const mixChanged = await render({
      preampModel: 0, preampGainPercent: 36, preampBassDb: 0,
      preampMiddleDb: 0, preampTrebleDb: 0, preampLevelDb: 0, mix: 1,
    });
    const changed = await render({
      preampModel: 3, preampGainPercent: 82, preampBassDb: 5,
      preampMiddleDb: -3, preampTrebleDb: 7, preampLevelDb: -2, mix: 1,
    }, true);
    let differenceEnergy = 0;
    let mixDifferenceEnergy = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const delta = (base.left[frame] ?? 0) - (changed.left[frame] ?? 0);
      differenceEnergy += delta * delta;
      const mixDelta = (base.left[frame] ?? 0) - (mixChanged.left[frame] ?? 0);
      mixDifferenceEnergy += mixDelta * mixDelta;
    }
    return {
      base: { ...base, left: undefined },
      changed: { ...changed, left: undefined },
      differenceRms: Math.sqrt(differenceEnergy / frameCount),
      mixDifferenceRms: Math.sqrt(mixDifferenceEnergy / frameCount),
    };
  });

  for (const rendered of [result.base, result.changed]) {
    expect(rendered.nonFiniteSamples).toBe(0);
    expect(rendered.nonZeroSamples).toBeGreaterThan(10_000);
    expect(rendered.peak).toBeGreaterThan(0.01);
    expect(rendered.peak).toBeLessThan(4);
    expect(rendered.rms).toBeGreaterThan(0.01);
  }
  expect(result.differenceRms).toBeGreaterThan(0.01);
  expect(result.mixDifferenceRms).toBe(0);
});

test('renders an octave-down G2B bass voice in Chromium AudioWorklet', async ({ page }) => {
  await page.goto('/?audio=browser');
  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frameCount = sampleRate;
    const context = new OfflineAudioContext({ numberOfChannels: 2, length: frameCount, sampleRate });
    await context.audioWorklet.addModule('/worklets/fx-processor.js');
    const worklet = new AudioWorkletNode(context, 'rc505-fx-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2],
      processorOptions: {
        algorithm: 'g2b',
        sampleRate,
        bypassed: false,
        parameters: { g2bTrackingPercent: 75, g2bBlendPercent: 100, g2bBodyHz: 500 },
      },
    });
    const buffer = context.createBuffer(2, frameCount, sampleRate);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sample = 0.32 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate);
      buffer.getChannelData(0)[frame] = sample;
      buffer.getChannelData(1)[frame] = sample;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(worklet);
    worklet.connect(context.destination);
    source.start(0);
    const rendered = await context.startRendering();
    const left = rendered.getChannelData(0);
    const magnitude = (frequency: number) => {
      const start = Math.floor(sampleRate * 0.35);
      const count = Math.floor(sampleRate * 0.3);
      const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
      let previous = 0;
      let previous2 = 0;
      for (let frame = start; frame < start + count; frame += 1) {
        const current = (left[frame] ?? 0) + coefficient * previous - previous2;
        previous2 = previous;
        previous = current;
      }
      return 2 * Math.sqrt(Math.max(0, previous * previous + previous2 * previous2 - coefficient * previous * previous2)) / count;
    };
    let nonFiniteSamples = 0;
    for (const sample of left) if (!Number.isFinite(sample)) nonFiniteSamples += 1;
    return { bass110: magnitude(110), source220: magnitude(220), nonFiniteSamples };
  });
  expect(result.nonFiniteSamples).toBe(0);
  expect(result.bass110).toBeGreaterThan(0.04);
  expect(result.bass110).toBeGreaterThan(result.source220 * 2);
});

test('executes SYNTH in a real Chromium AudioWorklet and applies named controls through configure messages', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frameCount = Math.floor(sampleRate * 1.1);
    const context = new OfflineAudioContext({ numberOfChannels: 2, length: frameCount, sampleRate });
    await context.audioWorklet.addModule('/worklets/fx-processor.js');
    const worklet = new AudioWorkletNode(context, 'rc505-fx-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2],
      processorOptions: {
        algorithm: 'synth', sampleRate, bypassed: false,
        parameters: {
          synthSensitivity: 60, synthWaveform: 0, synthOctave: 0,
          synthToneHz: 4000, synthMixPercent: 0,
        },
      },
    });
    const configuredKeys = new Set<string>();
    let resolveConfigured: (() => void) | null = null;
    const configured = new Promise<void>((resolve) => { resolveConfigured = resolve; });
    worklet.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type !== 'configure-ack' || !Array.isArray(event.data.parameterKeys)) return;
      for (const key of event.data.parameterKeys) configuredKeys.add(String(key));
      if (configuredKeys.size === 5) resolveConfigured?.();
    };
    // Apply the same named parameter adapter updates that BrowserWorkletFX
    // sends when the user's SYNTH editor changes a control.
    for (const [key, value] of Object.entries({
      synthSensitivity: 75,
      synthWaveform: 1,
      synthOctave: 12,
      synthToneHz: 12_000,
      synthMixPercent: 100,
    })) {
      worklet.port.postMessage({ type: 'configure', parameters: { [key]: value } });
    }
    await Promise.race([
      configured,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('SYNTH named controls were not acknowledged by the worklet')), 3000)),
    ]);
    const input = context.createBuffer(2, frameCount, sampleRate);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sample = 0.32 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate);
      input.getChannelData(0)[frame] = sample;
      input.getChannelData(1)[frame] = sample * 0.8;
    }
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(worklet);
    worklet.connect(context.destination);
    source.start(0);
    const rendered = await context.startRendering();
    const left = rendered.getChannelData(0);
    const start = Math.floor(sampleRate * 0.35);
    const count = Math.floor(sampleRate * 0.5);
    const magnitude = (frequency: number): number => {
      const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
      let previous = 0;
      let previous2 = 0;
      for (let frame = start; frame < start + count; frame += 1) {
        const current = (left[frame] ?? 0) + (coefficient * previous) - previous2;
        previous2 = previous;
        previous = current;
      }
      const power = Math.max(0, (previous * previous) + (previous2 * previous2) - (coefficient * previous * previous2));
      return (2 * Math.sqrt(power)) / count;
    };
    let nonFiniteSamples = 0;
    let peak = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sample = left[frame] ?? 0;
      if (!Number.isFinite(sample)) nonFiniteSamples += 1;
      peak = Math.max(peak, Math.abs(sample));
    }
    return {
      length: rendered.length,
      nonFiniteSamples,
      peak,
      rootMagnitude: magnitude(220),
      octaveMagnitude: magnitude(440),
    };
  });

  expect(result.length).toBe(Math.floor(48_000 * 1.1));
  expect(result.nonFiniteSamples).toBe(0);
  expect(result.peak).toBeGreaterThan(0.01);
  expect(result.peak).toBeLessThan(4);
  expect(result.octaveMagnitude).toBeGreaterThan(0.05);
  expect(result.octaveMagnitude).toBeGreaterThan(result.rootMagnitude * 1.5);
});

test('executes the shipped REVERSE DELAY bundle with segment-reversed stereo audio', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const segmentFrames = 6_000; // 0.25 beat at 120 BPM
    const frameCount = segmentFrames * 2;
    const leftImpulseFrame = 1_000;
    const rightImpulseFrame = 1_800;
    const context = new OfflineAudioContext({ numberOfChannels: 2, length: frameCount, sampleRate });
    await context.audioWorklet.addModule('/worklets/fx-processor.js');

    const worklet = new AudioWorkletNode(context, 'rc505-fx-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2],
      processorOptions: {
        algorithm: 'reverse-delay',
        sampleRate,
        bypassed: false,
        parameters: {
          bpm: 120,
          reverseDelaySegmentBeats: 0.25,
          reverseDelayCrossfadeMs: 5,
          reverseDelayFeedback: 0,
          mix: 1,
        },
      },
    });

    const input = context.createBuffer(2, frameCount, sampleRate);
    input.getChannelData(0)[leftImpulseFrame] = 0.8;
    input.getChannelData(1)[rightImpulseFrame] = -0.45;
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(worklet);
    worklet.connect(context.destination);
    source.start(0);

    const rendered = await context.startRendering();
    const left = rendered.getChannelData(0);
    const right = rendered.getChannelData(1);
    const leftExpectedFrame = segmentFrames + segmentFrames - 1 - leftImpulseFrame;
    const rightExpectedFrame = segmentFrames + segmentFrames - 1 - rightImpulseFrame;
    const windowPeak = (channel: Float32Array, expectedFrame: number): number => {
      let peak = 0;
      for (let frame = expectedFrame - 3; frame <= expectedFrame + 3; frame += 1) {
        peak = Math.max(peak, Math.abs(channel[frame] ?? 0));
      }
      return peak;
    };
    let nonFiniteSamples = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      if (!Number.isFinite(left[frame] ?? 0) || !Number.isFinite(right[frame] ?? 0)) nonFiniteSamples += 1;
    }
    return {
      sampleRate: rendered.sampleRate,
      length: rendered.length,
      nonFiniteSamples,
      leftExpectedFrame,
      rightExpectedFrame,
      leftReversePeak: windowPeak(left, leftExpectedFrame),
      rightReversePeak: windowPeak(right, rightExpectedFrame),
      leftAtRightExpected: windowPeak(left, rightExpectedFrame),
      rightAtLeftExpected: windowPeak(right, leftExpectedFrame),
    };
  });

  expect(result.sampleRate).toBe(48_000);
  expect(result.length).toBe(12_000);
  expect(result.nonFiniteSamples).toBe(0);
  expect(result.leftExpectedFrame).toBe(10_999);
  expect(result.rightExpectedFrame).toBe(10_199);
  expect(result.leftReversePeak).toBeGreaterThan(0.5);
  expect(result.rightReversePeak).toBeGreaterThan(0.25);
  expect(result.leftAtRightExpected).toBeLessThan(0.01);
  expect(result.rightAtLeftExpected).toBeLessThan(0.01);
});

test('executes MIDI-scheduled OSC VOC through the shipped Browser AudioWorklet', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frameCount = 24_000;
    const context = new OfflineAudioContext({ numberOfChannels: 2, length: frameCount, sampleRate });
    await context.audioWorklet.addModule('/worklets/fx-processor.js');
    const worklet = new AudioWorkletNode(context, 'rc505-fx-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2],
      processorOptions: {
        algorithm: 'osc-voc',
        sampleRate,
        bypassed: false,
        parameters: { oscVocWaveform: 0, oscVocMidiChannel: 1, oscVocOctave: 0, oscVocBands: 16, mix: 1 },
      },
    });
    const processorErrors: string[] = [];
    const queuedFrames: number[] = [];
    let resolveEventsQueued: (() => void) | null = null;
    const eventsQueued = new Promise<void>((resolve) => { resolveEventsQueued = resolve; });
    worklet.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'error') processorErrors.push(String(event.data.message));
      if (event.data?.type === 'midi-event-queued') {
        queuedFrames.push(Number(event.data.frame));
        if (queuedFrames.length === 2) resolveEventsQueued?.();
      }
    };
    // A real message-port path, queued before render. The event is deliberately
    // ahead of the first block to allow browser worklet startup, while exact
    // arbitrary-frame scheduling is covered by the deterministic core tests.
    worklet.port.postMessage({ type: 'midi-note-on', channel: 1, note: 69, velocity: 127, frame: 2048 });
    worklet.port.postMessage({ type: 'midi-note-off', channel: 1, note: 69, frame: 18_000 });
    await Promise.race([
      eventsQueued,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('OSC VOC MIDI events were not acknowledged by the worklet')), 3000)),
    ]);

    const modulator = context.createBuffer(2, frameCount, sampleRate);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sample = 0.3 * Math.sin((2 * Math.PI * 180 * frame) / sampleRate);
      modulator.getChannelData(0)[frame] = sample;
      modulator.getChannelData(1)[frame] = sample;
    }
    const source = context.createBufferSource();
    source.buffer = modulator;
    source.connect(worklet);
    worklet.connect(context.destination);
    source.start(0);

    const rendered = await context.startRendering();
    const left = rendered.getChannelData(0);
    const right = rendered.getChannelData(1);
    const magnitude = (frequencyHz: number, start: number, count: number): number => {
      const coefficient = 2 * Math.cos((2 * Math.PI * frequencyHz) / sampleRate);
      let previous = 0;
      let previous2 = 0;
      for (let frame = start; frame < start + count; frame += 1) {
        const current = (left[frame] ?? 0) + (coefficient * previous) - previous2;
        previous2 = previous;
        previous = current;
      }
      const power = Math.max(0, (previous * previous) + (previous2 * previous2)
        - (coefficient * previous * previous2));
      return (2 * Math.sqrt(power)) / count;
    };
    const rms = (channel: Float32Array, start: number, end: number): number => {
      let energy = 0;
      for (let frame = start; frame < end; frame += 1) energy += (channel[frame] ?? 0) ** 2;
      return Math.sqrt(energy / (end - start));
    };
    let nonFinite = 0;
    let maxStereoDifference = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const l = left[frame] ?? 0;
      const r = right[frame] ?? 0;
      if (!Number.isFinite(l) || !Number.isFinite(r)) nonFinite += 1;
      maxStereoDifference = Math.max(maxStereoDifference, Math.abs(l - r));
    }
    return {
      length: rendered.length,
      nonFinite,
      processorErrors,
      queuedFrames,
      activeRms: rms(left, 5_000, 16_000),
      tailRms: rms(left, 22_000, 23_999),
      fundamental: magnitude(440, 5_000, 11_000),
      subharmonic: magnitude(220, 5_000, 11_000),
      secondHarmonic: magnitude(880, 5_000, 11_000),
      maxStereoDifference,
    };
  });

  expect(result.length).toBe(24_000);
  expect(result.nonFinite).toBe(0);
  expect(result.processorErrors).toEqual([]);
  expect(result.queuedFrames).toEqual([2048, 18_000]);
  expect(result.activeRms).toBeGreaterThan(0.002);
  expect(result.tailRms, JSON.stringify(result)).toBeLessThan(result.activeRms * 0.15);
  expect(result.fundamental).toBeGreaterThan(result.subharmonic * 1.1);
  expect(result.fundamental).toBeGreaterThan(result.secondHarmonic * 1.1);
  expect(result.maxStereoDifference).toBeLessThan(1e-6);
});
