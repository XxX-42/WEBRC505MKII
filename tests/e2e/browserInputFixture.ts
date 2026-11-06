/** Install virtual audio through the public device lifecycle, including capture generation/READY. */
export async function installVirtualInput(engine: {
  setInputDevice(deviceId: string): Promise<void>;
  waitForInputCaptureReady(): Promise<void>;
}, stream: MediaStream): Promise<void> {
  const devices = navigator.mediaDevices;
  const original = Object.getOwnPropertyDescriptor(devices, 'getUserMedia');
  let requests = 0;
  Object.defineProperty(devices, 'getUserMedia', { configurable: true, value: async () => {
    requests += 1;
    return stream.clone();
  } });
  try {
    await engine.setInputDevice('');
    if (requests === 0) throw new Error('Virtual input was not requested through the public device lifecycle.');
    await engine.waitForInputCaptureReady();
  } finally {
    if (original) Object.defineProperty(devices, 'getUserMedia', original);
    else Reflect.deleteProperty(devices, 'getUserMedia');
  }
}
