import { expect, test } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

test('Browser Bounce captures a finite stereo one-shot while the destination recording continues after its source ends', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);

  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    const audio = AudioEngine.getInstance();
    const browser = (audio as any).browser;
    const context = browser.context as AudioContext;
    const [destination, source] = audio.tracks as any[];
    if (context.state !== 'running') throw new Error('Browser AudioContext is not running');

    const silenceDestination = context.createMediaStreamDestination();
    const silenceGain = context.createGain();
    silenceGain.gain.value = 0;
    const silenceSource = new OscillatorNode(context, { frequency: 73 });
    silenceSource.connect(silenceGain).connect(silenceDestination);
    silenceSource.start();

    const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 4_000) => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => window.setTimeout(resolve, 8));
      }
      throw new Error(`Timed out waiting for ${label}`);
    };

    try {
      await browser.replaceInputStream(silenceDestination.stream);
      await audio.setRecordPlaySettings({ recAction: 'REC->PLAY', quantize: 'OFF' });
      source.track.loopSyncSw = 'OFF';
      destination.track.loopSyncSw = 'OFF';
      source.track.oneShot = 'ON';

      const sourceBuffer = context.createBuffer(2, Math.round(context.sampleRate * 0.24), context.sampleRate);
      const left = sourceBuffer.getChannelData(0);
      const right = sourceBuffer.getChannelData(1);
      for (let frame = 0; frame < sourceBuffer.length; frame += 1) {
        left[frame] = 0.22 * Math.sin(2 * Math.PI * 440 * frame / context.sampleRate);
        right[frame] = 0.34 * Math.sin(2 * Math.PI * 733 * frame / context.sampleRate);
      }
      source.audioBuffer = sourceBuffer;
      audio.setBrowserBounceSettings({
        bounceSw: true,
        bounceIn: [true, false, false, false, false],
        bounceTrack: [false, true, false, false, false],
      });

      await destination.startRecording();
      if (destination.state !== 'RECORDING' || !destination.recordingCaptureSession) {
        throw new Error(`Destination capture was not active: state=${destination.state}`);
      }
      await source.play();
      await waitFor(() => source.state === 'STOPPED', 'the finite one-shot source to end');

      // A stopped source must not stop or prematurely finalize the destination's
      // independent shared capture session; it should keep recording silence.
      await new Promise((resolve) => window.setTimeout(resolve, 140));
      const sourceStopped = source.state === 'STOPPED';
      const destinationStillRecording = destination.state === 'RECORDING'
        && destination.recordingCaptureSession !== null
        && destination.recordingFramesCaptured > Math.round(context.sampleRate * 0.30);
      const framesAfterSourceEnd = destination.recordingFramesCaptured;
      if (!destinationStillRecording) {
        throw new Error(`Destination did not remain recording after one-shot ended: state=${destination.state}, frames=${framesAfterSourceEnd}`);
      }

      await destination.stopRecording();
      await waitFor(() => !destination.isFinalizingRecording && destination.audioBuffer !== null, 'destination PCM finalization');
      const captured = destination.audioBuffer as AudioBuffer;
      const channels = Array.from({ length: captured.numberOfChannels }, (_, channel) => {
        const samples = captured.getChannelData(channel);
        let sumSquares = 0;
        let activeFrames = 0;
        const activeThreshold = 0.025;
        for (const sample of samples) {
          sumSquares += sample * sample;
          if (Math.abs(sample) > activeThreshold) activeFrames += 1;
        }
        const tailStart = Math.floor(samples.length * 0.75);
        let tailSquares = 0;
        for (let frame = tailStart; frame < samples.length; frame += 1) tailSquares += samples[frame]! * samples[frame]!;
        return {
          length: samples.length,
          rms: Math.sqrt(sumSquares / Math.max(1, samples.length)),
          activeFrames,
          tailRms: Math.sqrt(tailSquares / Math.max(1, samples.length - tailStart)),
        };
      });
      return {
        sourceStopped,
        destinationStillRecording,
        framesAfterSourceEnd,
        finalState: destination.state,
        channels,
        sourceFrames: sourceBuffer.length,
      };
    } finally {
      if (destination.recordingCaptureSession || destination.isRecording) await destination.stopRecording().catch(() => undefined);
      source.stop();
      silenceSource.stop();
      browser.setMonitoring(false);
      audio.setBrowserBounceSettings({ bounceSw: false,
        bounceIn: [false, false, false, false, false], bounceTrack: [false, false, false, false, false] });
      destination.stop();
      source.stop();
    }
  });

  expect(result.sourceStopped).toBe(true);
  expect(result.destinationStillRecording).toBe(true);
  expect(result.framesAfterSourceEnd).toBeGreaterThan(result.sourceFrames);
  expect(result.finalState).toBe('PLAYING');
  expect(result.channels).toHaveLength(2);
  expect(result.channels[0]!.activeFrames).toBeGreaterThan(100);
  expect(result.channels[1]!.activeFrames).toBeGreaterThan(100);
  expect(result.channels[0]!.rms).toBeGreaterThan(0.015);
  expect(result.channels[1]!.rms).toBeGreaterThan(0.02);
  expect(result.channels[0]!.tailRms).toBeLessThan(0.01);
  expect(result.channels[1]!.tailRms).toBeLessThan(0.01);
});
