import { expect, test } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

test('REPLACE2 mutes only the Browser loop reader while a real stereo Bounce/input render replaces PCM', async ({ page }) => {
  await page.goto('/?audio=browser');
  await startBrowserAudio(page);

  const result = await page.evaluate(async () => {
    const loadModule = (specifier: string) =>
      (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
    const [{ AudioEngine }, { DubMode }] = await Promise.all([
      loadModule('/src/audio/AudioEngine.ts'),
      loadModule('/src/core/types.ts'),
    ]);
    const appRoot = document.querySelector('.app-root') as (HTMLElement & { __vueParentComponent?: any }) | null;
    const engine = appRoot?.__vueParentComponent?.setupState?.engine ?? AudioEngine.getInstance();
    const [destinationTrack, bounceTrack] = engine.tracks as Array<any>;
    const browserEngine = (AudioEngine.getInstance() as any).browser;
    const context = browserEngine.context as AudioContext;
    if (engine.getMode() !== 'browser' || context.state !== 'running') {
      throw new Error(`Expected the running Browser AudioContext; mode=${engine.getMode()} state=${context.state}`);
    }
    const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
    const peakRms = async (meter: { rms(): number }, samples = 8) => {
      let peak = 0;
      for (let index = 0; index < samples; index += 1) {
        peak = Math.max(peak, meter.rms());
        await sleep(10);
      }
      return peak;
    };
    const waitFor = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(10);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const makeReaderMeter = (bus: AudioNode) => {
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      const quietSink = context.createGain();
      quietSink.gain.value = 0;
      bus.connect(analyser);
      analyser.connect(quietSink);
      quietSink.connect(context.destination);
      const data = new Float32Array(analyser.fftSize);
      return {
        rms() {
          analyser.getFloatTimeDomainData(data);
          return Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
        },
        dispose() { try { bus.disconnect(analyser); } catch {} analyser.disconnect(); quietSink.disconnect(); },
      };
    };
    const makeConstantLoop = (leftValue: number, rightValue: number) => {
      const buffer = context.createBuffer(2, context.sampleRate, context.sampleRate);
      buffer.getChannelData(0).fill(leftValue);
      buffer.getChannelData(1).fill(rightValue);
      return buffer;
    };
    const original = {
      getProcessedInputNode: browserEngine.getProcessedInputNode,
      getInputCaptureRequestFrame: browserEngine.getInputCaptureRequestFrame,
      beginInputCaptureSession: browserEngine.beginInputCaptureSession,
    };
    const meters: Array<{ dispose(): void }> = [];
    let inputSource: AudioBufferSourceNode | null = null;
    let bounceMix: { node: GainNode; dispose(): void } | null = null;
    try {
      // Supply a real nonzero stereo source directly to the production overdub
      // Worklet and bypass shared-tap backfill, whose timing is unrelated here.
      const inputBuffer = makeConstantLoop(0.05, -0.07);
      inputSource = context.createBufferSource();
      inputSource.buffer = inputBuffer;
      inputSource.loop = true;
      const inputMeter = makeReaderMeter(inputSource);
      meters.push(inputMeter);
      inputSource.connect(browserEngine.inputFxChain.input);
      browserEngine.setMonitoring(true);
      const monitorMeter = makeReaderMeter(browserEngine.monitorGainNode);
      meters.push(monitorMeter);
      browserEngine.getInputCaptureRequestFrame = undefined;
      browserEngine.beginInputCaptureSession = undefined;
      browserEngine.getProcessedInputNode = async () => inputSource;

      (destinationTrack as any).audioBuffer = makeConstantLoop(0.30, -0.40);
      destinationTrack.track.dubMode = DubMode.REPLACE2;
      (bounceTrack as any).audioBuffer = makeConstantLoop(0.10, 0.20);
      browserEngine.setBrowserBounceSettings({
        bounceSw: true,
        bounceIn: [true, false, false, false, false],
        bounceTrack: [false, true, false, false, false],
      });
      bounceMix = browserEngine.createBrowserBounceSourceMix(2, 0b00001);
      if (!bounceMix) throw new Error("Could not construct the destination loop's real Bounce source tap.");
      const bounceMeter = makeReaderMeter(bounceMix.node);
      meters.push(bounceMeter);
      const readerMeter = makeReaderMeter(destinationTrack.playbackSourceOutput);
      meters.push(readerMeter);
      await bounceTrack.play();
      await destinationTrack.play();
      await sleep(60);

      const audibleBefore = readerMeter.rms();
      if (audibleBefore < 0.02) throw new Error(`Destination loop was not rendering before REPLACE2: bus=${audibleBefore}, context=${context.state}, state=${destinationTrack.state}, source=${Boolean(destinationTrack.sourceNode)}, gate=${destinationTrack.loopReaderGateGain?.gain?.value}, readerBus=${destinationTrack.playbackSourceOutput.gain.value}, samples=${destinationTrack.audioBuffer.getChannelData(0)[0]}`);

      const otherTrackBounceBefore = bounceMeter.rms();
      if (otherTrackBounceBefore < 0.01) throw new Error(`Selected Bounce source was not rendering: RMS=${otherTrackBounceBefore}`);

      inputSource.start(context.currentTime + 0.12);
      destinationTrack.triggerRecord();
      await waitFor(() => Boolean(destinationTrack.overdubProcessor), 'the production overdub Worklet');
      await waitFor(() => destinationTrack.overdubHasEdited === true, 'the first acknowledged replacement PCM patch');
      await sleep(80);

      const mutedReader = readerMeter.rms();
      const mutedBounceTap = bounceMeter.rms();
      const liveInput = inputMeter.rms();
      const liveMonitor = await peakRms(monitorMeter);
      const left = destinationTrack.audioBuffer.getChannelData(0);
      const right = destinationTrack.audioBuffer.getChannelData(1);
      const contains = (samples: Float32Array, expected: number) => samples.some(sample => Math.abs(sample - expected) < 0.004);
      const replacedLeft = contains(left, 0.15); // input 0.05 + Track 2 Bounce 0.10
      const replacedRight = contains(right, 0.13); // input -0.07 + Track 2 Bounce 0.20
      const retainedOldLeft = contains(left, 0.30);

      destinationTrack.triggerRecord();
      await waitFor(() => destinationTrack.overdubProcessor === null, 'the exact-stop Worklet acknowledgement');
      await sleep(40);
      const audibleAfter = readerMeter.rms();

      return {
        modes: Object.values(DubMode), audibleBefore, mutedReader, otherTrackBounceBefore, mutedBounceTap, liveInput, liveMonitor,
        replacedLeft, replacedRight, retainedOldLeft, audibleAfter,
        playFader: destinationTrack.gainNode.gain.value,
        publicReaderBusGain: destinationTrack.playbackSourceOutput.gain.value,
      };
    } finally {
      if (destinationTrack.overdubProcessor) {
        destinationTrack.triggerRecord();
        await sleep(50);
      }
      if (inputSource) { try { inputSource.stop(); } catch {} }
      if (inputSource) { try { inputSource.disconnect(engine.inputFxChain.input); } catch {} }
      browserEngine.setMonitoring(false);
      bounceMix?.dispose();
      for (const meter of meters) meter.dispose();
      destinationTrack.stop();
      bounceTrack.stop();
      browserEngine.getProcessedInputNode = original.getProcessedInputNode;
      browserEngine.getInputCaptureRequestFrame = original.getInputCaptureRequestFrame;
      browserEngine.beginInputCaptureSession = original.beginInputCaptureSession;
      browserEngine.setBrowserBounceSettings({ bounceSw: false,
        bounceIn: [false, false, false, false, false], bounceTrack: [false, false, false, false, false] });
    }
  });

  expect(result.modes).toEqual(['OVERDUB', 'REPLACE1', 'REPLACE2']);
  expect(result.audibleBefore).toBeGreaterThan(0.02);
  expect(result.mutedReader).toBeLessThan(0.005);
  expect(result.otherTrackBounceBefore).toBeGreaterThan(0.01);
  expect(result.mutedBounceTap).toBeLessThan(0.005);
  expect(result.liveMonitor).toBeGreaterThan(0.005);
  expect(result.replacedLeft).toBe(true);
  expect(result.replacedRight).toBe(true);
  expect(result.retainedOldLeft).toBe(true);
  expect(result.audibleAfter).toBeGreaterThan(0.02);
  expect(result.playFader).toBe(1);
  expect(result.publicReaderBusGain).toBe(1);
});
