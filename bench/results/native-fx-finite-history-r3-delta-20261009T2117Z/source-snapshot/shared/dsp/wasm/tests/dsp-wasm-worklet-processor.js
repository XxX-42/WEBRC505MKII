const CONTROL_START = 0;
const CONTROL_READY = 1;
const CONTROL_DONE = 2;
const CONTROL_CALLBACKS = 3;
const CONTROL_ERROR = 4;

function makeImports(wasmModule) {
  const imports = {};
  let memoryView = null;
  let ioCallCount = 0;
  let ioFailureCount = 0;
  const badFileDescriptor = 8;
  const failedIo = () => {
    ioCallCount += 1;
    ioFailureCount += 1;
    return badFileDescriptor;
  };
  const importedFunctions = WebAssembly.Module.imports(wasmModule);
  for (let index = 0; index < importedFunctions.length; index += 1) {
    const item = importedFunctions[index];
    if (item.kind !== 'function' || item.module !== 'wasi_snapshot_preview1') {
      throw new Error(`Unsupported standalone WASM import: ${item.module}.${item.name} (${item.kind})`);
    }
    const moduleImports = imports[item.module] || (imports[item.module] = {});
    if (item.name === 'fd_close') {
      moduleImports[item.name] = () => failedIo();
    } else if (item.name === 'fd_seek') {
      moduleImports[item.name] = (_fd, _offset, _whence, outputOffset) => {
        if (memoryView && outputOffset > 0 && outputOffset + 8 <= memoryView.byteLength) {
          memoryView.setBigInt64(outputOffset, 0n, true);
        }
        return failedIo();
      };
    } else if (item.name === 'fd_write') {
      moduleImports[item.name] = (_fd, _iovec, _iovecCount, outputBytes) => {
        if (memoryView && outputBytes > 0 && outputBytes + 4 <= memoryView.byteLength) {
          memoryView.setUint32(outputBytes, 0, true);
        }
        return failedIo();
      };
    } else {
      throw new Error(`Unsupported WASI function: ${item.name}`);
    }
  }
  return {
    imports,
    setMemory: (value) => { memoryView = new DataView(value.buffer); },
    ioCallCount: () => ioCallCount,
    ioFailureCount: () => ioFailureCount,
  };
}

class DspWasmWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options.processorOptions || {};
    if (!(processorOptions.wasmModule instanceof WebAssembly.Module)) {
      throw new Error('Main thread must pass a compiled WebAssembly.Module.');
    }
    if (!(processorOptions.controlBuffer instanceof SharedArrayBuffer) ||
        !(processorOptions.frameRecordBuffer instanceof SharedArrayBuffer) ||
        !(processorOptions.summaryBuffer instanceof SharedArrayBuffer)) {
      throw new Error('Worklet benchmark buffers must be preallocated SharedArrayBuffers.');
    }

    this.maxBlockFrames = processorOptions.maxBlockFrames >>> 0;
    this.targetBlocks = processorOptions.targetBlocks >>> 0;
    if (this.maxBlockFrames < 1 || this.maxBlockFrames > 8192 ||
        this.targetBlocks < 1 || this.targetBlocks > 10000) {
      throw new Error('Invalid preallocation sizes passed to the Worklet.');
    }
    this.control = new Int32Array(processorOptions.controlBuffer);
    this.frameRecord = new Int32Array(processorOptions.frameRecordBuffer);
    this.summary = new Float64Array(processorOptions.summaryBuffer);
    if (this.frameRecord.length < this.targetBlocks || this.summary.length < 16) {
      throw new Error('Worklet benchmark buffers are smaller than the requested run.');
    }

    this.importAdapter = makeImports(processorOptions.wasmModule);
    const instance = new WebAssembly.Instance(processorOptions.wasmModule, this.importAdapter.imports);
    this.wasm = instance.exports;
    this.memory = this.wasm.memory;
    this.importAdapter.setMemory(this.memory);
    if (typeof this.wasm._initialize === 'function') this.wasm._initialize();
    if (this.importAdapter.ioCallCount() !== 0 || this.importAdapter.ioFailureCount() !== 0) {
      throw new Error('WASM setup attempted unsupported WASI I/O.');
    }
    this.memoryBytesBeforeRender = this.memory.buffer.byteLength;

    this.handle = this.wasm.webrc_dsp_create(2, sampleRate, this.maxBlockFrames, 1, 0);
    const result = this.wasm.webrc_dsp_last_create_status();
    if (!this.handle || result !== 0) throw new Error(`WASM biquad prepare failed (${result}).`);

    const controlAddress = this.wasm.webrc_dsp_alloc_f32(3);
    this.inputAddress = this.wasm.webrc_dsp_alloc_f32(this.maxBlockFrames);
    this.outputAddress = this.wasm.webrc_dsp_alloc_f32(this.maxBlockFrames);
    if (!controlAddress || !this.inputAddress || !this.outputAddress) {
      throw new Error('WASM audio transfer buffer allocation failed during Worklet construction.');
    }
    this.parameterView = new Float32Array(this.memory.buffer, controlAddress, 3);
    this.inputView = new Float32Array(this.memory.buffer, this.inputAddress, this.maxBlockFrames);
    this.outputView = new Float32Array(this.memory.buffer, this.outputAddress, this.maxBlockFrames);
    this.parameterView[0] = 1200;
    this.parameterView[1] = 0.7071067811865476;
    this.parameterView[2] = 5;
    const configured = this.wasm.webrc_dsp_configure(this.handle, 2, controlAddress, 3);
    if (configured !== 0) throw new Error(`WASM biquad configuration failed (${configured}).`);

    this.callbackCount = 0;
    this.measuredBlocks = 0;
    this.measuring = false;
    this.startCallbackIndex = -1;
    this.sampleCount = 0;
    this.sumSquares = 0;
    this.peak = 0;
    this.nonFiniteCount = 0;
    this.nonZeroInputSamples = 0;
    this.totalFrames = 0;
    this.frameGapCount = 0;
    this.expectedNextFrame = -1;
    this.processError = 0;
    this.ioFailure = 0;
    this.maxObservedFrames = 0;
    this.control[CONTROL_READY] = 1;
    this.port.postMessage({
      type: 'DSP_WASM_READY',
      apiVersion: this.wasm.webrc_dsp_api_version(),
      sampleRate,
      maxBlockFrames: this.maxBlockFrames,
      memoryBytes: this.memoryBytesBeforeRender,
      actualProcessorOptionsType: typeof processorOptions.wasmModule,
    });
  }

  process(inputs, outputs) {
    this.callbackCount += 1;
    const outputChannels = outputs[0];
    const frames = outputChannels && outputChannels[0] ? outputChannels[0].length : 0;
    if (frames <= 0 || frames > this.maxBlockFrames) {
      this.control[CONTROL_ERROR] = -4;
      return true;
    }
    this.maxObservedFrames = Math.max(this.maxObservedFrames, frames);

    const processFrame = typeof currentFrame === 'number' ? currentFrame : -1;
    if (processFrame >= 0) {
      if (this.expectedNextFrame >= 0 && processFrame !== this.expectedNextFrame) this.frameGapCount += 1;
      this.expectedNextFrame = processFrame + frames;
    }

    const inputChannels = inputs[0];
    const input = inputChannels && inputChannels[0] ? inputChannels[0] : null;
    for (let frame = 0; frame < frames; frame += 1) {
      const sample = input && frame < input.length ? input[frame] : 0;
      this.inputView[frame] = sample;
      if (sample !== 0) this.nonZeroInputSamples += 1;
    }
    const status = this.wasm.webrc_dsp_process(this.handle, this.inputAddress, 0,
      this.outputAddress, 0, 0, 0, frames);
    if (status !== 0) this.processError = status;
    if (this.importAdapter.ioCallCount() !== 0 || this.importAdapter.ioFailureCount() !== 0) {
      this.ioFailure = 1;
      this.control[CONTROL_ERROR] = -5;
    }

    for (let channelIndex = 0; channelIndex < outputChannels.length; channelIndex += 1) {
      const output = outputChannels[channelIndex];
      for (let frame = 0; frame < frames; frame += 1) {
        const value = this.outputView[frame];
        output[frame] = value;
        if (channelIndex === 0) {
          if (!Number.isFinite(value)) this.nonFiniteCount += 1;
          else {
            this.sumSquares += value * value;
            this.peak = Math.max(this.peak, Math.abs(value));
          }
        }
      }
    }
    this.sampleCount += frames;
    this.totalFrames += frames;

    if (Atomics.load(this.control, CONTROL_START) === 1) {
      if (!this.measuring) {
        this.measuring = true;
        this.startCallbackIndex = this.callbackCount - 1;
      }
      if (this.measuredBlocks < this.targetBlocks) {
        this.frameRecord[this.measuredBlocks] = frames;
        this.measuredBlocks += 1;
        if (this.measuredBlocks === this.targetBlocks) {
          this.summary[0] = this.sampleCount;
          this.summary[1] = this.sumSquares;
          this.summary[2] = this.peak;
          this.summary[3] = this.nonFiniteCount;
          this.summary[4] = this.nonZeroInputSamples;
          this.summary[5] = this.callbackCount;
          this.summary[6] = this.startCallbackIndex;
          this.summary[7] = this.measuredBlocks;
          this.summary[8] = this.totalFrames;
          this.summary[9] = this.frameGapCount;
          this.summary[10] = this.memory.buffer.byteLength;
          this.summary[11] = this.processError;
          this.summary[12] = this.maxObservedFrames;
          this.summary[13] = this.importAdapter.ioCallCount();
          this.summary[14] = this.importAdapter.ioFailureCount();
          Atomics.store(this.control, CONTROL_DONE, 1);
        }
      }
    }
    this.control[CONTROL_CALLBACKS] = this.callbackCount;
    return true;
  }
}

registerProcessor('dsp-wasm-interface-smoke', DspWasmWorkletProcessor);
