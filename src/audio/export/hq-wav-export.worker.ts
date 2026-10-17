import { renderPitchOffline } from '../pitch/signalsmith';
import { assertHqWavExportMemoryBudget, encodeAlignedHqWav, type HqWavWorkerRequest } from './hqWavExport';

interface WorkerScopeLike {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<HqWavWorkerRequest>) => void,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as WorkerScopeLike;

workerScope.addEventListener('message', (event) => {
  void handleRenderRequest(event.data);
});

async function handleRenderRequest(request: HqWavWorkerRequest): Promise<void> {
  try {
    const inputFrames = request.channels[0]?.length ?? 0;
    // Keep the guard at the worker boundary too. The main-thread check avoids
    // copying/starting a worker; this one ensures no renderer output buffers
    // are allocated if a malformed or future caller bypasses that preflight.
    assertHqWavExportMemoryBudget(inputFrames, request.channels.length, {
      sampleRate: request.sampleRate,
      semitones: request.semitones,
      playbackRate: request.playbackRate,
      format: request.format,
      memoryBudgetBytes: request.memoryBudgetBytes,
    }, 'browser');
    let lastProgressPercent = -1;
    const rendered = await renderPitchOffline(request.channels, {
      mode: 'HQ_RENDER',
      sampleRate: request.sampleRate,
      semitones: request.semitones,
      playbackRate: request.playbackRate,
      onProgress: (fraction) => {
        const bounded = Math.max(0, Math.min(1, fraction));
        const percent = Math.floor(bounded * 100);
        if (percent > lastProgressPercent) {
          lastProgressPercent = percent;
          workerScope.postMessage({ type: 'progress', fraction: bounded * 0.95 });
        }
      },
    });
    workerScope.postMessage({ type: 'progress', fraction: 0.98 });
    const result = encodeAlignedHqWav(rendered, request.channels[0]?.length ?? 0, request.format);
    // The WAV array is freshly allocated with an exact-sized ArrayBuffer.
    const bytes = new Uint8Array(result.bytes.byteLength);
    bytes.set(result.bytes);
    workerScope.postMessage({
      type: 'complete',
      bytes: bytes.buffer,
      sampleRate: result.sampleRate,
      format: result.format,
      semitones: result.semitones,
      playbackRate: result.playbackRate,
      frameCount: result.frameCount,
      leadingLatencySamples: result.leadingLatencySamples,
    }, [bytes.buffer]);
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'HQ WAV render failed',
    });
  }
}
