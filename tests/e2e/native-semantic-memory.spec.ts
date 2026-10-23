import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

const simulationHost = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;
test.skip(!simulationHost, 'Set NATIVE_BRIDGE_SIMULATION_EXECUTABLE to the explicit no-hardware Native simulation target.');

test('Native semantic Memory atomically publishes five PCM loops, seven FX banks and dual gates without UI replay', async ({ page }) => {
  if (!simulationHost) return;
  let host: ChildProcess | undefined;
  let startError: Error | undefined;
  const stderr: string[] = [];
  const pageErrors: string[] = [];
  let fxWrites = 0;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/v1\/(native-fx|native-track-fx|native-pitch)\//.test(request.url())) fxWrites++;
  });
  try {
    host = spawn(simulationHost, [], { env: { ...process.env, WEBRC_NATIVE_BRIDGE_PORT: '18755' }, stdio: ['ignore', 'ignore', 'pipe'] });
    host.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    host.once('error', (error) => { startError = error; });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startError) throw startError;
      if (host.exitCode !== null) throw new Error(`Native simulation host exited: ${host.exitCode}`);
      try {
        const response = await fetch('http://127.0.0.1:18755/health');
        ready = response.ok && (await response.json()).ok === true;
        if (ready) break;
      } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    expect(ready).toBe(true);
    await page.goto('/?audio=native');
    await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });
    const result = await page.evaluate(async () => {
      const load = (path: string) => (new Function('path', 'return import(path)') as (path: string) => Promise<any>)(path);
      const [{ AudioEngine }, { encodeProjectArchive }] = await Promise.all([
        load('/src/audio/AudioEngine.ts'), load('/src/audio/projectArchive.ts'),
      ]);
      const facade = AudioEngine.getInstance();
      if (facade.getMode() !== 'native') throw new Error('Expected the real app Native backend.');
      const engine = facade.nativeEngine;
      const runtime = engine.createRc505MemoryRuntime();
      const deadline = performance.now() + 5_000;
      while (!runtime.canSwitch().allowed) {
        if (performance.now() > deadline) throw new Error(runtime.canSwitch().reason);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const originalFetch = window.fetch.bind(window);
      const readStatus = () => originalFetch('http://127.0.0.1:18755/v1/status').then((response) => response.json());
      const hash = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (value) => value.toString(16).padStart(2, '0')).join('');
      let generation = 0;
      const timeline: string[] = [];
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await originalFetch(input, init);
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes('/v1/project/import?') && response.ok) generation = (await response.clone().json()).generation;
        if (url.includes('/v1/project/import/status?') && response.ok && (await response.clone().json()).state === 'committed') timeline.push('host-committed');
        return response;
      };
      try {
        const document = await runtime.capture();
        const baseline = await readStatus();
        const expectedHashes: string[] = [];
        const frameCounts = Array.from({ length: 5 }, (_, index) => 2048 + index * 31);
        const tracks = [];
        for (let index = 0; index < 5; index++) {
          const frameCount = frameCounts[index]!;
          const pcm = new Float32Array(frameCount * 2);
          for (let frame = 0; frame < frameCount; frame++) {
            pcm[frame * 2] = Math.fround(Math.sin((frame + 1) * .0173) * (index + 1) / 20);
            pcm[frame * 2 + 1] = Math.fround(Math.cos((frame + 1) * .0231) * -(index + 1) / 20);
          }
          expectedHashes.push(await hash(pcm.buffer));
          tracks.push({ pcm, sampleRate: baseline.sampleRate, channels: 2, frameCount });
        }
        document.archive = await encodeProjectArchive({ name: 'Native PCM E2E', bpm: document.semantics.tempo, tracks });
        document.memoryNumber = 1; document.name = 'NATIVE E2E';
        const saved = document.extensions.WEBRC.nativeMemory;
        saved.banks = Array.from({ length: 7 }, () => Array.from({ length: 4 }, (_, index) => ({
          effectId: index === 0 ? 'fractional_delay' : '', parameters: {}, bypassed: false,
        })));
        saved.trackFxApply = [false, true, false, true, false];
        saved.mixerLevels = [80, 90, 31, 42, 53, 64, 75];
        const synchronizeFields = (candidate: any) => {
          const settings = candidate.extensions.WEBRC.nativeMemory, fields = candidate.semantics.fields;
          for (let index = 0; index < 5; index++) {
            fields[`track.${index + 1}.fxApply`].value = settings.trackFxApply[index];
            fields[`track.${index + 1}.level`].value = settings.mixerLevels[index + 2];
          }
          fields['mixer.mainLevel'].value = settings.mixerLevels[0];
          fields['mixer.masterLevel'].value = settings.mixerLevels[1];
          fields['inputFx.bank'].value = structuredClone(settings.banks[0]);
          fields['trackFx.banks'].value = structuredClone(settings.banks.slice(1));
        };
        synchronizeFields(document);
        const first = await runtime.prepare(document, runtime.revision());
        const staged = await originalFetch(`http://127.0.0.1:18755/v1/project/import/status?generation=${generation}`).then((response) => response.json());
        const during = await readStatus();
        await first.dispose();
        const cancelled = await readStatus();
        const candidate = await runtime.prepare(document, runtime.revision());
        await candidate.commit(); timeline.push('application-resolved'); await candidate.dispose();
        const installed = await readStatus();
        const actualHashes = [];
        for (let trackId = 1; trackId <= 5; trackId++) {
          const response = await originalFetch(`http://127.0.0.1:18755/v1/export/loop-snapshot?trackId=${trackId}`);
          if (!response.ok) throw new Error(`Native PCM snapshot ${trackId}: HTTP ${response.status}`);
          actualHashes.push(await hash(await response.arrayBuffer()));
        }
        const banks = [installed.nativeFx.inputCatalogSlots, installed.nativeFx.catalogSlots,
          ...installed.nativeFx.perTrackCatalogBanks.map((bank: any) => bank.slots)];
        const malformed = structuredClone(document);
        malformed.extensions.WEBRC.nativeMemory.banks[6][3].effectId = 'missing_memory_effect';
        synchronizeFields(malformed);
        let failure = '';
        try { const rejected = await runtime.prepare(malformed, runtime.revision()); await rejected.dispose(); }
        catch (error) { failure = error instanceof Error ? error.message : String(error); }
        const retained = await readStatus();
        const settingsSignature = (status: any) => JSON.stringify({ levels: status.mixerLevels,
          banks: [status.nativeFx.inputCatalogSlots, status.nativeFx.catalogSlots, ...status.nativeFx.perTrackCatalogBanks.map((bank: any) => bank.slots)]
            .map((bank: any[]) => bank.map(({ effectId, parameters, bypassed, requestedRevision, appliedRevision }) => ({ effectId, parameters, bypassed, requestedRevision, appliedRevision }))),
          gates: status.nativeFx.trackFxApply.map(({ requested, applied, requestedRevision, appliedRevision }: any) => ({ requested, applied, requestedRevision, appliedRevision })),
        });
        const retainedHashes = [];
        for (let trackId = 1; trackId <= 5; trackId++) {
          const response = await originalFetch(`http://127.0.0.1:18755/v1/export/loop-snapshot?trackId=${trackId}`);
          if (!response.ok) throw new Error(`Retained PCM snapshot ${trackId}: HTTP ${response.status}`);
          retainedHashes.push(await hash(await response.arrayBuffer()));
        }
        return {
          stagedState: staged.state,
          preparationUntouched: during.projectContentRevision === baseline.projectContentRevision && during.nativeTracks.every((track: any) => track.state === 'Empty'),
          cancellationUntouched: cancelled.projectContentRevision === baseline.projectContentRevision,
          committedBeforeResolve: timeline.indexOf('host-committed') >= 0 && timeline.indexOf('host-committed') < timeline.indexOf('application-resolved'),
          expectedHashes, actualHashes, retainedHashes,
          states: installed.nativeTracks.map((track: any) => track.state),
          banks: banks.map((bank: any[]) => bank.map((slot: any) => ({ effectId: slot.effectId, ack: slot.requestedRevision === slot.appliedRevision && slot.bypassed === slot.appliedBypassed, prepared: slot.prepared }))),
          levels: installed.mixerLevels,
          gates: facade.getTrackFxApply().map((gate: any) => ({ applied: gate.applied, pending: gate.pending, inputRevision: gate.inputAppliedRevision, trackRevision: gate.trackAppliedRevision })),
          failure, failureRetained: retained.projectContentRevision === installed.projectContentRevision && settingsSignature(retained) === settingsSignature(installed),
        };
      } finally { window.fetch = originalFetch; }
    });
    expect(result.stagedState).toBe('prepared');
    expect(result.preparationUntouched).toBe(true); expect(result.cancellationUntouched).toBe(true);
    expect(result.committedBeforeResolve).toBe(true);
    expect(result.actualHashes).toEqual(result.expectedHashes); expect(result.retainedHashes).toEqual(result.expectedHashes);
    expect(result.states).toEqual(Array(5).fill('Stopped'));
    expect(result.banks).toHaveLength(7);
    for (const bank of result.banks) {
      expect(bank[0]).toEqual({ effectId: 'fractional_delay', ack: true, prepared: true });
      expect(bank.slice(1).every((slot) => !slot.effectId && slot.ack)).toBe(true);
    }
    expect(result.levels).toEqual([80, 90, 31, 42, 53, 64, 75]);
    expect(result.gates.map((gate) => gate.applied)).toEqual([false, true, false, true, false]);
    expect(result.gates.every((gate) => !gate.pending && gate.inputRevision === gate.trackRevision)).toBe(true);
    expect(result.failure).toMatch(/effect|catalog|unsupported|unknown/i); expect(result.failureRetained).toBe(true);
    const writesBeforeHydration = fxWrites;
    const hydrated = await page.evaluate(async () => {
      const load = (path: string) => (new Function('path', 'return import(path)') as (path: string) => Promise<any>)(path);
      const module = await load('/src/composables/useFxPanelState.ts');
      await module.adoptCommittedNativeFxState();
      const { useNativeTrackFxState } = await load('/src/composables/useNativeTrackFxState.ts');
      const privateUi = useNativeTrackFxState();
      const privateRows = [1, 2, 3, 4, 5].map((trackId) => {
        privateUi.selectTarget(trackId);
        return { type: privateUi.slots.value[0].type, active: privateUi.slots.value[0].active };
      });
      return { shared: ['input', 'track'].map((path) => ({ type: module.useFxPanelState(path).slots.value[0].type,
        active: module.useFxPanelState(path).slots.value[0].active })), privateRows };
    });
    expect(hydrated.shared).toEqual([{ type: 'DELAY', active: true }, { type: 'DELAY', active: true }]);
    expect(hydrated.privateRows).toEqual(Array(5).fill({ type: 'DELAY', active: true }));
    await expect(page.getByTestId('input-fx-slot-a')).toHaveAttribute('data-fx-enabled', 'true');
    await expect(page.getByTestId('track-fx-slot-a')).toHaveAttribute('data-fx-enabled', 'true');
    expect(fxWrites).toBe(writesBeforeHydration);
    expect(pageErrors).toEqual([]); expect(host.exitCode).toBeNull();
  } catch (error) {
    await test.info().attach('native-semantic-memory-diagnostics.json', { body: JSON.stringify({ stderr, pageErrors }, null, 2), contentType: 'application/json' });
    throw error;
  } finally {
    if (host && host.exitCode === null) {
      host.kill('SIGTERM');
      await new Promise<void>((resolve) => { host?.once('exit', () => resolve()); setTimeout(resolve, 2_000); });
    }
  }
});
