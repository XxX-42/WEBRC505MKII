import { expect, test } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

test('real Browser Memory stages FX and jointly acknowledged gates before replacing five PCM loops', async ({ page }) => {
  await page.goto('/?audio=browser');
  await startBrowserAudio(page);
  const result = await page.evaluate(async () => {
    const load = (path: string) => (new Function('path', 'return import(path)') as (path: string) => Promise<any>)(path);
    const { AudioEngine } = await load('/src/audio/AudioEngine.ts');
    const { TrackAudio } = await load('/src/audio/TrackAudio.ts');
    const facade = AudioEngine.getInstance();
    const engine = facade.tracks[0].engine;
    const runtime = engine.createRc505MemoryRuntime();
    const tracks = engine.tracks.slice();
    const seed = (base: number) => {
      const buffers = tracks.map((_: unknown, index: number) => {
        const buffer = engine.context.createBuffer(2, 4096 + index, engine.context.sampleRate);
        buffer.getChannelData(0).fill(base + index / 10); buffer.getChannelData(1).fill(-base - index / 10); return buffer;
      });
      const result = TrackAudio.restoreProjectBuffersAtomically(tracks, buffers);
      if (!result.ok) throw new Error(result.reason);
    };
    seed(0.1);
    engine.tracks[0].track.playLevel = 73;
    engine.setFxType('input', 0, 'FILTER'); engine.setFxNamedParameters('input', 0, { frequency: 0.4, resonance: 0.2 }); engine.setFxActive('input', 0, true);
    engine.setTrackFxType(2, 0, 'DSP LPF'); engine.setTrackFxNamedParameters(2, 0, { cutoffHz: 700, q: 0.8, mix: 0.75 }); engine.setTrackFxActive(2, 0, true);
    const deadline = performance.now() + 12000;
    while (!runtime.canSwitch().allowed) {
      if (performance.now() > deadline) throw new Error(runtime.canSwitch().reason);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await engine.setTrackFxApply(1, false);
    const document = await runtime.capture();
    const savedFx = JSON.stringify(engine.captureMemoryConfiguration().fx);
    await engine.setTrackFxApply(1, true);
    seed(0.7); engine.tracks[0].track.playLevel = 18;
    const before = runtime.revision();
    const prepared = await runtime.prepare(document, before);
    const preparationUntouched = runtime.revision() === before && engine.getTrackFxApply(1)[0].applied === true
      && tracks[0].getProjectPcmSnapshot().channelData[0][0] === Math.fround(0.7);
    await prepared.commit(); await prepared.dispose();
    return {
      preparationUntouched,
      identitiesRetained: tracks.every((track: unknown, index: number) => engine.tracks[index] === track),
      pcm: tracks.map((track: any) => track.getProjectPcmSnapshot().channelData[0][0]),
      level: tracks[0].track.playLevel,
      gate: engine.getTrackFxApply(1)[0],
      fxEqual: JSON.stringify(engine.captureMemoryConfiguration().fx) === savedFx,
      noOldUndo: tracks.every((track: any) => !track.canUndo && !track.canRedo),
      contextState: engine.context.state,
    };
  });
  expect(result.preparationUntouched).toBe(true);
  expect(result.identitiesRetained).toBe(true);
  expect(result.pcm).toEqual([0.1, 0.2, 0.3, 0.4, 0.5].map(Math.fround));
  expect(result.level).toBe(73); expect(result.gate.applied).toBe(false);
  expect(result.gate.inputAppliedRevision).toBe(result.gate.trackAppliedRevision);
  expect(result.gate.pending).toBe(false); expect(result.fxEqual).toBe(true); expect(result.noOldUndo).toBe(true);
  expect(result.contextState).toBe('running');
});
