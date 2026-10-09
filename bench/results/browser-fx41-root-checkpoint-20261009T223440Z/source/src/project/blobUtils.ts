export function isBlobLike(value: unknown): value is Blob {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as Blob).size === 'number'
    && typeof (value as Blob).slice === 'function';
}

export function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  if (typeof FileReader === 'undefined') return Promise.reject(new Error('Blob array-buffer reads are unavailable.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read Blob data.'));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new TypeError('Blob reader returned a non-binary result.'));
    };
    reader.readAsArrayBuffer(blob);
  });
}

export async function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new TextDecoder().decode(await readBlobArrayBuffer(blob));
}
