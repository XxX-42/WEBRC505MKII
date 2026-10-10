import {
  handleSharedPitchWorkerMessage,
  type ExactPitchStretchSession,
} from './sharedPitchRenderWorkerRuntime';
import { getMaxAlignmentFrames, makeSharedPitchProfilePlan, SharedPitchRenderError,
  type SharedPitchWorkerJob } from './sharedPitchRender';

interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as WorkerScope;
if (typeof document === 'undefined') {
  workerScope.addEventListener('message', (event): void => {
    const job = event.data as SharedPitchWorkerJob;
    void handleSharedPitchWorkerMessage(job, (reply, transfer) => workerScope.postMessage(reply, transfer),
      createWasmExactPitchStretchSession);
  });
}

interface WasiIoCounters { fd_close: number; fd_write: number; fd_seek: number; }
interface TransferBuffer { token: number; address: number; frames: number; f32: Float32Array; u32: Uint32Array; }

type WasmFunction = (...args: (number | bigint)[]) => number;
type SharedPitchWasmExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  _initialize: () => void;
  webrc_dsp_extended_api_version: WasmFunction;
  webrc_dsp_extended_create: WasmFunction;
  webrc_dsp_extended_last_create_status: WasmFunction;
  webrc_dsp_extended_configure: WasmFunction;
  webrc_dsp_extended_destroy: WasmFunction;
  webrc_dsp_extended_input_latency_samples: WasmFunction;
  webrc_dsp_extended_output_latency_samples: WasmFunction;
  webrc_dsp_extended_process_pitch_stretch: WasmFunction;
  webrc_dsp_extended_pitch_output_seek_length: WasmFunction;
  webrc_dsp_extended_pitch_output_seek: WasmFunction;
  webrc_dsp_extended_pitch_flush: WasmFunction;
  webrc_dsp_alloc_f32_token: WasmFunction;
  webrc_dsp_transfer_address: WasmFunction;
  webrc_dsp_free_transfer_token: WasmFunction;
};

