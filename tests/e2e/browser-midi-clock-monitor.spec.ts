import { expect, test } from '@playwright/test';
import { startBrowserAudio } from './uiHelpers';

test('queues an early MIDI Start until stable selected-source clock evidence arrives', async ({ page }) => {
  await page.addInitScript(() => {
    const listeners = new Set<(event: { data: number[]; timeStamp: number }) => void>();
    const input = {
      name: 'Clock Master',
      addEventListener: (_type: string, listener: (event: { data: number[]; timeStamp: number }) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: { data: number[]; timeStamp: number }) => void) => listeners.delete(listener),
    };
    const access = {
      inputs: { forEach: (callback: (port: typeof input) => void) => callback(input) },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const permissionStatus = { state: 'granted', addEventListener: () => undefined, removeEventListener: () => undefined };
    Object.defineProperty(window, '__earlyMidiStart', { configurable: true, value: {
      send: (data: number[]) => listeners.forEach((listener) => listener({ data, timeStamp: performance.now() })),
    } });
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access });
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => permissionStatus } });
  });

  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);
  await page.getByRole('button', { name: 'Connect MIDI clock input' }).click();
  await page.getByTestId('midi-clock-input-select').selectOption({ label: 'Clock Master' });
  await page.getByTestId('midi-clock-sync-mode').selectOption('rhythm');

  const rhythmRunning = () => page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    return AudioEngine.getInstance().rhythmEngine.isRunning;
  });
  const send = (status: number) => page.evaluate((value) => {
    const fake = (window as unknown as { __earlyMidiStart: { send(data: number[]): void } }).__earlyMidiStart;
    fake.send([value]);
  }, status);

  await send(0xfa);
  await expect.poll(rhythmRunning).toBe(false);
  await expect(page.getByTestId('midi-clock-control-notice')).toContainText('pending stable F8 clock');
  await send(0xfc);
  await expect.poll(rhythmRunning).toBe(false);
  await expect(page.getByTestId('midi-clock-control-notice')).toHaveText('Pending MIDI Start canceled by MIDI Stop.');
  await send(0xfa);
  await expect(page.getByTestId('midi-clock-control-notice')).toContainText('pending stable F8 clock');
  await page.evaluate(async () => {
    const fake = (window as unknown as { __earlyMidiStart: { send(data: number[]): void } }).__earlyMidiStart;
    const period = 60_000 / 100 / 24;
    for (let tick = 0; tick < 16; tick += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, period));
      fake.send([0xf8]);
    }
  });
  await expect.poll(rhythmRunning).toBe(true);
  await expect(page.getByTestId('midi-clock-control-notice')).toContainText('without sample-frame alignment');
  await send(0xfc);
  await expect.poll(rhythmRunning).toBe(false);
});

