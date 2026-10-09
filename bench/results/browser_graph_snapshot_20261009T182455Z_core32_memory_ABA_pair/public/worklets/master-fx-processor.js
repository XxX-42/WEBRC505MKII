/* Post-mix shared DSP FX bus. Preparation/replacement messages are accepted
 * only while the owning AudioContext is suspended by BrowserAudioEngine. */
let sharedDspMasterInstanceSequence = 0;
class WebrcSharedDspMasterFxProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.processorInstanceId = ++sharedDspMasterInstanceSequence;
    this.dsp = null;
    this.processCallbacks = 0;
    this.processedFrames = 0;
    this.outputFrames = 0;
    this.processFailures = 0;
    this.nonFiniteSamples = 0;
    this.lastQuantumFrames = 0;
    this.minimumQuantumFrames = 0;
    this.maximumQuantumFrames = 0;
    this.lastFrameStart = -1;
    this.lastFrameEnd = -1;
    this.frameDiscontinuities = 0;
    this.nextStageId = 0;
    this.wetGain = 0;
    this.wetTarget = 0;
    this.wetStep = 0;
    this.wetRampRemaining = 0;
    this.fxTransitionControl = null;
    this.fxTransitionIndex = 1;

    const processorOptions = options.processorOptions || {};
    if (processorOptions.fxTransitionBuffer instanceof SharedArrayBuffer &&
        processorOptions.fxTransitionBuffer.byteLength >= Int32Array.BYTES_PER_ELEMENT * 2) {
      this.fxTransitionControl = new Int32Array(processorOptions.fxTransitionBuffer);
    }
    try {
      this.prepare(processorOptions.sharedDspModule, processorOptions.maxBlockFrames || 4096);
    } catch (error) {
      this.port.postMessage({ type: 'MASTER_DSP_BOOT_ERROR', message: String(error && error.message || error) });
    }
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  prepare(wasmModule, maxBlockFrames) {
    if (!(wasmModule instanceof WebAssembly.Module)) throw new Error('Master DSP requires the verified shared WebAssembly module.');
    if (!Number.isInteger(maxBlockFrames) || maxBlockFrames < 1 || maxBlockFrames > 4096) {
      throw new RangeError('Master DSP maximum block size is outside the prepared Worklet bound.');
    }
    const wasiCalls = { fd_close: 0, fd_write: 0, fd_seek: 0 };
    const instance = new WebAssembly.Instance(wasmModule, { wasi_snapshot_preview1: {
      fd_close() { wasiCalls.fd_close += 1; return 8; },
      fd_write() { wasiCalls.fd_write += 1; return 8; },
      fd_seek() { wasiCalls.fd_seek += 1; return 8; },
    } });
    const wasm = instance.exports;
    if (typeof wasm._initialize === 'function') wasm._initialize();
    if (!(wasm.memory instanceof WebAssembly.Memory) || wasm.memory.buffer.byteLength !== 64 * 1024 * 1024 ||
        wasm.webrc_dsp_abi_version() !== 2 || wasm.webrc_dsp_extended_api_version() !== 1 ||
        wasm.webrc_dsp_capabilities() !== 7 || wasm.webrc_dsp_fx_api_version() !== 1 ||
        wasm.webrc_dsp_fx_catalog_size() !== 53) {
      throw new Error('Master DSP module memory or ABI does not match the pinned Browser contract.');
    }
    if (wasiCalls.fd_close || wasiCalls.fd_write || wasiCalls.fd_seek) {
      throw new Error('Master DSP module attempted WASI I/O during setup.');
    }
    const scratchToken = wasm.webrc_dsp_alloc_f32_token(maxBlockFrames * 10);
    if (!scratchToken) throw new Error('Master DSP could not reserve bounded stereo scratch.');
    const scratchAddress = wasm.webrc_dsp_transfer_address(scratchToken);
    const bytes = maxBlockFrames * Float32Array.BYTES_PER_ELEMENT;
    if (!scratchAddress || scratchAddress % Float32Array.BYTES_PER_ELEMENT !== 0 ||
        scratchAddress + bytes * 10 > wasm.memory.buffer.byteLength) {
      wasm.webrc_dsp_free_transfer_token(scratchToken);
      throw new Error('Master DSP stereo scratch is outside linear memory.');
    }
    const memory = wasm.memory.buffer;
    const leftAAddress = scratchAddress;
    const rightAAddress = scratchAddress + bytes;
    const leftBAddress = scratchAddress + bytes * 2;
    const rightBAddress = scratchAddress + bytes * 3;
    const dryLeftAddress = scratchAddress + bytes * 4;
    const dryRightAddress = scratchAddress + bytes * 5;
    const oldLeftAAddress = scratchAddress + bytes * 6;
    const oldRightAAddress = scratchAddress + bytes * 7;
    const oldLeftBAddress = scratchAddress + bytes * 8;
    const oldRightBAddress = scratchAddress + bytes * 9;
    this.dsp = {
      wasm, memory, maxBlockFrames, scratchToken,
      leftAAddress, rightAAddress, leftBAddress, rightBAddress,
      dryLeftAddress, dryRightAddress, oldLeftAAddress, oldRightAAddress,
      oldLeftBAddress, oldRightBAddress,
      leftA: new Float32Array(memory, leftAAddress, maxBlockFrames),
      rightA: new Float32Array(memory, rightAAddress, maxBlockFrames),
      leftB: new Float32Array(memory, leftBAddress, maxBlockFrames),
      rightB: new Float32Array(memory, rightBAddress, maxBlockFrames),
      dryLeft: new Float32Array(memory, dryLeftAddress, maxBlockFrames),
      dryRight: new Float32Array(memory, dryRightAddress, maxBlockFrames),
      oldLeftA: new Float32Array(memory, oldLeftAAddress, maxBlockFrames),
      oldRightA: new Float32Array(memory, oldRightAAddress, maxBlockFrames),
      oldLeftB: new Float32Array(memory, oldLeftBAddress, maxBlockFrames),
      oldRightB: new Float32Array(memory, oldRightBAddress, maxBlockFrames),
      transitionFrames: 0,
      transitionElapsed: 0,
      activeHandles: [],
      staged: null,
      retired: null,
      disposed: false,
    };
    this.port.postMessage({
      type: 'MASTER_DSP_READY', abiVersion: 1, maxBlockFrames,
      processorInstanceId: this.processorInstanceId,
      memoryBytes: wasm.memory.buffer.byteLength,
      managedBytes: wasm.webrc_dsp_managed_memory_bytes(),
      wasiCalls,
    });
  }

  handleMessage(message) {
    if (!message || !this.dsp || this.dsp.disposed) return;
    if (message.type === 'MASTER_DSP_FX_BANK_STAGE') this.stageFxPlan(message);
    else if (message.type === 'MASTER_DSP_FX_BANK_COMMIT') this.commitFxPlan(message);
    else if (message.type === 'MASTER_DSP_FX_BANK_ABORT') this.abortFxPlan(message);
    else if (message.type === 'MASTER_DSP_FX_BANK_ROLLBACK') this.rollbackFxPlan(message);
    else if (message.type === 'MASTER_DSP_FX_BANK_FINALIZE') this.finalizeFxPlan(message);
    else if (message.type === 'MASTER_DSP_DIAGNOSTICS') this.replyDiagnostics(message);
    else if (message.type === 'MASTER_DSP_DISPOSE') {
      this.dispose();
      this.port.postMessage({ type: 'MASTER_DSP_DISPOSED' });
    }
  }

  stageFxPlan(message) {
    const dsp = this.dsp;
    const wasm = dsp.wasm;
    const plan = message.plan;
    let error = '';
    const candidate = [];
    if (dsp.staged || dsp.retired) error = 'A master FX candidate is already staged or awaiting finalization.';
    else if (!Array.isArray(plan) || plan.length > 4) error = 'Master FX plan must contain at most four slots.';
    for (let index = 0; !error && index < plan.length; index += 1) {
      const unit = plan[index];
      if (!unit || !Number.isInteger(unit.ordinal) || unit.ordinal < 1 || unit.ordinal > 53 ||
          wasm.webrc_dsp_fx_is_processor_available(unit.ordinal) !== 1 ||
          !Array.isArray(unit.parameters) || unit.parameters.length > 64) {
        error = `Master FX slot ${index} is unavailable or malformed.`;
        break;
      }
      const handle = wasm.webrc_dsp_fx_create(unit.ordinal, sampleRate, dsp.maxBlockFrames, 2);
      if (!handle) {
        error = `Master FX ordinal ${unit.ordinal} could not be prepared (${wasm.webrc_dsp_fx_last_create_status()}).`;
        break;
      }
      candidate.push(handle);
      for (let parameterIndex = 0; parameterIndex < unit.parameters.length; parameterIndex += 1) {
        const parameter = unit.parameters[parameterIndex];
        if (!parameter || !Number.isInteger(parameter.id) || parameter.id < 0 ||
            !Number.isFinite(parameter.value) || !Number.isFinite(Math.fround(parameter.value))) {
          error = `Master FX slot ${index} has an invalid parameter.`;
          break;
        }
        const status = wasm.webrc_dsp_fx_set_parameter(handle, parameter.id, Math.fround(parameter.value));
        if (status !== 0) {
          error = `Master FX ordinal ${unit.ordinal} rejected parameter ${parameter.id} (${status}).`;
          break;
        }
      }
    }
    if (!error && (wasm.webrc_dsp_managed_memory_bytes() > 48 * 1024 * 1024 ||
        wasm.memory.buffer.byteLength !== 64 * 1024 * 1024)) error = 'Master FX candidate exceeds its bounded module budget.';
    if (error) {
      for (let index = candidate.length - 1; index >= 0; index -= 1) wasm.webrc_dsp_fx_destroy(candidate[index]);
      this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_STAGED', requestId: message.requestId, ok: false, message: error });
      return;
    }
    let stageId = (this.nextStageId + 1) >>> 0;
    if (stageId === 0) stageId = 1;
    this.nextStageId = stageId;
    dsp.staged = { stageId, handles: candidate };
    this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_STAGED', requestId: message.requestId, ok: true, stageId,
      handleCount: candidate.length, managedBytes: wasm.webrc_dsp_managed_memory_bytes() });
  }

  commitFxPlan(message) {
    const dsp = this.dsp;
    const staged = dsp.staged;
    if (!staged || staged.stageId !== (Number(message.stageId) >>> 0)) {
      this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_COMMITTED', requestId: message.requestId, ok: false,
        message: 'Master FX stage token is stale.' });
      return;
    }
    const previous = dsp.activeHandles;
    dsp.activeHandles = staged.handles;
    dsp.staged = null;
    dsp.retired = { stageId: staged.stageId, handles: previous,
      wetGain: this.wetGain, wetTarget: this.wetTarget, wetStep: this.wetStep,
      wetRampRemaining: this.wetRampRemaining };
    dsp.transitionFrames = Math.max(1, Math.round(sampleRate * 0.01));
    dsp.transitionElapsed = 0;
    if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, dsp.transitionFrames);
    this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_COMMITTED', requestId: message.requestId, ok: true,
      activeHandleCount: dsp.activeHandles.length, managedBytes: dsp.wasm.webrc_dsp_managed_memory_bytes() });
  }

  rollbackFxPlan(message) {
    const dsp = this.dsp;
    const retired = dsp.retired;
    if (!retired || retired.stageId !== (Number(message.stageId) >>> 0)) {
      this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_ROLLED_BACK', requestId: message.requestId, ok: false,
        message: 'Master FX rollback token is stale.' });
      return;
    }
    for (let index = dsp.activeHandles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(dsp.activeHandles[index]);
    dsp.activeHandles = retired.handles;
    this.wetGain = retired.wetGain;
    this.wetTarget = retired.wetTarget;
    this.wetStep = retired.wetStep;
    this.wetRampRemaining = retired.wetRampRemaining;
    dsp.transitionFrames = 0;
    dsp.transitionElapsed = 0;
    if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, 0);
    dsp.retired = null;
    this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_ROLLED_BACK', requestId: message.requestId, ok: true,
      managedBytes: dsp.wasm.webrc_dsp_managed_memory_bytes() });
  }

  finalizeFxPlan(message) {
    const dsp = this.dsp;
    const retired = dsp.retired;
    if (!retired || retired.stageId !== (Number(message.stageId) >>> 0)) {
      this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_FINALIZED', requestId: message.requestId, ok: false,
        message: 'Master FX finalization token is stale.' });
      return;
    }
    if (dsp.transitionElapsed < dsp.transitionFrames) {
      // BrowserAudioEngine only finalizes while the context is suspended. A
      // stopped-context edit has no audible old→new transition to preserve;
      // keep a short dry→new ramp for the first callbacks after resume.
      this.wetGain = 0;
      this.setWetTarget(dsp.activeHandles.length > 0 ? 1 : 0);
      dsp.transitionFrames = 0;
      dsp.transitionElapsed = 0;
      if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, 0);
    }
    for (let index = retired.handles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(retired.handles[index]);
    dsp.retired = null;
    this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_FINALIZED', requestId: message.requestId, ok: true,
      managedBytes: dsp.wasm.webrc_dsp_managed_memory_bytes() });
  }

  abortFxPlan(message) {
    const dsp = this.dsp;
    const staged = dsp.staged;
    if (!staged || staged.stageId !== (Number(message.stageId) >>> 0)) {
      this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_ABORTED', requestId: message.requestId, ok: false,
        message: 'Master FX stage token is stale.' });
      return;
    }
    for (let index = staged.handles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(staged.handles[index]);
    dsp.staged = null;
    this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_ABORTED', requestId: message.requestId, ok: true,
      managedBytes: dsp.wasm.webrc_dsp_managed_memory_bytes() });
  }

  replyDiagnostics(message) {
    const dsp = this.dsp;
    this.port.postMessage({
      type: 'MASTER_DSP_DIAGNOSTICS_REPLY', requestId: message.requestId,
      processCallbacks: this.processCallbacks, processedFrames: this.processedFrames,
      outputFrames: this.outputFrames, processFailures: this.processFailures,
      nonFiniteSamples: this.nonFiniteSamples, lastQuantumFrames: this.lastQuantumFrames,
      minimumQuantumFrames: this.minimumQuantumFrames, maximumQuantumFrames: this.maximumQuantumFrames,
      lastFrameStart: this.lastFrameStart, lastFrameEnd: this.lastFrameEnd,
      frameDiscontinuities: this.frameDiscontinuities, activeFxCount: dsp.activeHandles.length,
      managedBytes: dsp.wasm.webrc_dsp_managed_memory_bytes(),
    });
  }

  dispose() {
    const dsp = this.dsp;
    if (!dsp || dsp.disposed) return;
    dsp.disposed = true;
    if (dsp.staged) {
      for (let index = dsp.staged.handles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(dsp.staged.handles[index]);
      dsp.staged = null;
    }
    if (dsp.retired) {
      for (let index = dsp.retired.handles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(dsp.retired.handles[index]);
      dsp.retired = null;
    }
    for (let index = dsp.activeHandles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(dsp.activeHandles[index]);
    dsp.activeHandles.length = 0;
    if (dsp.scratchToken) dsp.wasm.webrc_dsp_free_transfer_token(dsp.scratchToken);
    this.dsp = null;
  }

  setWetTarget(target) {
    this.wetTarget = target > 0 ? 1 : 0;
    this.wetRampRemaining = Math.max(1, Math.round(sampleRate * 0.01));
    this.wetStep = (this.wetTarget - this.wetGain) / this.wetRampRemaining;
  }

  nextWetGain() {
    if (this.wetRampRemaining > 0) {
      this.wetGain += this.wetStep;
      this.wetRampRemaining -= 1;
      if (this.wetRampRemaining === 0) this.wetGain = this.wetTarget;
    }
    return this.wetGain;
  }

  process(inputs, outputs) {
    const dsp = this.dsp;
    const output = outputs[0];
    if (!dsp || dsp.disposed || !output || !output[0]) return true;
    const frames = output[0].length;
    if (!Number.isInteger(frames) || frames < 1) return true;
    const left = output[0];
    const right = output.length > 1 ? output[1] : null;
    const input = inputs[0];
    const inputLeft = input && input.length > 0 && input[0] ? input[0] : null;
    const inputRight = input && input.length > 1 && input[1] ? input[1] : inputLeft;
    const frameStart = currentFrame;
    if (this.lastFrameEnd >= 0 && frameStart !== this.lastFrameEnd) this.frameDiscontinuities += 1;
    this.lastFrameStart = frameStart;
    this.lastFrameEnd = frameStart + frames;
    this.processCallbacks += 1;
    this.lastQuantumFrames = frames;
    if (this.minimumQuantumFrames === 0 || frames < this.minimumQuantumFrames) this.minimumQuantumFrames = frames;
    if (frames > this.maximumQuantumFrames) this.maximumQuantumFrames = frames;

    if (frames > dsp.maxBlockFrames || !right || right.length < frames || !inputLeft || inputLeft.length < frames ||
        !inputRight || inputRight.length < frames) {
      left.fill(0);
      if (right) right.fill(0);
      this.processFailures += 1;
      return true;
    }

    const dryLeft = dsp.dryLeft;
    const dryRight = dsp.dryRight;
    let inputNonFinite = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      const sourceLeftSample = inputLeft[frame];
      const sourceRightSample = inputRight[frame];
      if (Number.isFinite(sourceLeftSample)) dryLeft[frame] = sourceLeftSample;
      else { dryLeft[frame] = 0; inputNonFinite += 1; }
      if (Number.isFinite(sourceRightSample)) dryRight[frame] = sourceRightSample;
      else { dryRight[frame] = 0; inputNonFinite += 1; }
    }
    this.nonFiniteSamples += inputNonFinite;
    const activeBank = this.runFxChain(dsp.activeHandles, dryLeft, dryRight, dsp.leftA, dsp.rightA,
      dsp.leftB, dsp.rightB, dsp.leftAAddress, dsp.rightAAddress, dsp.leftBAddress, dsp.rightBAddress, frames);
    const transitionActive = dsp.retired && dsp.transitionElapsed < dsp.transitionFrames;
    const previousBank = transitionActive
      ? this.runFxChain(dsp.retired.handles, dryLeft, dryRight, dsp.oldLeftA, dsp.oldRightA,
        dsp.oldLeftB, dsp.oldRightB, dsp.oldLeftAAddress, dsp.oldRightAAddress,
        dsp.oldLeftBAddress, dsp.oldRightBAddress, frames)
      : 1;
    if (!activeBank || !previousBank) {
      left.fill(0);
      right.fill(0);
      this.processFailures += 1;
      return true;
    }
    let nonFinite = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      const newLeft = activeBank === 1 ? dryLeft[frame] : (activeBank === 2 ? dsp.leftA[frame] : dsp.leftB[frame]);
      const newRight = activeBank === 1 ? dryRight[frame] : (activeBank === 2 ? dsp.rightA[frame] : dsp.rightB[frame]);
      const oldLeft = !transitionActive || previousBank === 1 ? dryLeft[frame]
        : (previousBank === 2 ? dsp.oldLeftA[frame] : dsp.oldLeftB[frame]);
      const oldRight = !transitionActive || previousBank === 1 ? dryRight[frame]
        : (previousBank === 2 ? dsp.oldRightA[frame] : dsp.oldRightB[frame]);
      if (!Number.isFinite(newLeft) || !Number.isFinite(newRight) || !Number.isFinite(oldLeft) || !Number.isFinite(oldRight)) {
        left[frame] = 0;
        right[frame] = 0;
        nonFinite += 1;
      } else {
        if (transitionActive) {
          const position = Math.min(1, (dsp.transitionElapsed + frame + 1) / dsp.transitionFrames);
          left[frame] = oldLeft + (newLeft - oldLeft) * position;
          right[frame] = oldRight + (newRight - oldRight) * position;
        } else if (this.wetRampRemaining > 0) {
          const wet = this.nextWetGain();
          const dry = 1 - wet;
          left[frame] = dryLeft[frame] * dry + newLeft * wet;
          right[frame] = dryRight[frame] * dry + newRight * wet;
        } else {
          left[frame] = newLeft;
          right[frame] = newRight;
        }
      }
    }
    if (transitionActive) {
      dsp.transitionElapsed = Math.min(dsp.transitionFrames, dsp.transitionElapsed + frames);
      if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex,
        Math.max(0, dsp.transitionFrames - dsp.transitionElapsed));
      if (dsp.transitionElapsed >= dsp.transitionFrames) {
        this.wetGain = 1;
        this.wetTarget = 1;
        this.wetRampRemaining = 0;
      }
    }
    this.nonFiniteSamples += nonFinite;
    this.processedFrames += frames;
    this.outputFrames += frames;
    return true;
  }

  runFxChain(handles, inputLeft, inputRight, bufferLeftA, bufferRightA, bufferLeftB, bufferRightB,
    addressLeftA, addressRightA, addressLeftB, addressRightB, frames) {
    for (let frame = 0; frame < frames; frame += 1) {
      bufferLeftA[frame] = inputLeft[frame];
      bufferRightA[frame] = inputRight[frame];
    }
    if (handles.length === 0) return 1;
    let sourceLeft = bufferLeftA;
    let sourceRight = bufferRightA;
    let sourceLeftAddress = addressLeftA;
    let sourceRightAddress = addressRightA;
    let destinationLeft = bufferLeftB;
    let destinationRight = bufferRightB;
    let destinationLeftAddress = addressLeftB;
    let destinationRightAddress = addressRightB;
    for (let index = 0; index < handles.length; index += 1) {
      const status = this.dsp.wasm.webrc_dsp_fx_process_stereo(handles[index],
        sourceLeftAddress, sourceRightAddress, destinationLeftAddress, destinationRightAddress, frames);
      if (status !== 0) return 0;
      const swapLeft = sourceLeft; sourceLeft = destinationLeft; destinationLeft = swapLeft;
      const swapRight = sourceRight; sourceRight = destinationRight; destinationRight = swapRight;
      const swapLeftAddress = sourceLeftAddress; sourceLeftAddress = destinationLeftAddress; destinationLeftAddress = swapLeftAddress;
      const swapRightAddress = sourceRightAddress; sourceRightAddress = destinationRightAddress; destinationRightAddress = swapRightAddress;
    }
    return sourceLeft === bufferLeftA ? 2 : 3;
  }
}

registerProcessor('webrc-shared-dsp-master-fx', WebrcSharedDspMasterFxProcessor);