export async function createWasmExactPitchStretchSession(job: SharedPitchWorkerJob): Promise<ExactPitchStretchSession> {
  const imports = WebAssembly.Module.imports(job.module);
  const expectedImports = [
    ['wasi_snapshot_preview1', 'fd_close', 'function'],
    ['wasi_snapshot_preview1', 'fd_write', 'function'],
    ['wasi_snapshot_preview1', 'fd_seek', 'function'],
  ];
  if (JSON.stringify(imports.map(({ module, name, kind }) => [module, name, kind])) !== JSON.stringify(expectedImports)) {
    throw new SharedPitchRenderError('WASM_IMPORT_TABLE_UNSUPPORTED',
      'The verified shared DSP module has an unsupported import table.');
  }
  const wasiIo: WasiIoCounters = { fd_close: 0, fd_write: 0, fd_seek: 0 };
  const wasi = {
    fd_close() { wasiIo.fd_close += 1; return 8; },
    fd_write() { wasiIo.fd_write += 1; return 8; },
    fd_seek() { wasiIo.fd_seek += 1; return 8; },
  };
  const instance = await WebAssembly.instantiate(job.module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as SharedPitchWasmExports;
  if (typeof exports._initialize !== 'function' || !(exports.memory instanceof WebAssembly.Memory)) {
    throw new SharedPitchRenderError('WASM_INITIALIZATION_EXPORT_MISSING',
      'The shared DSP module lacks its standalone WASM initialization exports.');
  }
  exports._initialize();
  const initialMemoryBytes = exports.memory.buffer.byteLength;
  assertNoWorkerIo(wasiIo, initialMemoryBytes, exports.memory.buffer.byteLength);
  if (initialMemoryBytes !== 64 * 1024 * 1024) {
    throw new Error(`The shared DSP module reserved ${initialMemoryBytes} bytes; the Worker requires fixed 64 MiB.`);
  }
  for (const name of [
    'webrc_dsp_extended_api_version', 'webrc_dsp_extended_create', 'webrc_dsp_extended_last_create_status',
    'webrc_dsp_extended_configure', 'webrc_dsp_extended_destroy', 'webrc_dsp_extended_input_latency_samples',
    'webrc_dsp_extended_output_latency_samples', 'webrc_dsp_extended_process_pitch_stretch',
    'webrc_dsp_alloc_f32_token', 'webrc_dsp_transfer_address', 'webrc_dsp_free_transfer_token',
    'webrc_dsp_extended_pitch_output_seek_length', 'webrc_dsp_extended_pitch_output_seek',
    'webrc_dsp_extended_pitch_flush',
  ]) {
    if (typeof exports[name] !== 'function') {
      throw new SharedPitchRenderError('PITCH_ALIGNMENT_API_UNAVAILABLE',
        `The verified shared DSP module does not export ${name}; exact seek/flush alignment is unavailable.`);
    }
  }
  if (exports.webrc_dsp_extended_api_version() < 1) {
    throw new Error('The shared DSP extended ABI version is unsupported.');
  }
  assertNoWorkerIo(wasiIo, initialMemoryBytes, exports.memory.buffer.byteLength);
  return WasmExactPitchStretchSession.create(job, exports, wasiIo, initialMemoryBytes);
}

class WasmExactPitchStretchSession implements ExactPitchStretchSession {
  private readonly allocations: TransferBuffer[] = [];
  private readonly memory: WebAssembly.Memory;
  private readonly initialMemoryBytes: number;
  private readonly wasiIo: WasiIoCounters;
  private readonly exports: SharedPitchWasmExports;
  private readonly handle: number;
  private readonly maxBlockFrames: number;
  private readonly maxAlignmentFrames: number;
  private seekLengthOutput: TransferBuffer | null = null;
  private flushCountOutput: TransferBuffer | null = null;
  private seekLeft: TransferBuffer | null = null;
  private seekRight: TransferBuffer | null = null;
  private processInputLeft: TransferBuffer | null = null;
  private processInputRight: TransferBuffer | null = null;
  private processOutputLeft: TransferBuffer | null = null;
  private processOutputRight: TransferBuffer | null = null;
  private flushLeft: TransferBuffer | null = null;
  private flushRight: TransferBuffer | null = null;
  private expectedSeekFrames = 0;
  private disposed = false;

  private constructor(maxBlockFrames: number, maxAlignmentFrames: number, exports: SharedPitchWasmExports,
                      wasiIo: WasiIoCounters, initialMemoryBytes: number, handle: number) {
    this.exports = exports;
    this.memory = exports.memory;
    this.wasiIo = wasiIo;
    this.initialMemoryBytes = initialMemoryBytes;
    this.handle = handle;
    this.maxBlockFrames = maxBlockFrames;
    this.maxAlignmentFrames = maxAlignmentFrames;
  }

  static create(job: SharedPitchWorkerJob, exports: SharedPitchWasmExports,
                wasiIo: WasiIoCounters, initialMemoryBytes: number): WasmExactPitchStretchSession {
    let parameters: TransferBuffer | null = null;
    let handle = 0;
    let session: WasmExactPitchStretchSession | null = null;
    const plan = makeSharedPitchProfilePlan(job.profile, job.sampleRate, job.seed);
    try {
      parameters = allocateTransfer(exports, wasiIo, initialMemoryBytes, plan.prepareParameters.length);
      parameters.f32.set(plan.prepareParameters);
      handle = exports.webrc_dsp_extended_create(plan.kind, job.sampleRate, plan.maxBlockFrames,
        plan.channelsPerHandle, parameters.address, plan.prepareParameters.length, BigInt(plan.seed)) as number;
      releaseTransfer(exports, wasiIo, initialMemoryBytes, parameters);
      parameters = null;
      const createStatus = exports.webrc_dsp_extended_last_create_status() as number;
      if (handle === 0 || createStatus !== 0) {
        throw new Error(`Signalsmith handle prepare failed with status ${createStatus}.`);
      }
      session = new WasmExactPitchStretchSession(plan.maxBlockFrames, getMaxAlignmentFrames(plan),
        exports, wasiIo, initialMemoryBytes, handle);
      handle = 0;
      const transpose = session.allocate(2);
      transpose.f32[0] = 1;
      transpose.f32[1] = 0;
      const configureStatus = exports.webrc_dsp_extended_configure(session.handle, 12, transpose.address, 2,
        BigInt(plan.seed)) as number;
      session.release(transpose);
      if (configureStatus !== 0) {
        session.dispose();
        throw new Error(`Signalsmith unity-transpose configuration failed with status ${configureStatus}.`);
      }
      session.checkHealthy();
      return session;
    } catch (error) {
      if (parameters) releaseTransfer(exports, wasiIo, initialMemoryBytes, parameters);
      if (session) {
        session.dispose();
        throw error;
      }
      if (handle !== 0) {
        const status = exports.webrc_dsp_extended_destroy(handle) as number;
        if (status !== 0) throw new Error(`Failed to destroy incomplete Signalsmith handle (${status}).`);
      }
      assertNoWorkerIo(wasiIo, initialMemoryBytes, exports.memory.buffer.byteLength);
      throw error;
    }
  }

  outputSeekLength(playbackRate: number): number {
    this.seekLengthOutput ??= this.allocate(1);
    this.seekLengthOutput.u32[0] = 0;
    const status = this.exports.webrc_dsp_extended_pitch_output_seek_length(
      this.handle, playbackRate, this.seekLengthOutput.address) as number;
    this.checkStatus(status, 'Signalsmith outputSeekLength');
    const frames = this.seekLengthOutput.u32[0];
    if (!Number.isSafeInteger(frames) || frames < 1 || frames > this.maxAlignmentFrames) {
      throw new Error(`Signalsmith alignment seek length ${frames} exceeds the admitted range.`);
    }
    this.expectedSeekFrames = frames;
    return frames;
  }

  outputSeek(left: Float32Array, right: Float32Array, inputOffset: number,
             inputFrames: number, playbackRate: number): void {
    if (inputFrames !== this.expectedSeekFrames || inputOffset < 0 || inputOffset + inputFrames > left.length ||
        inputOffset + inputFrames > right.length) throw new Error('Signalsmith outputSeek span is invalid.');
    this.seekLeft = this.allocate(inputFrames);
    this.seekRight = this.allocate(inputFrames);
    this.seekLeft.f32.set(left.subarray(inputOffset, inputOffset + inputFrames));
    this.seekRight.f32.set(right.subarray(inputOffset, inputOffset + inputFrames));
    const status = this.exports.webrc_dsp_extended_pitch_output_seek(this.handle,
      this.seekLeft.address, this.seekRight.address, inputFrames, playbackRate) as number;
    this.checkStatus(status, 'Signalsmith outputSeek');
  }

  process(left: Float32Array, right: Float32Array, inputOffset: number, inputFrames: number,
          outputLeft: Float32Array, outputRight: Float32Array, outputOffset: number, outputFrames: number): void {
    if (inputFrames > this.maxBlockFrames || outputFrames > this.maxBlockFrames ||
        inputOffset < 0 || inputOffset + inputFrames > left.length || inputOffset + inputFrames > right.length ||
        outputOffset < 0 || outputOffset + outputFrames > outputLeft.length ||
        outputOffset + outputFrames > outputRight.length) throw new Error('Signalsmith process span is invalid.');
    this.ensureProcessBuffers();
    this.processInputLeft!.f32.set(left.subarray(inputOffset, inputOffset + inputFrames));
    this.processInputRight!.f32.set(right.subarray(inputOffset, inputOffset + inputFrames));
    const status = this.exports.webrc_dsp_extended_process_pitch_stretch(this.handle,
      this.processInputLeft!.address, this.processInputRight!.address, inputFrames,
      this.processOutputLeft!.address, this.processOutputRight!.address, outputFrames) as number;
    this.checkStatus(status, 'Signalsmith process');
    outputLeft.set(this.processOutputLeft!.f32.subarray(0, outputFrames), outputOffset);
    outputRight.set(this.processOutputRight!.f32.subarray(0, outputFrames), outputOffset);
  }

  flush(outputLeft: Float32Array, outputRight: Float32Array, outputOffset: number,
        outputFrames: number, playbackRate: number): number {
    if (outputFrames < 0 || outputFrames > this.maxAlignmentFrames || outputOffset < 0 || outputOffset + outputFrames > outputLeft.length ||
        outputOffset + outputFrames > outputRight.length) throw new Error('Signalsmith flush span is invalid.');
    if (outputFrames === 0) return 0;
    this.flushLeft = this.allocate(outputFrames);
    this.flushRight = this.allocate(outputFrames);
    this.flushCountOutput ??= this.allocate(1);
    this.flushCountOutput.u32[0] = 0;
    const status = this.exports.webrc_dsp_extended_pitch_flush(this.handle,
      this.flushLeft.address, this.flushRight.address, outputFrames, playbackRate,
      this.flushCountOutput.address) as number;
    this.checkStatus(status, 'Signalsmith flush');
    const produced = this.flushCountOutput.u32[0];
    if (produced !== outputFrames) throw new Error(`Signalsmith flush produced ${produced}/${outputFrames} frames.`);
    outputLeft.set(this.flushLeft.f32.subarray(0, produced), outputOffset);
    outputRight.set(this.flushRight.f32.subarray(0, produced), outputOffset);
    return produced;
  }

  inputLatencySamples(): number { return this.exports.webrc_dsp_extended_input_latency_samples(this.handle) as number; }
  outputLatencySamples(): number { return this.exports.webrc_dsp_extended_output_latency_samples(this.handle) as number; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const destroyStatus = this.exports.webrc_dsp_extended_destroy(this.handle) as number;
    let freeStatus = 0;
    for (let index = this.allocations.length - 1; index >= 0; index -= 1) {
      const buffer = this.allocations[index];
      if (!buffer) continue;
      const status = this.exports.webrc_dsp_free_transfer_token(buffer.token) as number;
      if (status !== 0 && freeStatus === 0) freeStatus = status;
    }
    this.allocations.length = 0;
    this.checkHealthy();
    if (destroyStatus !== 0 || freeStatus !== 0) {
      throw new Error(`Signalsmith cleanup failed (destroy=${destroyStatus}, free=${freeStatus}).`);
    }
  }

  private ensureProcessBuffers(): void {
    if (this.processInputLeft) return;
    this.processInputLeft = this.allocate(this.maxBlockFrames);
    this.processInputRight = this.allocate(this.maxBlockFrames);
    this.processOutputLeft = this.allocate(this.maxBlockFrames);
    this.processOutputRight = this.allocate(this.maxBlockFrames);
  }

  private allocate(frames: number): TransferBuffer {
    const buffer = allocateTransfer(this.exports, this.wasiIo, this.initialMemoryBytes, frames);
    this.allocations.push(buffer);
    return buffer;
  }

  private release(buffer: TransferBuffer): void {
    const index = this.allocations.indexOf(buffer);
    if (index < 0) return;
    releaseTransfer(this.exports, this.wasiIo, this.initialMemoryBytes, buffer);
    this.allocations.splice(index, 1);
  }

  private checkStatus(status: number, operation: string): void {
    this.checkHealthy();
    if (status !== 0) throw new Error(`${operation} failed with WASM status ${status}.`);
  }

  private checkHealthy(): void {
    assertNoWorkerIo(this.wasiIo, this.initialMemoryBytes, this.memory.buffer.byteLength);
  }
}

function allocateTransfer(exports: SharedPitchWasmExports, wasiIo: WasiIoCounters,
                          initialMemoryBytes: number, frames: number): TransferBuffer {
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > 0x7fff_ffff) throw new Error('Invalid WASM PCM span.');
  const token = exports.webrc_dsp_alloc_f32_token(frames) as number;
  if (!Number.isInteger(token) || token === 0) throw new Error(`WASM transfer-buffer allocation failed for ${frames} frames.`);
  const address = exports.webrc_dsp_transfer_address(token) as number;
  const byteLength = frames * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(address) || address <= 0 || address % Float32Array.BYTES_PER_ELEMENT !== 0 ||
      address + byteLength > exports.memory.buffer.byteLength) {
    exports.webrc_dsp_free_transfer_token(token);
    throw new Error('WASM transfer buffer returned an invalid linear-memory span.');
  }
  assertNoWorkerIo(wasiIo, initialMemoryBytes, exports.memory.buffer.byteLength);
  return { token, address, frames,
    f32: new Float32Array(exports.memory.buffer, address, frames),
    u32: new Uint32Array(exports.memory.buffer, address, frames) };
}

function releaseTransfer(exports: SharedPitchWasmExports, wasiIo: WasiIoCounters,
                         initialMemoryBytes: number, buffer: TransferBuffer): void {
  const status = exports.webrc_dsp_free_transfer_token(buffer.token) as number;
  assertNoWorkerIo(wasiIo, initialMemoryBytes, exports.memory.buffer.byteLength);
  if (status !== 0) throw new Error(`WASM transfer token ${buffer.token} free failed (${status}).`);
}

function assertNoWorkerIo(wasiIo: WasiIoCounters, expectedMemoryBytes: number, actualMemoryBytes: number): void {
  if (wasiIo.fd_close !== 0 || wasiIo.fd_write !== 0 || wasiIo.fd_seek !== 0) {
    throw new Error(`Standalone WASM attempted WASI I/O (close=${wasiIo.fd_close}, write=${wasiIo.fd_write}, seek=${wasiIo.fd_seek}).`);
  }
  if (actualMemoryBytes !== expectedMemoryBytes) throw new Error('Shared DSP WASM memory changed after initialization.');
}
