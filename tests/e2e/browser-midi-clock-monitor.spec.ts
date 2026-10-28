import { expect, test } from '@playwright/test';

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

  const status = page.getByTestId('midi-clock-status');
  await expect(status).toHaveText('Clock monitor off');
  await page.getByRole('button', { name: 'Connect MIDI clock input' }).click();
  await expect(status).toHaveText('Select one input to monitor');
  const source = page.getByTestId('midi-clock-input-select');
  await expect(source.locator('option')).toHaveText(['Select MIDI input', 'Controller Alpha', 'Controller Beta']);
  await source.selectOption({ label: 'Controller Alpha' });
  await expect(status).toHaveText('Waiting for F8 clock');
  const transportBefore = await page.evaluate(async () => {
    const { Transport } = await import('/src/core/Transport.ts');
    const transport = Transport.getInstance();
    return { bpm: transport.bpm, state: transport.state, phaseRevision: transport.masterPhaseRevision };
  });

  await page.evaluate(() => {
    const fake = (window as unknown as { __fakeMidiClock: { send(data: number[], timeStamp: number, sourceIndex?: number): void } }).__fakeMidiClock;
    const start = performance.now();
    for (let tick = 0; tick <= 24; tick += 1) fake.send([0xf8], start + tick * (60_000 / 120 / 24));
  });
  await expect(status).toHaveText('Timing steady · monitor only');
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
