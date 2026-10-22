import { expect, test } from '@playwright/test';

test('routes HRM AUTO MIDI to one exact private Browser track slot in running audio', async ({ page }) => {
  await page.goto('/?audio=browser');
  const result = await page.evaluate(async () => {
    const sampleRate = 48_000;
    const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    await context.resume();
    const { BrowserTrackFxChain } = await import('/src/audio/BrowserTrackFxChain.ts');
    const { BrowserAudioEngine } = await import('/src/audio/BrowserAudioEngine.ts');
    const ensureModule = () => context.audioWorklet.addModule('/worklets/fx-processor.js');
    const chains = Array.from({ length: 5 }, () => new BrowserTrackFxChain(context, ensureModule));
    const target = chains[1]!;
    const sibling = chains[2]!;
    const slotIndex = 1; // Track 2, slot B
    if (!target.setType(slotIndex, 'HRM AUTO (M)') || !sibling.setType(slotIndex, 'HRM AUTO (M)')) {
      throw new Error('private HRM AUTO adapter was rejected');
    }

    const readyDeadline = performance.now() + 20_000;
    const waitReady = async (chain: InstanceType<typeof BrowserTrackFxChain>, trackId: number) => {
      while (chain.getStatus(trackId).slots[slotIndex]?.pendingApply && performance.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const status = chain.getStatus(trackId).slots[slotIndex];
      if (status?.state !== 'ready' || status.type !== 'HRM AUTO (M)') {
        throw new Error(`Track ${trackId} private HRM AUTO did not become ready: ${status?.error ?? status?.state}`);
      }
      if (!chain.setNamedParameters(slotIndex, { key: 0, scale: 0, 'midi-channel': 1, mix: 100 })) {
        throw new Error(`Track ${trackId} HRM AUTO parameters were rejected`);
      }
      if (!chain.setActive(slotIndex, true)) throw new Error(`Track ${trackId} HRM AUTO could not be activated`);
    };
    await Promise.all([waitReady(target, 2), waitReady(sibling, 3)]);

    const targetAnalyser = context.createAnalyser();
    const siblingAnalyser = context.createAnalyser();
    for (const analyser of [targetAnalyser, siblingAnalyser]) {
      analyser.fftSize = 32_768;
      analyser.smoothingTimeConstant = 0;
    }
    const mute = context.createGain();
    mute.gain.value = 0;
    target.output.connect(targetAnalyser);
    sibling.output.connect(siblingAnalyser);
    targetAnalyser.connect(mute);
    siblingAnalyser.connect(mute);
    mute.connect(context.destination);

    const sources: OscillatorNode[] = [];
    const addHarmonicSignal = (input: AudioNode) => {
      for (let harmonic = 1; harmonic <= 8; harmonic += 1) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = 220 * harmonic;
        gain.gain.value = 0.14 / harmonic ** 1.35;
        oscillator.connect(gain);
        gain.connect(input);
        oscillator.start();
        sources.push(oscillator);
      }
    };
    addHarmonicSignal(target.input);
    addHarmonicSignal(sibling.input);

    const peakNear = (analyser: AnalyserNode, frequency: number) => {
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(spectrum);
      const binHz = context.sampleRate / analyser.fftSize;
      const center = Math.round(frequency / binHz);
      const radius = Math.max(2, Math.ceil(frequency * 0.035 / binHz));
      let peakBin = center;
      let peakDb = Number.NEGATIVE_INFINITY;
      for (let bin = Math.max(1, center - radius); bin <= Math.min(spectrum.length - 1, center + radius); bin += 1) {
        if ((spectrum[bin] ?? Number.NEGATIVE_INFINITY) > peakDb) {
          peakBin = bin;
          peakDb = spectrum[bin] ?? Number.NEGATIVE_INFINITY;
        }
      }
      return { hz: peakBin * binHz, db: peakDb };
    };
    const waitAudio = async (seconds: number) => {
      const audioDeadline = context.currentTime + seconds;
      const wallDeadline = performance.now() + 8_000;
      while (context.currentTime < audioDeadline && performance.now() < wallDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return context.currentTime;
    };

    const baselineStart = context.currentTime;
    const baselineEnd = await waitAudio(1.25);
    const beforeMidi = {
      target220: peakNear(targetAnalyser, 220),
      sibling220: peakNear(siblingAnalyser, 220),
      sibling165: peakNear(siblingAnalyser, 164.81),
      sibling196: peakNear(siblingAnalyser, 196),
    };

    const engine = Object.create(BrowserAudioEngine.prototype) as InstanceType<typeof BrowserAudioEngine>;
    const midiInput = { connect: async () => 'connected', disconnect: () => {}, releaseHeldNotes: () => {} };
    Object.assign(engine, {
      context,
      perTrackFxChains: chains,
      inputFxInstances: [null, null, null, null],
      trackFxInstances: [null, null, null, null],
      midiInput,
      midiRoutingMode: 'legacy-broadcast',
      selectedHrmAutoMidiTarget: null,
      selectedTrackMidiTarget: null,
      lastError: '',
      statusListeners: new Set(),
    });
    const midiState = await engine.connectMidiInput({ path: 'track', trackId: 2, slot: 'B', effectId: 'hrm_auto_m' });
    const targetEffect = (target as unknown as {
      slots: Array<{ effect: { analyzerNode: AudioWorkletNode | null } | null }>;
    }).slots[slotIndex]!.effect!;
    const targetWorklet = targetEffect.analyzerNode;
    const siblingEffect = (sibling as unknown as {
      slots: Array<{ effect: { analyzerNode: AudioWorkletNode | null } | null }>;
    }).slots[slotIndex]!.effect!;
    const siblingWorklet = siblingEffect.analyzerNode;
    if (!targetWorklet || !siblingWorklet) throw new Error('HRM AUTO analyzer Worklet was not installed');

    const targetStatePromise = new Promise<{ frame: number; activeNoteCount: number; voiceCount: number; target1: number; target2: number }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        targetWorklet.port.removeEventListener('message', onMessage);
        reject(new Error('Track 2 slot B did not emit an active HRM AUTO target event'));
      }, 10_000);
      const onMessage = (event: MessageEvent<unknown>) => {
        const message = event.data as { type?: string; frame?: number; activeNoteCount?: number; voiceCount?: number; target1?: number; target2?: number } | null;
        if (message?.type !== 'hrm-auto-target' || message.activeNoteCount !== 1 || message.voiceCount !== 2) return;
        clearTimeout(timeout);
        targetWorklet.port.removeEventListener('message', onMessage);
        resolve({
          frame: message.frame ?? -1,
          activeNoteCount: message.activeNoteCount,
          voiceCount: message.voiceCount,
          target1: message.target1 ?? -128,
          target2: message.target2 ?? -128,
        });
      };
      targetWorklet.port.addEventListener('message', onMessage);
    });

    const midiSentAtFrame = Math.ceil((context.currentTime + 0.02) * context.sampleRate);
    (engine as unknown as { handleMidiNote(event: { channel: number; note: number; velocity: number; noteOn: boolean; timeStampMs: number }): void })
      .handleMidiNote({ channel: 1, note: 60, velocity: 1, noteOn: true, timeStampMs: performance.now() });
    const targetState = await targetStatePromise;
    const afterMidi = await waitAudio(1.7);
    const after = {
      target220: peakNear(targetAnalyser, 220),
      target165: peakNear(targetAnalyser, 164.81),
      target196: peakNear(targetAnalyser, 196),
      sibling220: peakNear(siblingAnalyser, 220),
      sibling165: peakNear(siblingAnalyser, 164.81),
      sibling196: peakNear(siblingAnalyser, 196),
    };
    const status = target.getStatus(2).slots[slotIndex];
    const targetVoiceCount = (targetEffect as unknown as { activeMidiVoiceCount: number }).activeMidiVoiceCount;
    const siblingVoiceCount = (siblingEffect as unknown as { activeMidiVoiceCount: number }).activeMidiVoiceCount;
    const result = {
      contextState: context.state,
      sampleRate: context.sampleRate,
      midiState,
      slotState: status?.state,
      slotType: status?.type,
      slotActive: status?.active,
      resourceNote: status?.resourceNote,
      audioElapsed: baselineEnd - baselineStart,
      afterMidiAudioElapsed: afterMidi - baselineEnd,
      midiSentAtFrame,
      targetState,
      targetVoiceCount,
      siblingVoiceCount,
      beforeMidi,
      after,
      error: (engine as unknown as { lastError: string }).lastError,
    };

    engine.disconnectMidiInput();
    sources.forEach((source) => source.stop());
    chains.forEach((chain) => chain.dispose());
    await context.close();
    return result;
  });

  console.log('HRM AUTO private audio measurement', JSON.stringify(result));
  expect(result.contextState).toBe('running');
  expect(result.sampleRate).toBe(48_000);
  expect(result.midiState).toBe('connected');
  expect(result.slotState).toBe('ready');
  expect(result.slotType).toBe('HRM AUTO (M)');
  expect(result.slotActive).toBe(true);
  expect(result.resourceNote).toContain('128 MiB per AudioContext');
  expect(result.resourceNote).toContain('5 MiB / 128 MiB');
  expect(result.resourceNote).toContain('4 LIVE_FX');
  expect(result.audioElapsed).toBeGreaterThanOrEqual(1.25);
  expect(result.afterMidiAudioElapsed).toBeGreaterThanOrEqual(1.7);
  expect(result.targetState.activeNoteCount).toBe(1);
  expect(result.targetState.voiceCount).toBe(2);
  expect(result.targetVoiceCount).toBe(2);
  expect(result.siblingVoiceCount).toBe(0);
  expect(result.targetState.frame).toBeGreaterThanOrEqual(result.midiSentAtFrame);
  expect(result.targetState.target1).toBeGreaterThan(-6.5);
  expect(result.targetState.target1).toBeLessThan(-3.5);
  expect(result.targetState.target2).toBeGreaterThan(-3.5);
  expect(result.targetState.target2).toBeLessThan(-0.5);
  expect(result.beforeMidi.target220.db).toBeGreaterThan(-40);
  expect(result.beforeMidi.sibling220.db).toBeGreaterThan(-40);
  expect(result.after.target165.hz).toBeGreaterThan(157);
  expect(result.after.target165.hz).toBeLessThan(173);
  expect(result.after.target196.hz).toBeGreaterThan(187);
  expect(result.after.target196.hz).toBeLessThan(205);
  expect(result.after.target165.db).toBeGreaterThan(-48);
  expect(result.after.target196.db).toBeGreaterThan(-48);
  expect(result.after.target220.db).toBeLessThan(result.beforeMidi.target220.db - 8);
  expect(Math.abs(result.after.sibling220.db - result.beforeMidi.sibling220.db)).toBeLessThan(4);
  expect(result.beforeMidi.sibling165.db).toBeLessThan(-50);
  expect(result.beforeMidi.sibling196.db).toBeLessThan(-50);
  expect(result.after.sibling165.db).toBeLessThan(-50);
  expect(result.after.sibling196.db).toBeLessThan(-50);
  expect(result.error).toBe('');
});
