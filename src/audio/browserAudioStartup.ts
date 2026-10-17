export const BROWSER_AUDIO_RESUME_TIMEOUT_MS = 15_000;
export const BROWSER_AUDIO_INPUT_TIMEOUT_MS = 20_000;
export const BROWSER_AUDIO_WORKLET_TIMEOUT_MS = 15_000;
const workletModuleOperations = new WeakMap<object, Map<string, Promise<void>>>();

export class BrowserAudioStartupTimeoutError extends Error {
  public constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs} ms.`);
    this.name = 'TimeoutError';
  }
}

/** Race a browser startup operation against a finite deadline. */
export function withBrowserAudioTimeout<T>(
  operation: () => T | PromiseLike<T>,
  operationName: string,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new BrowserAudioStartupTimeoutError(operationName, timeoutMs)), timeoutMs);
  });
  let work: Promise<T>;
  try {
    // Invoke immediately so AudioContext.resume() and getUserMedia() retain the
    // trusted user activation from the caller's gesture handler.
    work = Promise.resolve(operation());
  } catch (error) {
    work = Promise.reject(error);
  }
  return Promise.race([work, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

export function resumeAudioContextWithTimeout(
  context: Pick<AudioContext, 'resume'>,
  timeoutMs = BROWSER_AUDIO_RESUME_TIMEOUT_MS,
): Promise<void> {
  return withBrowserAudioTimeout(() => context.resume(), 'AudioContext.resume()', timeoutMs);
}

export function addAudioWorkletModuleWithTimeout(
  audioWorklet: { addModule(moduleUrl: string): Promise<void> },
  moduleUrl: string,
  timeoutMs = BROWSER_AUDIO_WORKLET_TIMEOUT_MS,
): Promise<void> {
  let moduleOperations = workletModuleOperations.get(audioWorklet);
  if (!moduleOperations) {
    moduleOperations = new Map();
    workletModuleOperations.set(audioWorklet, moduleOperations);
  }

  let operation = moduleOperations.get(moduleUrl);
  if (!operation) {
    try {
      operation = Promise.resolve(audioWorklet.addModule(moduleUrl));
    } catch (error) {
      operation = Promise.reject(error);
    }
    moduleOperations.set(moduleUrl, operation);
    const registeredOperation = operation;
    void registeredOperation.catch(() => {
      if (moduleOperations?.get(moduleUrl) === registeredOperation) moduleOperations.delete(moduleUrl);
    });
  }

  // addModule has no cancellation API. Reuse an in-flight operation after a
  // timeout so retrying cannot register the same processor module twice.
  return withBrowserAudioTimeout(
    () => operation!,
    `AudioWorklet module ${moduleUrl}`,
    timeoutMs,
  );
}

/**
 * getUserMedia cannot be cancelled portably. If permission resolves after the
 * deadline, stop every track immediately so a late grant never leaks a device.
 */
export function getUserMediaWithTimeout(
  mediaDevices: Pick<MediaDevices, 'getUserMedia'>,
  constraints: MediaStreamConstraints,
  timeoutMs = BROWSER_AUDIO_INPUT_TIMEOUT_MS,
): Promise<MediaStream> {
  let requestTimedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let request: Promise<MediaStream>;
  try {
    request = Promise.resolve(mediaDevices.getUserMedia(constraints));
  } catch (error) {
    request = Promise.reject(error);
  }

  return new Promise<MediaStream>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      requestTimedOut = true;
      reject(new BrowserAudioStartupTimeoutError('Microphone permission request', timeoutMs));
    }, timeoutMs);

    request.then((stream) => {
      if (requestTimedOut) {
        stopMediaStream(stream);
        return;
      }
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      resolve(stream);
    }, (error: unknown) => {
      if (requestTimedOut) return;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      reject(error);
    });
  });
}

function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