test('explicit MIDI sync follows stable clock and starts/stops the Browser rhythm only when enabled', async ({ page }) => {
  await page.addInitScript(() => {
    const listeners = new Set<(event: { data: number[]; timeStamp: number }) => void>();
    const input = {
      name: 'Clock Master',
      addEventListener: (_type: string, listener: (event: { data: number[]; timeStamp: number }) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: { data: number[]; timeStamp: number }) => void) => listeners.delete(listener),
    };
    const accessListeners = new Set<() => void>();
    const access = {
      inputs: { forEach: (callback: (port: typeof input) => void) => callback(input) },
      addEventListener: (_type: string, listener: () => void) => accessListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => accessListeners.delete(listener),
    };
    const permissionStatus = { state: 'granted', addEventListener: () => undefined, removeEventListener: () => undefined };
    Object.defineProperty(window, '__midiSyncInput', { configurable: true, value: {
      send: (data: number[], timeStamp: number) => listeners.forEach((listener) => listener({ data, timeStamp })),
    } });
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access });
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => permissionStatus } });
  });
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);
  await page.getByRole('button', { name: 'Connect MIDI clock input' }).click();
  await page.getByTestId('midi-clock-input-select').selectOption({ label: 'Clock Master' });

  const sendStableClock = async (bpm: number) => {
    await page.evaluate(async (selectedBpm) => {
      const fake = (window as unknown as { __midiSyncInput: { send(data: number[], timeStamp: number): void } }).__midiSyncInput;
      const period = 60_000 / selectedBpm / 24;
      for (let tick = 0; tick < 16; tick += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, period));
        fake.send([0xf8], performance.now());
      }
    }, bpm);
    await expect(page.getByTestId('midi-clock-relative-phase')).toContainText('locked');
  };

  const rhythmRunning = () => page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    return AudioEngine.getInstance().rhythmEngine.isRunning;
  });
  const sendRealtime = (status: number) => page.evaluate((value) => {
    const fake = (window as unknown as { __midiSyncInput: { send(data: number[], timeStamp: number): void } }).__midiSyncInput;
    fake.send([value], performance.now());
  }, status);

  await sendStableClock(100);
  const bpmWhileOff = await page.evaluate(async () => {
    const { Transport } = await import('/src/core/Transport.ts');
    return Transport.getInstance().bpm;
  });
  expect(bpmWhileOff).toBe(120);
  await sendRealtime(0xfa);
  await expect.poll(rhythmRunning).toBe(false);

  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    await AudioEngine.getInstance().setRecordPlaySettings({ quantize: 'MEASURE' });
  });
  await page.getByTestId('midi-clock-sync-mode').selectOption('rhythm');
  const quantizeWhileSynced = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    return AudioEngine.getInstance().getRecordPlaySettings().quantize;
  });
  expect(quantizeWhileSynced).toBe('MEASURE');
  await sendStableClock(100);
  const followedBpm = await page.evaluate(async () => {
    const { Transport } = await import('/src/core/Transport.ts');
    return Transport.getInstance().bpm;
  });
  expect(followedBpm).toBeGreaterThan(90);
  expect(followedBpm).toBeLessThan(110);
  await sendRealtime(0xfa);
  await expect.poll(rhythmRunning).toBe(true);
  await sendRealtime(0xfc);
  await expect.poll(rhythmRunning).toBe(false);
  await sendStableClock(100);
  await sendRealtime(0xfa);
  await expect.poll(rhythmRunning).toBe(true);
  await page.getByRole('button', { name: 'Disconnect MIDI clock input' }).click();
  await expect(page.getByTestId('midi-clock-sync-mode')).toHaveValue('off');
  await expect.poll(rhythmRunning).toBe(true);
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    AudioEngine.getInstance().rhythmEngine.stop();
  });
  await page.getByTestId('midi-clock-sync-mode').selectOption('off');
  await expect.poll(async () => page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
    return AudioEngine.getInstance().getRecordPlaySettings().quantize;
  })).toBe('MEASURE');
});

test('renders the MIDI clock control only in the Tech interface', async ({ page }) => {
  await page.goto('/?audio=browser&ui=classic');
  await expect(page.getByTestId('midi-clock-status')).toHaveCount(0);
  await page.goto('/?audio=browser&ui=tech');
  await expect(page.getByTestId('midi-clock-status')).toHaveText('Clock monitor off');
});

