import { expect, test } from '@playwright/test';

test('routes Signalsmith TRANSPOSE on one private track chain without changing a neighboring track', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frameCount = sampleRate;
    const context = new OfflineAudioContext(2, frameCount, sampleRate);
    const { BrowserTrackFxChain } = await import('/src/audio/BrowserTrackFxChain.ts');
    const ensureModule = () => context.audioWorklet.addModule('/worklets/fx-processor.js');
    const shifted = new BrowserTrackFxChain(context as unknown as AudioContext, ensureModule);
    const untouched = new BrowserTrackFxChain(context as unknown as AudioContext, ensureModule);

    if (!shifted.setType(0, 'TRANSPOSE')) throw new Error('private TRANSPOSE adapter was rejected');
    if (!shifted.setNamedParameters(0, { shift: 12, mix: 100 })) throw new Error('private TRANSPOSE controls were rejected');
    if (!shifted.setActive(0, true)) throw new Error('private TRANSPOSE could not be activated');

    const waitUntilReady = async () => {
      const deadline = performance.now() + 10_000;
      while (shifted.getStatus(1).slots[0]?.state === 'loading' && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return shifted.getStatus(1).slots[0];
    };
    const status = await waitUntilReady();
    if (status?.state !== 'ready') throw new Error(`private TRANSPOSE did not become ready: ${status?.error ?? status?.state}`);

    const makeTone = (frequency: number) => {
      const buffer = context.createBuffer(1, frameCount, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let frame = 0; frame < frameCount; frame += 1) channel[frame] = 0.25 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
      return buffer;
    };
    const sourceA = context.createBufferSource();
    sourceA.buffer = makeTone(220);
    sourceA.connect(shifted.input);
    const sourceB = context.createBufferSource();
    sourceB.buffer = makeTone(330);
    sourceB.connect(untouched.input);

    const merger = context.createChannelMerger(2);
    const splitA = context.createChannelSplitter(2);
    const splitB = context.createChannelSplitter(2);
    shifted.output.connect(splitA);
    untouched.output.connect(splitB);
    splitA.connect(merger, 0, 0);
    splitB.connect(merger, 0, 1);
    merger.connect(context.destination);
    sourceA.start();
    sourceB.start();

    const rendered = await context.startRendering();
    const powerAt = (samples: Float32Array, frequency: number, start: number, end: number): number => {
      const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
      let previous = 0;
      let beforePrevious = 0;
      let mean = 0;
      for (let index = start; index < end; index += 1) mean += samples[index] ?? 0;
      mean /= end - start;
      for (let index = start; index < end; index += 1) {
        const current = coefficient * previous - beforePrevious + (samples[index] ?? 0) - mean;
        beforePrevious = previous;
        previous = current;
      }
      return Math.max(0, previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious);
    };
    const start = Math.round(sampleRate * 0.28);
    const end = Math.round(sampleRate * 0.9);
    const shiftedOutput = rendered.getChannelData(0);
    const untouchedOutput = rendered.getChannelData(1);
    const measurement = {
      shiftedTarget: powerAt(shiftedOutput, 440, start, end),
      shiftedSource: powerAt(shiftedOutput, 220, start, end),
      untouchedTarget: powerAt(untouchedOutput, 330, start, end),
      untouchedShiftedTone: powerAt(untouchedOutput, 440, start, end),
      finite: [...shiftedOutput, ...untouchedOutput].every(Number.isFinite),
      activeTrack: status?.active,
      state: status?.state,
      resourceNote: status?.resourceNote,
      untouchedState: untouched.getStatus(2).slots[0]?.state,
    };
    shifted.dispose();
    untouched.dispose();
    return measurement;
  });

  expect(result.state).toBe('ready');
  expect(result.activeTrack).toBe(true);
  expect(result.untouchedState).toBe('empty');
  expect(result.resourceNote).toContain('Live Signalsmith WASM reserved');
  expect(result.finite).toBe(true);
  expect(result.shiftedTarget).toBeGreaterThan(result.shiftedSource * 8);
  expect(result.untouchedTarget).toBeGreaterThan(result.untouchedShiftedTone * 8);
});

test('keeps the active TRANSPOSE signal when a replacement AudioWorklet module fails', async ({ page }) => {
  await page.goto('/?audio=browser');

  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const frameCount = sampleRate;
    const context = new OfflineAudioContext(1, frameCount, sampleRate);
    const { BrowserTrackFxChain } = await import('/src/audio/BrowserTrackFxChain.ts');
    let rejectWorkletModule = false;
    const ensureModule = () => rejectWorkletModule
      ? Promise.reject(new Error('forced candidate module failure'))
      : context.audioWorklet.addModule('/worklets/fx-processor.js');
    const chain = new BrowserTrackFxChain(context as unknown as AudioContext, ensureModule);
    if (!chain.setType(0, 'TRANSPOSE')) throw new Error('TRANSPOSE rejected');
    chain.setNamedParameters(0, { shift: 12, mix: 100 });
    chain.setActive(0, true);
    const deadline = performance.now() + 10_000;
    while (chain.getStatus(1).slots[0]?.state === 'loading' && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (chain.getStatus(1).slots[0]?.state !== 'ready') throw new Error('TRANSPOSE did not become ready');

    rejectWorkletModule = true;
    if (!chain.setType(0, 'DELAY')) throw new Error('candidate should be accepted for asynchronous preparation');
    while (chain.getStatus(1).slots[0]?.pendingApply && performance.now() < deadline + 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const status = chain.getStatus(1).slots[0];
    const buffer = context.createBuffer(1, frameCount, sampleRate);
    const input = buffer.getChannelData(0);
    for (let frame = 0; frame < frameCount; frame += 1) input[frame] = 0.25 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(chain.input);
    chain.output.connect(context.destination);
    source.start();
    const rendered = await context.startRendering();
    const samples = rendered.getChannelData(0);
    const powerAt = (frequency: number, start: number, end: number) => {
      const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
      let previous = 0;
      let beforePrevious = 0;
      for (let frame = start; frame < end; frame += 1) {
        const current = coefficient * previous - beforePrevious + samples[frame]!;
        beforePrevious = previous;
        previous = current;
      }
      return Math.max(0, previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious);
    };
    const measurement = {
      status: { type: status?.type, active: status?.active, state: status?.state, pendingApply: status?.pendingApply, warning: status?.warning },
      shifted: powerAt(440, 13_440, 43_200),
      sourceTone: powerAt(220, 13_440, 43_200),
      finite: [...samples].every(Number.isFinite),
    };
    chain.dispose();
    return measurement;
  });

  expect(result.status).toMatchObject({ type: 'TRANSPOSE', active: true, state: 'ready', pendingApply: false });
  expect(result.status.warning).toContain('FX replacement failed; kept existing TRANSPOSE');
  expect(result.finite).toBe(true);
  expect(result.shifted).toBeGreaterThan(result.sourceTone * 8);
});
