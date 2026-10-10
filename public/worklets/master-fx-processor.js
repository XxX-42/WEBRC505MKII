/* Post-mix shared DSP FX bus. Preparation/replacement messages are accepted
 * only while the owning AudioContext is suspended by BrowserAudioEngine. */
let sharedDspMasterInstanceSequence = 0;
const FX_MIDI_RING_VERSION = 1;
const FX_MIDI_RING_CAPACITY = 64;
const FX_MIDI_HEADER_WORDS = 8;
const FX_MIDI_SLOT_WORDS = 6;
const FX_MIDI_RING_MAGIC = 0x46584d31;

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
    this.lastFinalizedStageId = 0;
    this.wetGain = 0;
    this.wetTarget = 0;
    this.wetStep = 0;
    this.wetRampRemaining = 0;
    this.fxTransitionControl = null;
    this.fxTransitionIndex = 1;
    this.fxMidiHeader = null;
    this.fxMidiView = null;
    this.fxCurrentMidiEventCount = 0;
    this.fxCurrentCarrierChannels = 0;

    const processorOptions = options.processorOptions || {};
    if (processorOptions.fxTransitionBuffer instanceof SharedArrayBuffer &&
        processorOptions.fxTransitionBuffer.byteLength >= Int32Array.BYTES_PER_ELEMENT * 2) {
      this.fxTransitionControl = new Int32Array(processorOptions.fxTransitionBuffer);
    }
    try {
      this.prepare(processorOptions.sharedDspModule, processorOptions.maxBlockFrames || 4096, processorOptions);
    } catch (error) {
      this.port.postMessage({ type: 'MASTER_DSP_BOOT_ERROR', message: String(error && error.message || error) });
    }
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  prepare(wasmModule, maxBlockFrames, processorOptions = {}) {
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
        typeof wasm.webrc_dsp_fx_create_v2_api_version !== 'function' || wasm.webrc_dsp_fx_create_v2_api_version() !== 2 ||
        typeof wasm.webrc_dsp_fx_profile_setup_api_version !== 'function' || wasm.webrc_dsp_fx_profile_setup_api_version() !== 1 ||
        typeof wasm.webrc_dsp_fx_startup_warmup_upper_bound_samples_for_parameters !== 'function' ||
        wasm.webrc_dsp_fx_catalog_size() !== 53) {
      throw new Error('Master DSP module memory or ABI does not match the pinned Browser contract.');
    }
    const fxContextApiVersion = typeof wasm.webrc_dsp_fx_context_api_version === 'function'
      ? wasm.webrc_dsp_fx_context_api_version() : 0;
    if ((fxContextApiVersion !== 0 && fxContextApiVersion !== 1) ||
        (fxContextApiVersion === 1 && typeof wasm.webrc_dsp_fx_process_stereo_context_v1 !== 'function')) {
      throw new Error('Master DSP typed-context exports do not match their declared version.');
    }
    if (wasiCalls.fd_close || wasiCalls.fd_write || wasiCalls.fd_seek) {
      throw new Error('Master DSP module attempted WASI I/O during setup.');
    }
    const fxMidiBuffer = processorOptions.fxMidiBuffer;
    const fxCarrierControlBuffer = processorOptions.fxCarrierControl;
    if (!(fxMidiBuffer instanceof SharedArrayBuffer) ||
        fxMidiBuffer.byteLength !== (FX_MIDI_HEADER_WORDS + FX_MIDI_RING_CAPACITY * FX_MIDI_SLOT_WORDS) * 4 ||
        !(fxCarrierControlBuffer instanceof SharedArrayBuffer) || fxCarrierControlBuffer.byteLength !== 4) {
      throw new Error('Master DSP requires prepared MIDI and carrier-control sidecar buffers.');
    }
    const fxMidiHeader = new Int32Array(fxMidiBuffer, 0, FX_MIDI_HEADER_WORDS);
    if (Atomics.load(fxMidiHeader, 6) !== FX_MIDI_RING_VERSION ||
        Atomics.load(fxMidiHeader, 7) !== FX_MIDI_RING_MAGIC) {
      throw new Error('Master DSP MIDI transport header is invalid.');
    }
    const fxCarrierControl = new Int32Array(fxCarrierControlBuffer);
    const scratchToken = wasm.webrc_dsp_alloc_f32_token(maxBlockFrames * 12 + 256);
    if (!scratchToken) throw new Error('Master DSP could not reserve bounded stereo scratch.');
    const scratchAddress = wasm.webrc_dsp_transfer_address(scratchToken);
    const bytes = maxBlockFrames * Float32Array.BYTES_PER_ELEMENT;
    if (!scratchAddress || scratchAddress % Float32Array.BYTES_PER_ELEMENT !== 0 ||
        scratchAddress + bytes * 12 + 256 * Float32Array.BYTES_PER_ELEMENT > wasm.memory.buffer.byteLength) {
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
    const carrierLeftAddress = scratchAddress + bytes * 10;
    const carrierRightAddress = scratchAddress + bytes * 11;
    const initialValuesAddress = scratchAddress + bytes * 12;
    const initialIdsAddress = initialValuesAddress + 64 * Float32Array.BYTES_PER_ELEMENT;
    const fxMidiEventsAddress = initialIdsAddress + 64 * Uint32Array.BYTES_PER_ELEMENT;
    const fxHistoryFrames = Math.max(maxBlockFrames, Math.ceil(sampleRate * 0.1));
    this.dsp = {
      wasm, memory, maxBlockFrames, scratchToken, fxContextApiVersion,
      fxMidiBuffer, fxMidiHeader, fxMidiView: new DataView(fxMidiBuffer), fxCarrierControl,
      fxMidiEventsAddress,
      fxMidiEventsView: new DataView(memory, fxMidiEventsAddress, FX_MIDI_RING_CAPACITY * 8),
      fxCurrentMidiEventCount: 0,
      fxCurrentCarrierChannels: 0,
      carrierLeftAddress, carrierRightAddress,
      carrierLeft: new Float32Array(memory, carrierLeftAddress, maxBlockFrames),
      carrierRight: new Float32Array(memory, carrierRightAddress, maxBlockFrames),
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
      initialValuesAddress,
      initialIdsAddress,
      initialValues: new Float32Array(memory, initialValuesAddress, 64),
      initialIds: new Uint32Array(memory, initialIdsAddress, 64),
      startupWarmupOut: new Uint32Array(memory, initialValuesAddress, 1),
      transitionFrames: 0,
      transitionElapsed: 0,
      fxHistoryFrames,
      fxHistoryLeft: new Float32Array(fxHistoryFrames),
      fxHistoryRight: new Float32Array(fxHistoryFrames),
      fxHistoryWrite: 0,
      fxHistoryCount: 0,
      fxCarrierHistoryLeft: new Float32Array(fxHistoryFrames),
      fxCarrierHistoryRight: new Float32Array(fxHistoryFrames),
      fxCarrierHistoryWrite: 0,
      fxCarrierHistoryCount: 0,
      activeHandles: [],
      activeOrdinals: [],
      activeMidiCapable: [],
      staged: null,
      warming: null,
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
    let warmupFrames = 0;
    const candidate = [];
    const candidateOrdinals = [];
    const candidateMidiCapable = [];
    if (dsp.staged || dsp.warming || dsp.retired) error = 'A master FX candidate is already staged, warming, or awaiting finalization.';
    else if (!Array.isArray(plan) || plan.length > 4) error = 'Master FX plan must contain at most four slots.';
    for (let index = 0; !error && index < plan.length; index += 1) {
      const unit = plan[index];
      if (!unit || !Number.isInteger(unit.ordinal) || unit.ordinal < 1 || unit.ordinal > 53 ||
          wasm.webrc_dsp_fx_is_processor_available(unit.ordinal) !== 1 ||
          !Array.isArray(unit.parameters) || unit.parameters.length > 64) {
        error = `Master FX slot ${index} is unavailable or malformed.`;
        break;
      }
      if ((unit.ordinal === 19 || unit.ordinal === 20 || unit.ordinal === 21) && dsp.fxContextApiVersion !== 1) {
        error = `Master FX ordinal ${unit.ordinal} requires typed musical-context support.`;
        break;
      }
      if (unit.ordinal === 20 && Atomics.load(dsp.fxCarrierControl, 0) !== 1) {
        error = 'Master VOCODER requires an attached independent stereo carrier source.';
        break;
      }
      for (let parameterIndex = 0; parameterIndex < unit.parameters.length; parameterIndex += 1) {
        const parameter = unit.parameters[parameterIndex];
        if (!parameter || !Number.isInteger(parameter.id) || parameter.id < 0 ||
            !Number.isFinite(parameter.value) || !Number.isFinite(Math.fround(parameter.value))) {
          error = `Master FX slot ${index} has an invalid parameter.`;
          break;
        }
        dsp.initialIds[parameterIndex] = parameter.id;
        dsp.initialValues[parameterIndex] = Math.fround(parameter.value);
      }
      if (error) break;
      const handle = wasm.webrc_dsp_fx_create_v2(unit.ordinal, sampleRate, dsp.maxBlockFrames, 2,
        dsp.initialIdsAddress, dsp.initialValuesAddress, unit.parameters.length);
      if (!handle) {
        error = `Master FX ordinal ${unit.ordinal} could not be prepared (${wasm.webrc_dsp_fx_last_create_status()}).`;
        break;
      }
      candidate.push(handle);
      candidateOrdinals.push(unit.ordinal);
      const modeParameter = unit.ordinal === 19
        ? unit.parameters.find((parameter) => parameter.id === 107)
        : null;
      const modeValue = modeParameter ? modeParameter.value : 2;
      // The registry's missing-parameter default is Harmony Auto mode 2,
      // which is not MIDI driven.
      candidateMidiCapable.push(unit.ordinal === 21 || (unit.ordinal === 19 &&
        Number.isFinite(modeValue) && modeValue < 1.5));
      const latencyModel = wasm.webrc_dsp_fx_latency_model(handle);
      const fixedLatencyFrames = wasm.webrc_dsp_fx_fixed_latency_samples(handle);
      if (!Number.isInteger(latencyModel) || latencyModel < 0 || latencyModel > 2 ||
          (latencyModel === 0 && (!Number.isInteger(fixedLatencyFrames) || fixedLatencyFrames < 0))) {
        error = `Master FX ordinal ${unit.ordinal} reported an invalid latency contract.`;
        break;
      }
      const upperBoundStatus = wasm.webrc_dsp_fx_startup_warmup_upper_bound_samples_for_parameters(
        unit.ordinal, sampleRate, dsp.maxBlockFrames, 2,
        dsp.initialIdsAddress, dsp.initialValuesAddress, unit.parameters.length,
        dsp.startupWarmupOut.byteOffset);
      if (upperBoundStatus !== 0) {
        error = `Master FX ordinal ${unit.ordinal} has no supported startup warmup bound (${upperBoundStatus}).`;
        break;
      }
      const startupFrames = wasm.webrc_dsp_fx_startup_warmup_frames(handle);
      if (!Number.isInteger(startupFrames) || startupFrames < 0 || startupFrames > dsp.startupWarmupOut[0]) {
        error = `Master FX ordinal ${unit.ordinal} startup warmup exceeds its declared upper bound.`;
        break;
      }
      warmupFrames += startupFrames;
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
    // Create the complete lifecycle record on the setup/message path. When
    // the audio callback later promotes this candidate, it only updates
    // existing fields and swaps prepared handle arrays.
    dsp.staged = {
      stageId,
      handles: candidate,
      ordinals: candidateOrdinals,
      midiCapable: candidateMidiCapable,
      warmupFrames,
      warmedFrames: 0,
      failed: false,
      wetGain: this.wetGain,
      wetTarget: this.wetTarget,
      wetStep: this.wetStep,
      wetRampRemaining: this.wetRampRemaining,
    };
    this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_STAGED', requestId: message.requestId, ok: true, stageId,
      handleCount: candidate.length, warmupFrames, managedBytes: wasm.webrc_dsp_managed_memory_bytes() });
  }

  commitFxPlan(message) {
    const dsp = this.dsp;
    const staged = dsp.staged;
    if (!staged || staged.stageId !== (Number(message.stageId) >>> 0)) {
      this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_COMMITTED', requestId: message.requestId, ok: false,
        message: 'Master FX stage token is stale.' });
      return;
    }
    dsp.transitionFrames = Math.max(1, Math.round(sampleRate * 0.01));
    dsp.transitionElapsed = 0;
    if (message.allowHistoryWarmup === true) {
      if (!this.primeFxHandles(staged.handles, staged.warmupFrames, staged.ordinals)) {
        this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_COMMITTED', requestId: message.requestId, ok: false,
          message: 'Master FX candidate needs more real input history than is available; the old chain remains active.' });
        return;
      }
      this.activateStagedFxPlan(staged);
      dsp.retired = staged;
      dsp.staged = null;
      if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, dsp.transitionFrames);
    } else {
      staged.warmedFrames = 0;
      staged.failed = false;
      dsp.staged = null;
      dsp.warming = staged;
      if (staged.warmupFrames === 0) {
        this.activateStagedFxPlan(staged);
        dsp.retired = staged;
        dsp.warming = null;
        if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, dsp.transitionFrames);
      } else if (this.fxTransitionControl) {
        Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, staged.warmupFrames + dsp.transitionFrames);
      }
    }
    this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_COMMITTED', requestId: message.requestId, ok: true,
      warming: dsp.warming === staged,
      activeHandleCount: dsp.activeHandles.length, managedBytes: dsp.wasm.webrc_dsp_managed_memory_bytes() });
  }

  activateStagedFxPlan(staged) {
    const dsp = this.dsp;
    const previous = dsp.activeHandles;
    const previousOrdinals = dsp.activeOrdinals;
    const previousMidiCapable = dsp.activeMidiCapable;
    staged.wetGain = this.wetGain;
    staged.wetTarget = this.wetTarget;
    staged.wetStep = this.wetStep;
    staged.wetRampRemaining = this.wetRampRemaining;
    dsp.activeHandles = staged.handles;
    dsp.activeOrdinals = staged.ordinals;
    dsp.activeMidiCapable = staged.midiCapable;
    staged.handles = previous;
    staged.ordinals = previousOrdinals;
    staged.midiCapable = previousMidiCapable;
    this.wetGain = dsp.activeHandles.length > 0 ? 1 : 0;
    this.wetTarget = this.wetGain;
    this.wetStep = 0;
    this.wetRampRemaining = 0;
  }

  rollbackFxPlan(message) {
    const dsp = this.dsp;
    const warming = dsp.warming;
    if (warming && warming.stageId === (Number(message.stageId) >>> 0)) {
      for (let index = warming.handles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(warming.handles[index]);
      dsp.warming = null;
      dsp.transitionFrames = 0;
      dsp.transitionElapsed = 0;
      if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, 0);
      this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_ROLLED_BACK', requestId: message.requestId, ok: true,
        managedBytes: dsp.wasm.webrc_dsp_managed_memory_bytes() });
      return;
    }
    const retired = dsp.retired;
    if (!retired || retired.stageId !== (Number(message.stageId) >>> 0)) {
      this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_ROLLED_BACK', requestId: message.requestId, ok: false,
        message: 'Master FX rollback token is stale.' });
      return;
    }
    for (let index = dsp.activeHandles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(dsp.activeHandles[index]);
    dsp.activeHandles = retired.handles;
    dsp.activeOrdinals = retired.ordinals;
    dsp.activeMidiCapable = retired.midiCapable;
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
    const requestedStageId = Number(message.stageId) >>> 0;
    if (!retired && this.lastFinalizedStageId === requestedStageId) {
      this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_FINALIZED', requestId: message.requestId, ok: true,
        idempotent: true, managedBytes: dsp.wasm.webrc_dsp_managed_memory_bytes() });
      return;
    }
    if (!retired || retired.stageId !== requestedStageId) {
      this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_FINALIZED', requestId: message.requestId, ok: false,
        message: 'Master FX finalization token is stale.' });
      return;
    }
    if (dsp.transitionElapsed < dsp.transitionFrames) {
      if (message.allowUnrenderedFinalize !== true) {
        this.port.postMessage({ type: 'MASTER_DSP_FX_BANK_FINALIZED', requestId: message.requestId, ok: false,
          message: 'Master FX replacement output has not completed its crossfade.' });
        return;
      }
      // A context that was already stopped has no audible old output to
      // preserve. The candidate has been pre-rolled from captured input; keep
      // a bounded dry→new ramp for the first callbacks after it resumes.
      this.wetGain = 0;
      this.setWetTarget(dsp.activeHandles.length > 0 ? 1 : 0);
      dsp.transitionFrames = 0;
      dsp.transitionElapsed = 0;
      if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, 0);
    }
    for (let index = retired.handles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(retired.handles[index]);
    this.lastFinalizedStageId = requestedStageId;
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
    if (dsp.warming) {
      for (let index = dsp.warming.handles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(dsp.warming.handles[index]);
      dsp.warming = null;
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

  primeFxHandles(handles, warmupFrames, ordinals = null, midiCapable = null) {
    const dsp = this.dsp;
    if (!dsp || !Number.isInteger(warmupFrames) || warmupFrames < 0 || warmupFrames > dsp.fxHistoryFrames) return false;
    const hasVocoder = Boolean(ordinals && ordinals.includes(20));
    // A zero-startup-bound VOCODER still needs one paired real frame so a
    // stopped-bank adoption cannot claim a carrier history it never received.
    const primeFrames = hasVocoder ? Math.max(1, warmupFrames) : warmupFrames;
    if (primeFrames === 0) return true;
    if (dsp.fxHistoryCount < primeFrames ||
        (hasVocoder && dsp.fxCarrierHistoryCount < primeFrames)) return false;
    const firstHistoryFrame = (dsp.fxHistoryWrite - primeFrames + dsp.fxHistoryFrames) % dsp.fxHistoryFrames;
    const firstCarrierFrame = hasVocoder
      ? (dsp.fxCarrierHistoryWrite - primeFrames + dsp.fxHistoryFrames) % dsp.fxHistoryFrames
      : 0;
    const previousCarrierChannels = dsp.fxCurrentCarrierChannels;
    for (let offset = 0; offset < primeFrames;) {
      const frames = Math.min(dsp.maxBlockFrames, primeFrames - offset);
      for (let frame = 0; frame < frames; frame += 1) {
        const historyFrame = offset + frame;
        const index = (firstHistoryFrame + historyFrame) % dsp.fxHistoryFrames;
        dsp.dryLeft[frame] = dsp.fxHistoryLeft[index];
        dsp.dryRight[frame] = dsp.fxHistoryRight[index];
        if (hasVocoder) {
          const carrierIndex = (firstCarrierFrame + historyFrame) % dsp.fxHistoryFrames;
          dsp.carrierLeft[frame] = dsp.fxCarrierHistoryLeft[carrierIndex];
          dsp.carrierRight[frame] = dsp.fxCarrierHistoryRight[carrierIndex];
        }
      }
      if (hasVocoder) dsp.fxCurrentCarrierChannels = 2;
      if (!this.runFxChain(handles, dsp.dryLeft, dsp.dryRight,
        dsp.leftA, dsp.rightA, dsp.leftB, dsp.rightB,
        dsp.leftAAddress, dsp.rightAAddress, dsp.leftBAddress, dsp.rightBAddress, frames,
        ordinals, midiCapable, false)) {
        dsp.fxCurrentCarrierChannels = previousCarrierChannels;
        return false;
      }
      offset += frames;
    }
    dsp.fxCurrentCarrierChannels = previousCarrierChannels;
    return true;
  }

  recordFxInputHistory(inputLeft, inputRight, frames) {
    const dsp = this.dsp;
    if (!dsp || !dsp.fxHistoryLeft || !dsp.fxHistoryRight) return;
    let write = dsp.fxHistoryWrite;
    let count = dsp.fxHistoryCount;
    const capacity = dsp.fxHistoryFrames;
    for (let frame = 0; frame < frames; frame += 1) {
      dsp.fxHistoryLeft[write] = inputLeft[frame];
      dsp.fxHistoryRight[write] = inputRight[frame];
      write += 1;
      if (write === capacity) write = 0;
      if (count < capacity) count += 1;
    }
    dsp.fxHistoryWrite = write;
    dsp.fxHistoryCount = count;
  }

  recordFxCarrierHistory(frames) {
    const dsp = this.dsp;
    if (!dsp || !dsp.fxCarrierHistoryLeft || !dsp.fxCarrierHistoryRight) return;
    if (dsp.fxCurrentCarrierChannels !== 2) {
      dsp.fxCarrierHistoryCount = 0;
      return;
    }
    let write = dsp.fxCarrierHistoryWrite;
    let count = dsp.fxCarrierHistoryCount;
    const capacity = dsp.fxHistoryFrames;
    for (let frame = 0; frame < frames; frame += 1) {
      dsp.fxCarrierHistoryLeft[write] = dsp.carrierLeft[frame];
      dsp.fxCarrierHistoryRight[write] = dsp.carrierRight[frame];
      write += 1;
      if (write === capacity) write = 0;
      if (count < capacity) count += 1;
    }
    dsp.fxCarrierHistoryWrite = write;
    dsp.fxCarrierHistoryCount = count;
  }

  collectFxMidiEvents(blockStartFrame, frames) {
    const dsp = this.dsp;
    const header = dsp && dsp.fxMidiHeader;
    const view = dsp && dsp.fxMidiView;
    const eventView = dsp && dsp.fxMidiEventsView;
    if (!header || !view || !eventView || !Number.isSafeInteger(blockStartFrame) ||
        blockStartFrame < 0 || !Number.isInteger(frames) || frames < 1) return;
    let read = Atomics.load(header, 1) >>> 0;
    const write = Atomics.load(header, 0) >>> 0;
    const blockEndFrame = blockStartFrame + frames;
    let count = 0;
    while (read !== write && count < FX_MIDI_RING_CAPACITY) {
      const slotOffset = (FX_MIDI_HEADER_WORDS + (read % FX_MIDI_RING_CAPACITY) * FX_MIDI_SLOT_WORDS) * 4;
      const low = view.getUint32(slotOffset, true);
      const high = view.getUint32(slotOffset + 4, true);
      const targetFrame = high * 0x1_0000_0000 + low;
      if (!Number.isSafeInteger(targetFrame)) {
        Atomics.add(header, 2, 1);
        read = (read + 1) >>> 0;
        continue;
      }
      if (targetFrame >= blockEndFrame) break;
      const type = view.getUint32(slotOffset + 8, true);
      const channel = view.getUint32(slotOffset + 12, true);
      const note = view.getUint32(slotOffset + 16, true);
      const velocity = view.getUint32(slotOffset + 20, true);
      if (type > 2 || channel !== 0 || note > 127 || velocity > 127) {
        Atomics.add(header, 2, 1);
        read = (read + 1) >>> 0;
        continue;
      }
      const eventOffset = count * 8;
      eventView.setUint32(eventOffset, Math.max(0, targetFrame - blockStartFrame), true);
      eventView.setUint8(eventOffset + 4, type);
      eventView.setUint8(eventOffset + 5, channel);
      eventView.setUint8(eventOffset + 6, note);
      eventView.setUint8(eventOffset + 7, velocity);
      count += 1;
      read = (read + 1) >>> 0;
    }
    dsp.fxCurrentMidiEventCount = count;
    Atomics.store(header, 1, read | 0);
  }

  prepareFxCarrier(inputs, frames) {
    const dsp = this.dsp;
    if (!dsp || !dsp.carrierLeft || !dsp.carrierRight) return;
    const input = inputs && inputs[1];
    const left = input && input.length >= 2 ? input[0] : null;
    const right = input && input.length >= 2 ? input[1] : null;
    const stereoPresent = Boolean(left && right && left.length >= frames && right.length >= frames);
    dsp.fxCurrentCarrierChannels = stereoPresent ? 2 : (input && input.length === 1 ? 1 : 0);
    for (let frame = 0; frame < frames && frame < dsp.maxBlockFrames; frame += 1) {
      const leftSample = stereoPresent ? left[frame] : 0;
      const rightSample = stereoPresent ? right[frame] : 0;
      dsp.carrierLeft[frame] = Number.isFinite(leftSample) ? leftSample : 0;
      dsp.carrierRight[frame] = Number.isFinite(rightSample) ? rightSample : 0;
    }
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
    this.collectFxMidiEvents(frameStart, frames);
    this.prepareFxCarrier(inputs, frames);
    this.recordFxCarrierHistory(frames);
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
    this.recordFxInputHistory(dryLeft, dryRight, frames);
    const activeBank = this.runFxChain(dsp.activeHandles, dryLeft, dryRight, dsp.leftA, dsp.rightA,
      dsp.leftB, dsp.rightB, dsp.leftAAddress, dsp.rightAAddress, dsp.leftBAddress, dsp.rightBAddress,
      frames, dsp.activeOrdinals, dsp.activeMidiCapable);
    const warming = dsp.warming;
    if (warming && !warming.failed) {
      const candidateReady = this.runFxChain(warming.handles, dryLeft, dryRight,
        dsp.oldLeftA, dsp.oldRightA, dsp.oldLeftB, dsp.oldRightB,
        dsp.oldLeftAAddress, dsp.oldRightAAddress, dsp.oldLeftBAddress, dsp.oldRightBAddress,
        frames, warming.ordinals, warming.midiCapable);
      if (!candidateReady) {
        warming.failed = true;
        this.processFailures += 1;
        if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, -1);
      } else {
        warming.warmedFrames = Math.min(warming.warmupFrames, warming.warmedFrames + frames);
      }
    }
    const transitionActive = dsp.retired && dsp.transitionElapsed < dsp.transitionFrames;
    const previousBank = transitionActive
      ? this.runFxChain(dsp.retired.handles, dryLeft, dryRight, dsp.oldLeftA, dsp.oldRightA,
        dsp.oldLeftB, dsp.oldRightB, dsp.oldLeftAAddress, dsp.oldRightAAddress,
        dsp.oldLeftBAddress, dsp.oldRightBAddress, frames, dsp.retired.ordinals, dsp.retired.midiCapable)
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
    if (warming && dsp.warming === warming) {
      if (warming.failed) {
        if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, -1);
      } else if (warming.warmedFrames >= warming.warmupFrames) {
        this.activateStagedFxPlan(warming);
        dsp.warming = null;
        dsp.retired = warming;
        dsp.transitionElapsed = 0;
        if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, dsp.transitionFrames);
      } else if (this.fxTransitionControl) {
        Atomics.store(this.fxTransitionControl, this.fxTransitionIndex,
          warming.warmupFrames - warming.warmedFrames + dsp.transitionFrames);
      }
    }
    this.nonFiniteSamples += nonFinite;
    this.processedFrames += frames;
    this.outputFrames += frames;
    return true;
  }

  runFxChain(handles, inputLeft, inputRight, bufferLeftA, bufferRightA, bufferLeftB, bufferRightB,
    addressLeftA, addressRightA, addressLeftB, addressRightB, frames,
    ordinals = null, midiCapable = null, withMidiEvents = true) {
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
      const ordinal = ordinals ? ordinals[index] : 0;
      const isMidiProcessor = ordinal === 21 || (ordinal === 19 && Boolean(midiCapable && midiCapable[index]));
      const isVocoder = ordinal === 20;
      const midiCount = withMidiEvents && isMidiProcessor ? this.dsp.fxCurrentMidiEventCount : 0;
      const carrierChannels = isVocoder && this.dsp.fxCurrentCarrierChannels === 2 ? 2 : 0;
      const status = this.dsp.fxContextApiVersion === 1
        ? this.dsp.wasm.webrc_dsp_fx_process_stereo_context_v1(handles[index],
          sourceLeftAddress, sourceRightAddress, destinationLeftAddress, destinationRightAddress, frames,
          0, 0, 0, 0,
          carrierChannels ? this.dsp.carrierLeftAddress : 0,
          carrierChannels ? this.dsp.carrierRightAddress : 0,
          carrierChannels ? frames : 0,
          carrierChannels,
          midiCount ? this.dsp.fxMidiEventsAddress : 0,
          midiCount)
        : this.dsp.wasm.webrc_dsp_fx_process_stereo(handles[index],
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