test('explicitly connects a read-only MIDI clock monitor in the transport bar', async ({ page }) => {
  await page.addInitScript(() => {
    const makeInput = (name: string) => {
      const listeners = new Set<(event: { data: number[]; timeStamp: number }) => void>();
      return {
        name,
        addEventListener: (_type: string, listener: (event: { data: number[]; timeStamp: number }) => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: { data: number[]; timeStamp: number }) => void) => listeners.delete(listener),
        send: (data: number[], timeStamp: number) => listeners.forEach((listener) => listener({ data, timeStamp })),
      };
    };
    const inputs = [makeInput('Controller Alpha'), makeInput('Controller Beta')];
    const accessListeners = new Set<() => void>();
    const access = {
      inputs: { forEach: (callback: (port: typeof inputs[number]) => void) => inputs.forEach(callback) },
      addEventListener: (_type: string, listener: () => void) => accessListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => accessListeners.delete(listener),
    };
    const permissionListeners = new Set<() => void>();
    const permissionStatus = {
      state: 'granted',
      addEventListener: (_type: string, listener: () => void) => permissionListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => permissionListeners.delete(listener),
    };
    Object.defineProperty(window, '__fakeMidiClock', { configurable: true, value: {
      send: (data: number[], timeStamp: number, sourceIndex = 0) => inputs[sourceIndex]?.send(data, timeStamp),
      remove: (sourceIndex: number) => {
        inputs.splice(sourceIndex, 1);
        accessListeners.forEach((listener) => listener());
      },
      revokePermission: () => {
        permissionStatus.state = 'denied';
        permissionListeners.forEach((listener) => listener());
      },
    } });
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access });
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => permissionStatus } });
  });
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);

  const status = page.getByTestId('midi-clock-status');
  await expect(status).toHaveText('Clock monitor off');
  await page.getByRole('button', { name: 'Connect MIDI clock input' }).click();
  await expect(status).toHaveText('Select one input to monitor');
  const relativePhase = page.getByTestId('midi-clock-relative-phase');
  const frameMapping = page.getByTestId('midi-clock-frame-map');
  const startFrameMapping = page.getByTestId('midi-clock-start-frame-map');
  await expect(relativePhase).toHaveText('Relative pulse phase: select one input');
  await expect(page.locator('.midi-clock-phase-note')).toContainText('FA frame projection remains diagnostic only');
  const source = page.getByTestId('midi-clock-input-select');
  await expect(source.locator('option')).toHaveText(['Select MIDI input', 'Controller Alpha', 'Controller Beta']);
  await source.selectOption({ label: 'Controller Alpha' });
  await expect(status).toHaveText('Waiting for F8 clock');
  await expect(frameMapping).toContainText(/Audio frame mapping unavailable|Read-only audio frame estimate/);
  await expect(page.getByText('Estimated from performance.now()', { exact: false })).toContainText('not sample-accurate');
  const transportBefore = await page.evaluate(async () => {
    const { Transport } = await import('/src/core/Transport.ts');
    const transport = Transport.getInstance();
    transport.setBpm(137);
    return { bpm: transport.bpm, state: transport.state, phaseRevision: transport.masterPhaseRevision };
  });

  const midiPulseTimer = await page.evaluate(() => {
    const fake = (window as unknown as { __fakeMidiClock: { send(data: number[], timeStamp: number, sourceIndex?: number): void } }).__fakeMidiClock;
    const start = performance.now();
    const periodMs = 60_000 / 120 / 24;
    let tick = 0;
    const timer = window.setInterval(() => {
      const now = performance.now();
      while (start + tick * periodMs <= now) {
        fake.send([0xf8], start + tick * periodMs);
        tick += 1;
      }
    }, 2);
    return timer;
  });
  await expect(frameMapping).toContainText('Audio frame mapping unavailable · insufficient-drift-evidence');
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const fake = (window as unknown as { __fakeMidiClock: { send(data: number[], timeStamp: number, sourceIndex?: number): void } }).__fakeMidiClock;
    fake.send([0xfa], performance.now());
  });
  await expect(startFrameMapping).toContainText(/MIDI Start \(FA\): observed · frame estimate unavailable · (?:insufficient-drift-evidence|invalid-anchor)/);

  // Keep the MIDI clock active while the real AudioContext clock is sampled for >3 seconds.
  // The early FA must remain unavailable; a later projection may still be unavailable if anchors are invalid.
  await page.waitForTimeout(3_400);
  await expect(startFrameMapping).toContainText(/MIDI Start \(FA\): observed · frame estimate unavailable · (?:insufficient-drift-evidence|invalid-anchor)/);
  await page.evaluate(() => {
    const fake = (window as unknown as { __fakeMidiClock: { send(data: number[], timeStamp: number, sourceIndex?: number): void } }).__fakeMidiClock;
    fake.send([0xfa], performance.now());
  });
  await expect(startFrameMapping).toContainText(/MIDI Start \(FA\): (?:read-only frame estimate|observed · frame estimate unavailable)/);
  await page.evaluate((timer) => window.clearInterval(timer), midiPulseTimer);

  await page.evaluate(() => {
    const fake = (window as unknown as { __fakeMidiClock: { send(data: number[], timeStamp: number, sourceIndex?: number): void } }).__fakeMidiClock;
    const start = performance.now();
    fake.send([0xfa], start);
    for (let tick = 0; tick <= 24; tick += 1) fake.send([0xf8], start + tick * (60_000 / 120 / 24));
  });
  await expect(status).toHaveText('Timing steady · monitor only');
  await expect(relativePhase).toContainText('Relative pulse phase: locked');
  await expect(relativePhase).toContainText('ticks from first pulse');
  await expect(page.getByTestId('midi-clock-phase-stats')).toHaveAttribute('data-locked', 'true');
  await expect(startFrameMapping).toContainText('MIDI Start (FA):');
  await expect(startFrameMapping).toContainText(/read-only frame estimate|frame estimate unavailable/);
  const transportAfter = await page.evaluate(async () => {
    const { Transport } = await import('/src/core/Transport.ts');
    const transport = Transport.getInstance();
    return { bpm: transport.bpm, state: transport.state, phaseRevision: transport.masterPhaseRevision };
  });
  expect(transportAfter).toEqual(transportBefore);
  await page.evaluate(() => {
    const fake = (window as unknown as { __fakeMidiClock: { send(data: number[], timeStamp: number, sourceIndex?: number): void } }).__fakeMidiClock;
    fake.send([0xf8], performance.now(), 1);
  });
  await expect(status).toHaveText('Timing steady · monitor only');
  await expect(page.getByTestId('midi-clock-phase-stats')).toHaveAttribute('data-locked', 'true');

  await source.selectOption({ label: 'Controller Beta' });
  await expect(relativePhase).toHaveText('Relative pulse phase: waiting for F8 clock');
  await expect(status).toHaveText('Waiting for F8 clock');
  await page.evaluate(() => {
    const fake = (window as unknown as { __fakeMidiClock: { send(data: number[], timeStamp: number, sourceIndex?: number): void } }).__fakeMidiClock;
    const start = performance.now();
    fake.send([0xf8], start, 1);
    for (let tick = 1; tick <= 24; tick += 1) fake.send([0xf8], start + tick * (60_000 / 120 / 24), 1);
  });
  await expect(relativePhase).toContainText('Relative pulse phase: locked');
  await expect(page.getByTestId('midi-clock-phase-stats')).toHaveAttribute('data-locked', 'true');
  await expect(page.getByTestId('midi-clock-selected')).toHaveText('Controller Beta');
  const transportAfterSourceSwitch = await page.evaluate(async () => {
    const { Transport } = await import('/src/core/Transport.ts');
    const transport = Transport.getInstance();
    return { bpm: transport.bpm, state: transport.state, phaseRevision: transport.masterPhaseRevision };
  });
  expect(transportAfterSourceSwitch).toEqual(transportBefore);

  await expect(relativePhase).toHaveText('Relative pulse phase: stale · unlocked', { timeout: 3200 });
  await source.selectOption({ label: 'Controller Alpha' });
  await expect(relativePhase).toHaveText('Relative pulse phase: waiting for F8 clock');
  const fake = page.evaluate(() => {
    (window as unknown as { __fakeMidiClock: { remove(sourceIndex: number): void } }).__fakeMidiClock.remove(0);
  });
  await fake;
  await expect(source).toHaveValue('');
  await expect(page.getByTestId('midi-clock-selected')).toHaveCount(0);
  await expect(status).toHaveText('Select one input to monitor');
  await page.evaluate(() => {
    const fake = (window as unknown as { __fakeMidiClock: { send(data: number[], timeStamp: number, sourceIndex?: number): void } }).__fakeMidiClock;
    fake.send([0xf8], performance.now(), 0);
  });
  await expect(status).toHaveText('Select one input to monitor');
  await page.evaluate(() => {
    (window as unknown as { __fakeMidiClock: { revokePermission(): void } }).__fakeMidiClock.revokePermission();
  });
  await expect(status).toHaveText('MIDI permission denied');
  await expect(page.getByTestId('midi-clock-input-select')).toHaveCount(0);
});
