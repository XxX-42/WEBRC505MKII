import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('Browser shared-DSP artifact loader', () => {
  it('retries after a transient fetch failure and shares concurrent loads', async () => {
    vi.resetModules();
    const { loadBrowserSharedDspArtifact } = await import('../../src/audio/sharedDspGraph');
    const wasmBytes = await readFile(resolve('public/dsp/webrc-dsp.wasm'));
    const buildManifest = JSON.parse(await readFile(resolve('public/dsp/webrc-dsp.build.json'), 'utf8'));
    const wasmBuffer = wasmBytes.buffer.slice(
      wasmBytes.byteOffset,
      wasmBytes.byteOffset + wasmBytes.byteLength,
    ) as ArrayBuffer;
    const wasmUrl = '/dsp/test-retry.wasm';
    const buildUrl = '/dsp/test-retry.build.json';
    let wasmFetchAttempts = 0;

    const response = (status: number, body: unknown): Response => ({
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => body as ArrayBuffer,
      json: async () => body,
    }) as Response;
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === wasmUrl) {
        wasmFetchAttempts += 1;
        if (wasmFetchAttempts === 1) return response(503, new ArrayBuffer(0));
        return response(200, wasmBuffer);
      }
      if (url === buildUrl) return response(200, buildManifest);
      throw new Error(`Unexpected artifact request: ${url}`);
    });

    const fetcher = fetchMock as unknown as typeof fetch;
    const first = loadBrowserSharedDspArtifact(fetcher, wasmUrl, buildUrl);
    expect(loadBrowserSharedDspArtifact(fetcher, wasmUrl, buildUrl)).toBe(first);
    await expect(first).rejects.toThrow('Shared DSP WebAssembly fetch failed (503).');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const retry = loadBrowserSharedDspArtifact(fetcher, wasmUrl, buildUrl);
    expect(loadBrowserSharedDspArtifact(fetcher, wasmUrl, buildUrl)).toBe(retry);
    const [artifact, concurrentArtifact] = await Promise.all([retry, retry]);
    expect(artifact).toBe(concurrentArtifact);
    expect(artifact.sha256).toBe(buildManifest.artifact.sha256);
    expect(artifact.byteLength).toBe(wasmBytes.byteLength);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    expect(loadBrowserSharedDspArtifact(fetcher, wasmUrl, buildUrl)).toBe(retry);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
