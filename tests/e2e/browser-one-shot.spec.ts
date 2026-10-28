import { expect, test } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

test('Browser one-shot renders one finite pass on five tracks with reverse, loop FX, Memory and active shared FX', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await startBrowserAudio(page);

  const result = await page.evaluate(async () => {
    const loadModule = (specifier: string) =>
      (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
    const [{ AudioEngine }, { TrackAudio }] = await Promise.all([
      loadModule('/src/audio/AudioEngine.ts'), loadModule('/src/audio/TrackAudio.ts'),
    ]);
    const engine = AudioEngine.getInstance();
    const tracks = engine.tracks as any[];
    const context = tracks[0]!.engine.context as AudioContext;
    if (tracks.length !== 5 || context.state !== 'running') throw new Error('Expected five live Browser tracks');
    const finiteSourceEnds: Promise<void>[] = [];
    const createBufferSource = context.createBufferSource.bind(context);
    context.createBufferSource = (() => {
      const source = createBufferSource();
      let resolveEnded!: () => void;
      const ended = new Promise<void>((resolve) => { resolveEnded = resolve; });
      source.addEventListener('ended', resolveEnded, { once: true });
      const start = source.start.bind(source);
      source.start = ((...args: [number?, number?, number?]) => {
        if (!source.loop) finiteSourceEnds.push(ended);
        start(...args);
      }) as typeof source.start;
      return source;
    }) as typeof context.createBufferSource;

    // Inspect post-track-FX audio rather than only model flags.
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    for (const track of tracks) track.panNode.connect(analyser);
    const render = new Float32Array(analyser.fftSize);
    const rms = () => {
      analyser.getFloatTimeDomainData(render);
      let power = 0;
      for (const sample of render) power += sample * sample;
      return Math.sqrt(power / render.length);
    };

    // Exercise one private track effect, a shared post-mix effect, and a
    // source-aware loop reader while retaining the authored effect settings.
    const browserEngine = tracks[0]!.engine as any;
    if (!browserEngine.setTrackFxType(1, 0, 'CHORUS')
      || !browserEngine.setTrackFxNamedParameters(1, 0, { chorusDelayMs: 15, chorusRateHz: 0.5, chorusDepthMs: 3, chorusVoices: 2, chorusFeedback: 0, chorusToneHz: 7_000, mix: 0.25 })
      || !browserEngine.setTrackFxActive(1, 0, true)) throw new Error('Could not activate private Track 1 CHORUS');
    browserEngine.setFxType('track', 0, 'MANUAL PAN');
    browserEngine.setFxNamedParameters('track', 0, { manualPanPosition: 0.1, mix: 1 });
    browserEngine.setFxActive('track', 0, true);
    if (!browserEngine.setLoopTransport(1, {
      mode: 'vinylFlick', beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 0.7, brakePercent: 0, vinylMixPercent: 0,
    })) throw new Error('Could not configure the source-aware loop reader');

    const buffers = tracks.map((_, index) => {
      const duration = 1 + index * 0.025;
      const buffer = context.createBuffer(1, Math.round(context.sampleRate * duration), context.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let frame = 0; frame < samples.length; frame += 1) {
        samples[frame] = 0.25 * Math.sin(2 * Math.PI * (330 + index * 90) * frame / context.sampleRate);
      }
      return buffer;
    });
    const restored = TrackAudio.restoreProjectBuffersAtomically(tracks, buffers);
    if (!restored.ok) throw new Error(restored.reason ?? 'Could not seed the five Browser loops');
    tracks.forEach((track, index) => {
      track.track.oneShot = 'ON';
      track.isReverse = index === 4;
    });

    await Promise.all(tracks.map((track) => track.play()));
    const onsetDeadline = performance.now() + 2_000;
    let renderedRms = rms();
    while (performance.now() < onsetDeadline && renderedRms < 0.01) {
      await new Promise((resolve) => window.setTimeout(resolve, 12));
      renderedRms = rms();
    }
    if (renderedRms < 0.01) throw new Error(`Five-track Browser render was silent (RMS=${renderedRms})`);

    // The actual AudioBufferSourceNode end event is the completion witness.
    await Promise.race([
      Promise.all(finiteSourceEnds),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error(`One-shot reader did not end on the audio clock: ${JSON.stringify(tracks.map((track) => ({ id: track.track.id, state: track.state, offset: track.startOffset, source: Boolean(track.sourceNode), loop: track.sourceNode?.loop, reverse: track.isReverse })))}`)), 2_500)),
    ]);
    const stateDeadline = performance.now() + 750;
    while (performance.now() < stateDeadline && tracks.some((track) => track.state !== 'STOPPED')) {
      await new Promise((resolve) => window.setTimeout(resolve, 5));
    }
    const endedStates = tracks.map((track) => track.state);
    const memory = browserEngine.captureMemoryConfiguration();
    const memoryOneShot = memory.tracks.map((track: any) => track.settings.oneShot);
    const activePrivateFx = browserEngine.getTrackFxStatus()[0]?.slots[0]?.active === true;
    const sharedFxActive = browserEngine.getSharedFxSnapshot('track')[0]?.active === true;
    const readerEnded = tracks.map((track) => track.sourceNode === null);
    analyser.disconnect();
    tracks.forEach((track) => track.stop());
    return { renderedRms, endedStates, memoryOneShot, activePrivateFx, sharedFxActive, readerEnded };
  });

  expect(result.renderedRms).toBeGreaterThan(0.01);
  expect(result.endedStates).toEqual(Array(5).fill('STOPPED'));
  expect(result.memoryOneShot).toEqual(Array(5).fill('ON'));
  expect(result.activePrivateFx).toBe(true);
  expect(result.sharedFxActive).toBe(true);
  expect(result.readerEnded).toEqual(Array(5).fill(true));
});
