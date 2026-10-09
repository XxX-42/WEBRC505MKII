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

describe('shared DSP prepare-time FX parameters', () => {
  it('fills omitted PREAMP selectors from the loaded module defaults and preserves explicit selections', async () => {
    vi.resetModules();
    const { completeSharedDspPrepareParameters } = await import('../../src/audio/sharedDspGraph');
    const catalog = [{
      ordinal: 23,
      id: 'rc505mkii.fx.preamp',
      displayName: 'PREAMP',
      family: 'amp',
      officialParametersValidated: false,
      parameters: [
        { id: 82, name: 'ampModel', unit: 'selector', minimum: 0, maximum: 8, defaultValue: 3, origin: 0 },
        { id: 83, name: 'speakerModel', unit: 'selector', minimum: 0, maximum: 8, defaultValue: 1, origin: 0 },
        { id: 84, name: 'micModel', unit: 'selector', minimum: 0, maximum: 7, defaultValue: 0, origin: 0 },
        { id: 85, name: 'micDistance', unit: 'selector', minimum: 0, maximum: 1, defaultValue: 0, origin: 0 },
        { id: 86, name: 'micPositionCm', unit: 'cm', minimum: 0, maximum: 10, defaultValue: 0, origin: 0 },
      ],
    }];

    expect(completeSharedDspPrepareParameters(23, [{ id: 48, value: 1 }, { id: 82, value: 8 }], catalog))
      .toEqual([
        { id: 48, value: 1 }, { id: 82, value: 8 }, { id: 83, value: 1 },
        { id: 84, value: 0 }, { id: 85, value: 0 }, { id: 86, value: 0 },
      ]);
    expect(completeSharedDspPrepareParameters(2, [{ id: 1, value: 1000 }], catalog))
      .toEqual([{ id: 1, value: 1000 }]);
  });

  it('fails closed when defaults are unavailable or selector IDs are duplicated', async () => {
    vi.resetModules();
    const { completeSharedDspPrepareParameters } = await import('../../src/audio/sharedDspGraph');
    expect(() => completeSharedDspPrepareParameters(23, [], [])).toThrow(/defaults are unavailable/);
    const catalog = [{
      ordinal: 23, id: 'preamp', displayName: 'PREAMP', family: 'amp',
      officialParametersValidated: false,
      parameters: [{ id: 82, name: 'ampModel', unit: 'selector', minimum: 0, maximum: 8, defaultValue: 3, origin: 0 }],
    }];
    expect(() => completeSharedDspPrepareParameters(23, [
      { id: 82, value: 1 }, { id: 82, value: 2 },
    ], catalog)).toThrow(/duplicate ID/);
    expect(() => completeSharedDspPrepareParameters(23, [], catalog)).toThrow(/selector 83/);
  });
});
