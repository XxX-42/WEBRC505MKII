/** Bound waits that browsers may leave pending while awaiting user permission. */
export function waitForAudioStartup<T>(
  operation: Promise<T>,
  message: string,
  timeoutMs = 15_000,
  discardLateResult?: (result: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error(message));
    }, timeoutMs);
    operation.then(result => {
      clearTimeout(timer);
      if (expired) discardLateResult?.(result);
      else resolve(result);
    }, error => {
      clearTimeout(timer);
      if (!expired) reject(error);
    });
  });
}
