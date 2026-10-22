import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeBridgeClient, NativeProjectImportIndeterminateError, NativeProjectImportOutcomeUnknownError } from '../../src/audio/NativeBridgeClient';

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

describe('Native project import bridge client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uploads exact raw archive bytes and validates the host generation', async () => {
    const archive = new Uint8Array([0x52, 0x43, 0x35, 0x30, 0x35, 0x50, 0x41, 0, 1, 0, 0, 0]);
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, generation: 17 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new NativeBridgeClient().beginProjectArchiveImport(archive, 42)).resolves.toBe(17);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:17755/v1/project/import?expectedContentRevision=42', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: archive,
    }));
  });

  it('labels a lost upload acknowledgement as unknown instead of claiming rollback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection reset'); }));
    const archive = new Uint8Array([0x52, 0x43, 0x35, 0x30, 0x35, 0x50, 0x41, 0, 1, 0, 0, 0]);

    await expect(new NativeBridgeClient().beginProjectArchiveImport(archive, 42))
      .rejects.toMatchObject<Partial<NativeProjectImportOutcomeUnknownError>>({
        name: 'NativeProjectImportOutcomeUnknownError',
        message: expect.stringContaining('request outcome is unknown'),
      });
  });

  it('rejects a missing, fractional, or unsafe operation-start content revision before upload', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const archive = new Uint8Array([0x52, 0x43, 0x35, 0x30, 0x35, 0x50, 0x41, 0, 1, 0, 0, 0]);

    await expect(new NativeBridgeClient().beginProjectArchiveImport(archive, Number.NaN)).rejects.toThrow(/operation-start content revision/i);
    await expect(new NativeBridgeClient().beginProjectArchiveImport(archive, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(/operation-start content revision/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('waits for callback acknowledgement and returns only the terminal commit', async () => {
    const states = ['pending', 'claimed', 'committed'];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/status?')) return jsonResponse({ ok: true, generation: 8, state: states.shift() });
      throw new Error(`Unexpected route ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new NativeBridgeClient().waitForProjectArchiveImport(8, 1_000);
    expect(result).toEqual({ ok: true, generation: 8, state: 'committed' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('cancels only a still-pending transaction and confirms terminal cancellation', async () => {
    let cancelled = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/status?')) return jsonResponse({ ok: true, generation: 12, state: cancelled ? 'cancelled' : 'pending' });
      if (url.endsWith('/cancel')) { cancelled = true; return jsonResponse({ ok: true, generation: 12, state: 'cancelled' }); }
      throw new Error(`Unexpected route ${url} ${init?.method}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(new NativeBridgeClient().waitForProjectArchiveImport(12, 0)).resolves.toMatchObject({ state: 'cancelled' });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:17755/v1/project/import/status?generation=12',
      'http://127.0.0.1:17755/v1/project/import/cancel',
      'http://127.0.0.1:17755/v1/project/import/status?generation=12',
    ]);
  });

  it('cancels a pending generation when the operation-start state changed', async () => {
    let cancelled = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/status?')) return jsonResponse({ ok: true, generation: 18, state: cancelled ? 'cancelled' : 'pending' });
      if (url.endsWith('/cancel')) { cancelled = true; return jsonResponse({ ok: true, generation: 18, state: 'cancelled' }); }
      throw new Error(`Unexpected route ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(new NativeBridgeClient().waitForProjectArchiveImport(18, 1_000, () => false))
      .resolves.toMatchObject({ state: 'cancelled' });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:17755/v1/project/import/status?generation=18',
      'http://127.0.0.1:17755/v1/project/import/cancel',
      'http://127.0.0.1:17755/v1/project/import/status?generation=18',
    ]);
  });

  it('does not misreport a stale operation as cancelled after the callback claims it', async () => {
    const states = ['pending', 'claimed', 'committed'];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/status?')) return jsonResponse({ ok: true, generation: 19, state: states.shift() });
      if (url.endsWith('/cancel')) return jsonResponse({ ok: true, generation: 19, state: 'claimed' }, 409);
      throw new Error(`Unexpected route ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(new NativeBridgeClient().waitForProjectArchiveImport(19, 1_000, () => false))
      .resolves.toMatchObject({ state: 'committed' });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:17755/v1/project/import/status?generation=19',
      'http://127.0.0.1:17755/v1/project/import/cancel',
      'http://127.0.0.1:17755/v1/project/import/status?generation=19',
      'http://127.0.0.1:17755/v1/project/import/status?generation=19',
    ]);
  });

  it('never cancels or declares failure when the callback has claimed the generation', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, generation: 23, state: 'claimed' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new NativeBridgeClient().waitForProjectArchiveImport(23, 0))
      .rejects.toMatchObject<Partial<NativeProjectImportIndeterminateError>>({ generation: 23 });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:17755/v1/project/import/status?generation=23',
    ]);
  });

  it('keeps the accepted generation visible when a status request loses the bridge connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection reset'); }));

    await expect(new NativeBridgeClient().waitForProjectArchiveImport(42, 1_000))
      .rejects.toMatchObject<Partial<NativeProjectImportIndeterminateError>>({
        generation: 42,
        message: expect.stringContaining('connection reset'),
      });
  });

  it('does not report rollback when cancellation acknowledgement is lost', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/status?')) return jsonResponse({ ok: true, generation: 43, state: 'pending' });
      throw new Error('cancel response lost');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(new NativeBridgeClient().waitForProjectArchiveImport(43, 0))
      .rejects.toMatchObject<Partial<NativeProjectImportIndeterminateError>>({
        generation: 43,
        message: expect.stringContaining('cancel response lost'),
      });
  });
});
