const TRACK_COUNT = 5;
const OUTPUT_COUNT = 7;
const COMMAND_CAPACITY = 256;
const COMMAND_WORDS = 8;
const COMMAND_WORD_OFFSET = 24;
const COMMAND_READ = 0;
const COMMAND_WRITE = 1;
const RENDER_FRAME_SEQUENCE = 2;
const RENDER_FRAME_LOW = 3;
const RENDER_FRAME_HIGH = 4;
const UNDERRUNS = 5;
const LAST_ACK_SEQUENCE = 6;
const LAST_ACK_FRAME_SEQUENCE = 7;
const LAST_ACK_FRAME_LOW = 8;
const LAST_ACK_FRAME_HIGH = 9;
const OUTPUT_MONITOR_ENABLED = 10;
const BPM_WORD = 11;
const RHYTHM_RUNNING = 12;
const RHYTHM_PATTERN = 13;
const COMMAND_OVERRUNS = 14;
const DEADLINE_MISSES = 15;
const LAST_QUANTUM_FRAMES = 16;
const MASTER_ORIGIN_LOW = 17;
const MASTER_ORIGIN_HIGH = 18;
const TRACK_CAPACITY_OVERRUNS = 19;
const DEADLINE_METRIC_AVAILABLE = 20;
const INPUT_DROPOUT_BLOCKS = 21;
const TRACK_STATES_WORD_OFFSET = 24 + COMMAND_CAPACITY * COMMAND_WORDS;
const TRACK_POSITIONS_WORD_OFFSET = TRACK_STATES_WORD_OFFSET + TRACK_COUNT;
const TRACK_META_WORDS = 16;
const LAYOUT_VERSION = 2;
const TRACK_CHANNEL_COUNT = 2;
const LAYOUT_MONO = 0;
const LAYOUT_PLANAR_LR = 1;
const TRACK_STATE = 0;
const LOOP_FRAMES = 1;
const RECORDING_FRAMES = 2;
const PLAY_POSITION = 3;
const CAPACITY_FRAMES = 4;
const RECORD_START_LOW = 5;
const RECORD_START_HIGH = 6;
const REVERSE = 7;
const CHANNEL_COUNT = 9;
const STORAGE_LAYOUT_VERSION = 10;
const STORAGE_LAYOUT = 11;

const OPCODE_START_RECORD = 1;
const OPCODE_STOP_RECORD = 2;
const OPCODE_PLAY = 3;
const OPCODE_STOP = 4;
const OPCODE_START_OVERDUB = 5;
const OPCODE_STOP_OVERDUB = 6;
const OPCODE_CLEAR = 7;
const OPCODE_SET_REVERSE = 8;
const OPCODE_SET_MONITOR = 9;
const OPCODE_SET_RHYTHM = 10;
const OPCODE_SET_BPM = 11;
const OPCODE_SET_CLOCK = 12;
const OPCODE_EXPORT_TRACK = 13;
const OPCODE_SET_ALIGNMENT = 14;
const OPCODE_CANCEL_PENDING = 15;

const STATUS_OK = 0;
const STATUS_LATE = 1;
const STATUS_MISSING_TRACK_STORAGE = 2;
const STATUS_TRACK_CAPACITY_REACHED = 3;
const STATUS_INVALID_STATE = 4;
const STATUS_COMMAND_OVERFLOW = 5;
const STATUS_CANCELLED = 6;
const STATUS_INVALID_TRACK = 7;
const STATE_EMPTY = 0;
const STATE_REC_STANDBY = 1;
const STATE_RECORDING = 2;
const STATE_REC_FINISHING = 3;
const STATE_PLAYING = 4;
const STATE_OVERDUBBING = 5;
const STATE_STOPPED = 6;

const CONTROL_HEADER_BYTES = 96;
const TRACK_META_BYTES = 64;
const FRAME_WORD_MODULUS = 0x100000000;
const TWO_PI = Math.PI * 2;

class BrowserLooperProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const controlBuffer = options.processorOptions && options.processorOptions.controlBuffer;
    if (!(controlBuffer instanceof SharedArrayBuffer)) {
      this.control = null;
      this.port.postMessage({ type: 'BOOT_ERROR', message: 'A shared realtime control buffer is required.' });
      return;
    }

    this.control = new Int32Array(controlBuffer);
    this.controlPositions = new Float32Array(controlBuffer, (TRACK_POSITIONS_WORD_OFFSET) * Int32Array.BYTES_PER_ELEMENT, TRACK_COUNT);
    this.deadlineMetricAvailable = typeof performance !== 'undefined' && typeof performance.now === 'function';
    Atomics.store(this.control, DEADLINE_METRIC_AVAILABLE, this.deadlineMetricAvailable ? 1 : 0);
    this.trackMeta = new Array(TRACK_COUNT).fill(null);
    this.trackDataLeft = new Array(TRACK_COUNT).fill(null);
    this.trackDataRight = new Array(TRACK_COUNT).fill(null);
    this.steadyTrackMeta = new Array(TRACK_COUNT).fill(null);
    this.steadyTrackDataLeft = new Array(TRACK_COUNT).fill(null);
    this.steadyTrackDataRight = new Array(TRACK_COUNT).fill(null);
    this.steadyTrackLeft = new Array(TRACK_COUNT).fill(null);
    this.steadyTrackRight = new Array(TRACK_COUNT).fill(null);
    this.steadyTrackLengths = new Int32Array(TRACK_COUNT);
    this.steadyTrackPositions = new Int32Array(TRACK_COUNT);
    this.steadyTrackSteps = new Int8Array(TRACK_COUNT);
    this.pendingCommands = new Int32Array(COMMAND_CAPACITY * COMMAND_WORDS);
    this.pendingCommandCount = 0;
    this.quantumFrames = 128;
    this.bpm = Math.max(40, Math.min(300, Atomics.load(this.control, BPM_WORD) || 120));
    this.outputMonitorEnabled = Atomics.load(this.control, OUTPUT_MONITOR_ENABLED) !== 0;

    this.rhythmRunning = Atomics.load(this.control, RHYTHM_RUNNING) !== 0;
    this.rhythmPattern = Math.max(0, Math.min(2, Atomics.load(this.control, RHYTHM_PATTERN)));
    this.rhythmNextStepFrame = -1;
    this.rhythmStep = 0;
    this.rhythmStepOrdinal = 0;
    this.rhythmOriginFrame = 0;
    this.kickPhase = 0;
    this.kickEnvelope = 0;
    this.kickFrequency = 150;
    this.snareEnvelope = 0;
    this.snareTonePhase = 0;
    this.hihatEnvelope = 0;
    this.noiseState = 0x51f15e;
    this.snareFilterState = 0;
    this.hihatFilterState = 0;

    this.clockRunning = false;
    this.clockOriginFrame = 0;
    this.clockBeatOrdinal = 0;
    this.clockNextBeatFrame = -1;

    this.calibrationMeta = null;
    this.calibrationData = null;
    this.calibrationStartFrame = 0;
    this.calibrationWriteIndex = 0;
    this.calibrationFrames = 0;
    this.calibrationActive = false;

    this.port.onmessage = (event) => this.handlePortMessage(event.data);
  }

  handlePortMessage(message) {
    if (!message || !this.control) return;

    if (message.type === 'ATTACH_TRACK') {
      const track = message.track | 0;
      const buffer = message.buffer;
      if (track < 0 || track >= TRACK_COUNT) return;
      const rejectAttach = (reason) => this.port.postMessage({
        type: 'TRACK_ATTACH_ERROR',
        track,
        message: reason,
        channelCount: message.channelCount ?? null,
        layoutVersion: message.layoutVersion ?? null,
        storageLayout: message.storageLayout ?? null,
      });
      if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength < TRACK_META_BYTES) {
        rejectAttach('Track storage is not a valid shared buffer with a complete metadata header.');
        return;
      }
      const meta = new Int32Array(buffer, 0, TRACK_META_WORDS);
      const capacity = Atomics.load(meta, CAPACITY_FRAMES);
      const channelCount = Atomics.load(meta, CHANNEL_COUNT);
      const layoutVersion = Atomics.load(meta, STORAGE_LAYOUT_VERSION);
      const storageLayout = Atomics.load(meta, STORAGE_LAYOUT);
      const expectedBytes = TRACK_META_BYTES + capacity * TRACK_CHANNEL_COUNT * Float32Array.BYTES_PER_ELEMENT;
      if (channelCount !== TRACK_CHANNEL_COUNT || layoutVersion !== LAYOUT_VERSION || storageLayout !== LAYOUT_PLANAR_LR ||
          capacity <= 0 || buffer.byteLength !== expectedBytes ||
          message.channelCount !== TRACK_CHANNEL_COUNT || message.layoutVersion !== LAYOUT_VERSION ||
          message.storageLayout !== LAYOUT_PLANAR_LR) {
        rejectAttach(`Track layout mismatch: requires ${TRACK_CHANNEL_COUNT}-channel planar LR storage v${LAYOUT_VERSION}.`);
        return;
      }
      this.trackMeta[track] = meta;
      this.trackDataLeft[track] = new Float32Array(buffer, TRACK_META_BYTES, capacity);
      this.trackDataRight[track] = new Float32Array(
        buffer,
        TRACK_META_BYTES + capacity * Float32Array.BYTES_PER_ELEMENT,
        capacity,
      );
      this.port.postMessage({
        type: 'TRACK_ATTACHED',
        track,
        channelCount,
        layoutVersion,
        storageLayout,
      });
      return;
    }

    if (message.type === 'ARM_LOOPBACK') {
      const buffer = message.buffer;
      if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength < TRACK_META_BYTES) {
        this.port.postMessage({ type: 'LOOPBACK_ARM_ERROR', message: 'Loopback storage is not a valid shared buffer.' });
        return;
      }
      const meta = new Int32Array(buffer, 0, TRACK_META_WORDS);
      const capacity = Atomics.load(meta, CAPACITY_FRAMES);
      const requestedFrames = Number(message.frames);
      if (Atomics.load(meta, CHANNEL_COUNT) !== 1 || Atomics.load(meta, STORAGE_LAYOUT_VERSION) !== LAYOUT_VERSION ||
          Atomics.load(meta, STORAGE_LAYOUT) !== LAYOUT_MONO ||
          buffer.byteLength !== TRACK_META_BYTES + capacity * Float32Array.BYTES_PER_ELEMENT ||
          !Number.isInteger(requestedFrames) || requestedFrames <= 0 || requestedFrames > capacity) {
        this.port.postMessage({ type: 'LOOPBACK_ARM_ERROR', message: 'Loopback storage must use the versioned mono layout.' });
        return;
      }
      this.calibrationMeta = meta;
      this.calibrationData = new Float32Array(buffer, TRACK_META_BYTES, capacity);
      this.calibrationStartFrame = Number(message.startFrame) || 0;
      this.calibrationFrames = requestedFrames;
      this.calibrationWriteIndex = 0;
      this.calibrationActive = this.calibrationFrames > 0;
      Atomics.store(meta, RECORDING_FRAMES, 0);
      Atomics.store(meta, LOOP_FRAMES, 0);
      this.port.postMessage({ type: 'LOOPBACK_ARMED', frames: requestedFrames });
    }
  }

  process(inputs, outputs) {
    if (!this.control) return true;

    const startedAt = this.deadlineMetricAvailable ? performance.now() : 0;
    const blockStartFrame = currentFrame;
    const input = inputs[0];
    const inputLeft = input && input.length > 0 ? input[0] : null;
    const inputRight = input && input.length > 1 ? input[1] : inputLeft;
    const frames = outputs[0] && outputs[0][0] ? outputs[0][0].length : 128;
    const rightChannel = inputRight && inputRight.length >= frames;
    const leftChannel = inputLeft && inputLeft.length >= frames;
    const hasInput = Boolean(leftChannel || rightChannel);
    const inputLeftSamples = inputLeft;

    this.quantumFrames = frames;
    this.drainCommands();

    let inputWasMissingWhileRecording = false;
    if (this.prepareSteadyPlayback(outputs)) {
      this.processSteadyPlaybackBlock(outputs, frames, blockStartFrame);
    } else {
      for (let offset = 0; offset < frames; offset += 1) {
        const frame = blockStartFrame + offset;
        if (this.pendingCommandCount > 0) this.executeDueCommands(frame);

        let inputSampleLeft = 0;
        let inputSampleRight = 0;
        if (hasInput) {
          inputSampleLeft = leftChannel ? inputLeftSamples[offset] : inputRight[offset];
          inputSampleRight = rightChannel ? inputRight[offset] : inputSampleLeft;
        }

        if (this.calibrationActive && frame >= this.calibrationStartFrame) {
          if (this.calibrationWriteIndex < this.calibrationFrames) {
            this.calibrationData[this.calibrationWriteIndex] = (inputSampleLeft + inputSampleRight) * 0.5;
            this.calibrationWriteIndex += 1;
            this.calibrationMeta[RECORDING_FRAMES] = this.calibrationWriteIndex;
          }
          if (this.calibrationWriteIndex >= this.calibrationFrames) {
            this.calibrationActive = false;
            Atomics.store(this.calibrationMeta, LOOP_FRAMES, this.calibrationWriteIndex);
            this.port.postMessage({
              type: 'LOOPBACK_CAPTURE_COMPLETE',
              frames: this.calibrationWriteIndex,
              startFrame: this.calibrationStartFrame,
            });
          }
        }

        const monitorLeft = outputs[5] && outputs[5][0];
        const monitorRight = outputs[5] && outputs[5][1];
        if (monitorLeft) monitorLeft[offset] = this.outputMonitorEnabled ? inputSampleLeft : 0;
        if (monitorRight) monitorRight[offset] = this.outputMonitorEnabled ? inputSampleRight : 0;

        for (let track = 0; track < TRACK_COUNT; track += 1) {
          const meta = this.trackMeta[track];
          const dataLeft = this.trackDataLeft[track];
          const dataRight = this.trackDataRight[track];
          const leftOut = outputs[track] && outputs[track][0];
          const rightOut = outputs[track] && outputs[track][1];
          if (!leftOut && !rightOut) continue;

          let sampleLeft = 0;
          let sampleRight = 0;
          if (meta && dataLeft && dataRight) {
            const state = meta[TRACK_STATE];
            if (state === STATE_RECORDING) {
              const writeIndex = meta[RECORDING_FRAMES];
              const capacity = meta[CAPACITY_FRAMES];
              if (writeIndex < capacity) {
                dataLeft[writeIndex] = inputSampleLeft;
                dataRight[writeIndex] = inputSampleRight;
                meta[RECORDING_FRAMES] = writeIndex + 1;
                if (!hasInput) inputWasMissingWhileRecording = true;
              } else {
                Atomics.store(meta, TRACK_STATE, STATE_PLAYING);
                Atomics.store(meta, LOOP_FRAMES, capacity);
                Atomics.add(this.control, TRACK_CAPACITY_OVERRUNS, 1);
                this.port.postMessage({ type: 'TRACK_CAPACITY_REACHED', track, frame });
              }
            }

            const playbackState = meta[TRACK_STATE];
            const length = meta[LOOP_FRAMES];
            if ((playbackState === STATE_PLAYING || playbackState === STATE_OVERDUBBING) && length > 0) {
              let position = meta[PLAY_POSITION];
              if (position < 0 || position >= length) position = 0;
              sampleLeft = dataLeft[position] || 0;
              sampleRight = dataRight[position] || 0;

              if (playbackState === STATE_OVERDUBBING && hasInput) {
                const correction = Math.round(meta[8] || 0);
                let writePosition = position + (meta[REVERSE] !== 0 ? correction : -correction);
                writePosition %= length;
                if (writePosition < 0) writePosition += length;
                dataLeft[writePosition] += inputSampleLeft;
                dataRight[writePosition] += inputSampleRight;
              }
              if (playbackState === STATE_OVERDUBBING && !hasInput) inputWasMissingWhileRecording = true;

              position += meta[REVERSE] !== 0 ? -1 : 1;
              if (position >= length) position = 0;
              else if (position < 0) position = length - 1;
              meta[PLAY_POSITION] = position;
            }
          }

          if (leftOut) leftOut[offset] = sampleLeft;
          if (rightOut) rightOut[offset] = sampleRight;
        }

        const rhythmSample = this.renderRhythmSample(frame);
        const rhythmLeft = outputs[6] && outputs[6][0];
        const rhythmRight = outputs[6] && outputs[6][1];
        if (rhythmLeft) rhythmLeft[offset] = rhythmSample;
        if (rhythmRight) rhythmRight[offset] = rhythmSample;

        this.renderClockTick(frame);
      }
    }

    if (inputWasMissingWhileRecording) {
      Atomics.add(this.control, UNDERRUNS, 1);
      Atomics.add(this.control, INPUT_DROPOUT_BLOCKS, 1);
    }

    for (let track = 0; track < TRACK_COUNT; track += 1) {
      const meta = this.trackMeta[track];
      const loopFrames = meta ? meta[LOOP_FRAMES] : 0;
      const recordingFrames = meta ? meta[RECORDING_FRAMES] : 0;
      const state = meta ? meta[TRACK_STATE] : STATE_EMPTY;
      const position = meta ? meta[PLAY_POSITION] : 0;
      this.control[TRACK_STATES_WORD_OFFSET + track] = this.toUiState(state);
      this.controlPositions[track] = loopFrames > 0 && (state === STATE_PLAYING || state === STATE_OVERDUBBING)
        ? position / loopFrames
        : 0;
    }

    this.storeFrame(RENDER_FRAME_SEQUENCE, RENDER_FRAME_LOW, RENDER_FRAME_HIGH, blockStartFrame + frames);
    Atomics.store(this.control, LAST_QUANTUM_FRAMES, frames);

    if (this.deadlineMetricAvailable) {
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs > (frames / sampleRate) * 1000) {
        Atomics.add(this.control, DEADLINE_MISSES, 1);
      }
    }

    return true;
  }

  prepareSteadyPlayback(outputs) {
    if (this.pendingCommandCount > 0 || this.calibrationActive || this.outputMonitorEnabled || this.rhythmRunning) return false;

    for (let track = 0; track < TRACK_COUNT; track += 1) {
      const meta = this.trackMeta[track];
      const dataLeft = this.trackDataLeft[track];
      const dataRight = this.trackDataRight[track];
      const output = outputs[track];
      const left = output && output[0] ? output[0] : null;
      const right = output && output[1] ? output[1] : null;
      if (!meta) return false;
      const state = meta[TRACK_STATE];
      const length = meta ? meta[LOOP_FRAMES] : 0;
      if (state !== STATE_PLAYING && state !== STATE_EMPTY && state !== STATE_STOPPED) return false;
      if (state === STATE_PLAYING && (!dataLeft || !dataRight || (!left && !right) || length <= 0)) return false;

      const rawPosition = meta[PLAY_POSITION];
      this.steadyTrackMeta[track] = meta;
      this.steadyTrackDataLeft[track] = state === STATE_PLAYING ? dataLeft : null;
      this.steadyTrackDataRight[track] = state === STATE_PLAYING ? dataRight : null;
      this.steadyTrackLeft[track] = left;
      this.steadyTrackRight[track] = right;
      this.steadyTrackLengths[track] = state === STATE_PLAYING ? length : 0;
      this.steadyTrackPositions[track] = state !== STATE_PLAYING || rawPosition < 0 || rawPosition >= length ? 0 : rawPosition;
      this.steadyTrackSteps[track] = state === STATE_PLAYING && meta[REVERSE] !== 0 ? -1 : 1;
    }

    return true;
  }

  processSteadyPlaybackBlock(outputs, frames, blockStartFrame) {
    const monitor = outputs[5];
    const rhythm = outputs[6];
    if (monitor && monitor[0]) monitor[0].fill(0, 0, frames);
    if (monitor && monitor[1]) monitor[1].fill(0, 0, frames);
    if (rhythm && rhythm[0]) rhythm[0].fill(0, 0, frames);
    if (rhythm && rhythm[1]) rhythm[1].fill(0, 0, frames);

    for (let offset = 0; offset < frames; offset += 1) {
      for (let track = 0; track < TRACK_COUNT; track += 1) {
        const length = this.steadyTrackLengths[track];
        let sampleLeft = 0;
        let sampleRight = 0;
        if (length > 0) {
          const position = this.steadyTrackPositions[track];
          sampleLeft = this.steadyTrackDataLeft[track][position] || 0;
          sampleRight = this.steadyTrackDataRight[track][position] || 0;
          let nextPosition = position + this.steadyTrackSteps[track];
          if (nextPosition >= length) nextPosition = 0;
          else if (nextPosition < 0) nextPosition = length - 1;
          this.steadyTrackPositions[track] = nextPosition;
          this.steadyTrackMeta[track][PLAY_POSITION] = nextPosition;
        }

        const left = this.steadyTrackLeft[track];
        const right = this.steadyTrackRight[track];
        if (left) left[offset] = sampleLeft;
        if (right) right[offset] = sampleRight;
      }
      if (this.clockRunning) this.renderClockTick(blockStartFrame + offset);
    }
  }

  drainCommands() {
    let read = Atomics.load(this.control, COMMAND_READ);
    const write = Atomics.load(this.control, COMMAND_WRITE);
    while (read !== write && this.pendingCommandCount < COMMAND_CAPACITY) {
      const ringOffset = COMMAND_WORD_OFFSET + (read % COMMAND_CAPACITY) * COMMAND_WORDS;
      const commandOffset = this.pendingCommandCount * COMMAND_WORDS;
      const sequence = Atomics.load(this.control, ringOffset);
      const opcode = Atomics.load(this.control, ringOffset + 1);
      const track = Atomics.load(this.control, ringOffset + 2);
      const frameLow = Atomics.load(this.control, ringOffset + 3);
      const frameHigh = Atomics.load(this.control, ringOffset + 4);
      const arg0 = Atomics.load(this.control, ringOffset + 5);
      const arg1 = Atomics.load(this.control, ringOffset + 6);
      const flags = Atomics.load(this.control, ringOffset + 7);
      this.insertPendingCommand(sequence, opcode, track, frameLow, frameHigh, arg0, arg1, flags);
      read += 1;
    }
    Atomics.store(this.control, COMMAND_READ, read);
  }

  insertPendingCommand(sequence, opcode, track, frameLow, frameHigh, arg0, arg1, flags) {
    if (this.pendingCommandCount >= COMMAND_CAPACITY) {
      Atomics.add(this.control, COMMAND_OVERRUNS, 1);
      this.acknowledge(sequence, opcode, track, currentFrame, this.frameFromWords(frameLow, frameHigh), STATUS_COMMAND_OVERFLOW, 0, 0);
      return;
    }

    let insertAt = this.pendingCommandCount;
    while (insertAt > 0) {
      const previous = (insertAt - 1) * COMMAND_WORDS;
      const previousFrame = this.frameFromWords(this.pendingCommands[previous + 3], this.pendingCommands[previous + 4]);
      const nextFrame = this.frameFromWords(frameLow, frameHigh);
      if (previousFrame <= nextFrame) break;
      const destination = insertAt * COMMAND_WORDS;
      for (let field = 0; field < COMMAND_WORDS; field += 1) {
        this.pendingCommands[destination + field] = this.pendingCommands[previous + field];
      }
      insertAt -= 1;
    }

    const commandOffset = insertAt * COMMAND_WORDS;
    this.pendingCommands[commandOffset] = sequence;
    this.pendingCommands[commandOffset + 1] = opcode;
    this.pendingCommands[commandOffset + 2] = track;
    this.pendingCommands[commandOffset + 3] = frameLow;
    this.pendingCommands[commandOffset + 4] = frameHigh;
    this.pendingCommands[commandOffset + 5] = arg0;
    this.pendingCommands[commandOffset + 6] = arg1;
    this.pendingCommands[commandOffset + 7] = flags;
    this.pendingCommandCount += 1;
  }

  executeDueCommands(frame) {
    while (this.pendingCommandCount > 0) {
      const target = this.frameFromWords(this.pendingCommands[3], this.pendingCommands[4]);
      if (target > frame) return;

      const sequence = this.pendingCommands[0];
      const opcode = this.pendingCommands[1];
      const track = this.pendingCommands[2];
      const arg0 = this.pendingCommands[5];
      const arg1 = this.pendingCommands[6];
      const late = target < frame;
      let status = late ? STATUS_LATE : STATUS_OK;
      let loopFrames = 0;
      let recordingFrames = 0;

      if (opcode === OPCODE_SET_MONITOR) {
        this.outputMonitorEnabled = arg0 !== 0;
        Atomics.store(this.control, OUTPUT_MONITOR_ENABLED, this.outputMonitorEnabled ? 1 : 0);
      } else if (opcode === OPCODE_SET_RHYTHM) {
        this.rhythmRunning = arg0 !== 0;
        this.rhythmPattern = Math.max(0, Math.min(2, arg1));
        Atomics.store(this.control, RHYTHM_RUNNING, this.rhythmRunning ? 1 : 0);
        Atomics.store(this.control, RHYTHM_PATTERN, this.rhythmPattern);
        this.rhythmOriginFrame = frame;
        this.rhythmStepOrdinal = 0;
        this.rhythmNextStepFrame = this.rhythmRunning ? frame : -1;
        this.rhythmStep = 0;
      } else if (opcode === OPCODE_SET_BPM) {
        this.bpm = Math.max(40, Math.min(300, arg0));
        Atomics.store(this.control, BPM_WORD, this.bpm);
        if (this.clockRunning) {
          this.clockOriginFrame = frame;
          this.clockBeatOrdinal = 0;
          this.clockNextBeatFrame = frame;
        }
        if (this.rhythmRunning) {
          this.rhythmOriginFrame = frame;
          this.rhythmStepOrdinal = 0;
          this.rhythmStep = 0;
          this.rhythmNextStepFrame = frame;
        }
      } else if (opcode === OPCODE_SET_CLOCK) {
        this.clockRunning = arg0 !== 0;
        if (this.clockRunning) {
          this.clockOriginFrame = frame;
          this.clockBeatOrdinal = 0;
          this.clockNextBeatFrame = frame;
        } else {
          this.clockNextBeatFrame = -1;
        }
      } else {
        const validTrack = track >= 0 && track < TRACK_COUNT;
        const meta = validTrack ? this.trackMeta[track] : null;
        const dataLeft = validTrack ? this.trackDataLeft[track] : null;
        const dataRight = validTrack ? this.trackDataRight[track] : null;
        if (!validTrack) {
          status = STATUS_INVALID_TRACK;
        } else if (!meta || !dataLeft || !dataRight) {
          status = STATUS_MISSING_TRACK_STORAGE;
        } else if (opcode === OPCODE_START_RECORD) {
          meta[TRACK_STATE] = STATE_RECORDING;
          meta[LOOP_FRAMES] = 0;
          meta[RECORDING_FRAMES] = 0;
          meta[PLAY_POSITION] = 0;
          this.storeTrackStartFrame(meta, frame);
        } else if (opcode === OPCODE_STOP_RECORD) {
          if (meta[TRACK_STATE] !== STATE_RECORDING) {
            status = STATUS_INVALID_STATE;
          } else {
            recordingFrames = meta[RECORDING_FRAMES];
            loopFrames = recordingFrames;
            meta[LOOP_FRAMES] = loopFrames;
            meta[PLAY_POSITION] = meta[REVERSE] !== 0 && loopFrames > 0 ? loopFrames - 1 : 0;
            meta[TRACK_STATE] = loopFrames > 0 && arg0 !== 0 ? STATE_PLAYING : STATE_STOPPED;
          }
        } else if (opcode === OPCODE_PLAY) {
          if (meta[LOOP_FRAMES] <= 0) {
            status = STATUS_INVALID_STATE;
          } else {
            if (arg0 !== 0) meta[PLAY_POSITION] = meta[REVERSE] !== 0 ? meta[LOOP_FRAMES] - 1 : 0;
            meta[TRACK_STATE] = STATE_PLAYING;
          }
        } else if (opcode === OPCODE_STOP) {
          if (meta[TRACK_STATE] === STATE_RECORDING) {
            status = STATUS_INVALID_STATE;
          } else {
            meta[TRACK_STATE] = meta[LOOP_FRAMES] > 0 ? STATE_STOPPED : STATE_EMPTY;
          }
        } else if (opcode === OPCODE_START_OVERDUB) {
          if (meta[TRACK_STATE] !== STATE_PLAYING) {
            status = STATUS_INVALID_STATE;
          } else {
            meta[TRACK_STATE] = STATE_OVERDUBBING;
          }
        } else if (opcode === OPCODE_STOP_OVERDUB) {
          if (meta[TRACK_STATE] !== STATE_OVERDUBBING) {
            status = STATUS_INVALID_STATE;
          } else {
            meta[TRACK_STATE] = STATE_PLAYING;
          }
        } else if (opcode === OPCODE_CLEAR) {
          meta[TRACK_STATE] = STATE_EMPTY;
          meta[LOOP_FRAMES] = 0;
          meta[RECORDING_FRAMES] = 0;
          meta[PLAY_POSITION] = 0;
          meta[REVERSE] = 0;
        } else if (opcode === OPCODE_SET_REVERSE) {
          meta[REVERSE] = arg0 !== 0 ? 1 : 0;
      } else if (opcode === OPCODE_SET_ALIGNMENT) {
          meta[8] = arg0;
        } else if (opcode === OPCODE_CANCEL_PENDING) {
          this.cancelPendingTrackCommands(track, frame);
        } else if (opcode === OPCODE_EXPORT_TRACK) {
          if (meta[TRACK_STATE] === STATE_RECORDING || meta[TRACK_STATE] === STATE_OVERDUBBING) {
            status = STATUS_INVALID_STATE;
          }
        } else {
          status = STATUS_INVALID_STATE;
        }
        if (meta) {
          loopFrames = meta[LOOP_FRAMES];
          recordingFrames = meta[RECORDING_FRAMES];
        }
      }

      this.acknowledge(sequence, opcode, track, frame, target, status, loopFrames, recordingFrames);
      this.removeFirstPendingCommand();
    }
  }

  removeFirstPendingCommand() {
    this.pendingCommandCount -= 1;
    for (let index = 0; index < this.pendingCommandCount * COMMAND_WORDS; index += 1) {
      this.pendingCommands[index] = this.pendingCommands[index + COMMAND_WORDS];
    }
  }

  cancelPendingTrackCommands(track, frame) {
    let index = 1;
    while (index < this.pendingCommandCount) {
      const offset = index * COMMAND_WORDS;
      const pendingTrack = this.pendingCommands[offset + 2];
      const pendingOpcode = this.pendingCommands[offset + 1];
      const targetFrame = this.frameFromWords(this.pendingCommands[offset + 3], this.pendingCommands[offset + 4]);
      const canCancel = pendingTrack === track && targetFrame > frame &&
        (pendingOpcode === OPCODE_START_RECORD || pendingOpcode === OPCODE_STOP_RECORD);
      if (!canCancel) {
        index += 1;
        continue;
      }

      this.acknowledge(
        this.pendingCommands[offset],
        pendingOpcode,
        track,
        frame,
        targetFrame,
        STATUS_CANCELLED,
        0,
        0,
      );
      this.pendingCommandCount -= 1;
      const end = this.pendingCommandCount * COMMAND_WORDS;
      for (let word = offset; word < end; word += 1) {
        this.pendingCommands[word] = this.pendingCommands[word + COMMAND_WORDS];
      }
    }
  }

  acknowledge(sequence, opcode, track, frame, targetFrame, status, loopFrames, recordingFrames) {
    this.storeFrame(LAST_ACK_FRAME_SEQUENCE, LAST_ACK_FRAME_LOW, LAST_ACK_FRAME_HIGH, frame);
    Atomics.store(this.control, LAST_ACK_SEQUENCE, sequence);
    this.port.postMessage({
      type: 'ACK',
      sequence: sequence >>> 0,
      opcode,
      track,
      executedFrame: frame,
      targetFrame,
      status,
      loopFrames,
      recordingFrames,
    });
  }

  renderRhythmSample(frame) {
    if (!this.rhythmRunning) return 0;
    if (this.rhythmNextStepFrame < 0) this.rhythmNextStepFrame = frame;
    if (frame >= this.rhythmNextStepFrame) {
      this.triggerRhythmStep(this.rhythmPattern, this.rhythmStep);
      this.rhythmStep = (this.rhythmStep + 1) & 15;
      this.rhythmStepOrdinal += 1;
      this.rhythmNextStepFrame = this.rhythmOriginFrame + Math.round(this.rhythmStepOrdinal * sampleRate * 15 / this.bpm);
    }

    let sample = 0;
    if (this.kickEnvelope > 0.00001) {
      this.kickPhase += TWO_PI * this.kickFrequency / sampleRate;
      if (this.kickPhase > TWO_PI) this.kickPhase -= TWO_PI;
      this.kickFrequency = 48 + 102 * this.kickEnvelope;
      sample += Math.sin(this.kickPhase) * this.kickEnvelope * 0.85;
      this.kickEnvelope *= 0.99955;
    }

    if (this.snareEnvelope > 0.00001) {
      this.snareTonePhase += TWO_PI * 180 / sampleRate;
      if (this.snareTonePhase > TWO_PI) this.snareTonePhase -= TWO_PI;
      const noise = this.nextNoise();
      this.snareFilterState += 0.08 * (noise - this.snareFilterState);
      const highNoise = noise - this.snareFilterState;
      sample += (highNoise * 0.75 + Math.sin(this.snareTonePhase) * 0.25) * this.snareEnvelope;
      this.snareEnvelope *= 0.99925;
    }

    if (this.hihatEnvelope > 0.00001) {
      const noise = this.nextNoise();
      this.hihatFilterState += 0.28 * (noise - this.hihatFilterState);
      sample += (noise - this.hihatFilterState) * this.hihatEnvelope * 0.28;
      this.hihatEnvelope *= 0.9971;
    }

    return sample;
  }

  triggerRhythmStep(pattern, step) {
    let kick = false;
    let snare = false;
    let hihat = false;
    if (pattern === 0) {
      kick = step === 0 || step === 6 || step === 8;
      snare = step === 4 || step === 12;
      hihat = (step & 1) === 0;
    } else if (pattern === 1) {
      kick = step === 0 || step === 4 || step === 8 || step === 12;
      snare = step === 4 || step === 12;
      hihat = step === 2 || step === 6 || step === 10 || step === 14;
    } else {
      kick = step === 0;
      snare = step === 4 || step === 8 || step === 12;
    }

    if (kick) {
      this.kickEnvelope = 1;
      this.kickFrequency = 150;
    }
    if (snare) {
      this.snareEnvelope = 1;
    }
    if (hihat) {
      this.hihatEnvelope = 1;
    }
  }

  renderClockTick(frame) {
    if (!this.clockRunning) return;
    if (this.clockNextBeatFrame < 0) this.clockNextBeatFrame = frame;
    if (frame >= this.clockNextBeatFrame) {
      this.port.postMessage({
        type: 'CLOCK_TICK',
        beatOrdinal: this.clockBeatOrdinal,
        frame,
      });
      this.clockBeatOrdinal += 1;
      this.clockNextBeatFrame = this.clockOriginFrame + Math.round(this.clockBeatOrdinal * sampleRate * 60 / this.bpm);
    }
  }

  nextNoise() {
    let state = this.noiseState;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    this.noiseState = state;
    return ((state >>> 0) / 2147483648) - 1;
  }

  toUiState(state) {
    if (state === STATE_REC_STANDBY) return 1;
    if (state === STATE_RECORDING) return 2;
    if (state === STATE_REC_FINISHING) return 3;
    if (state === STATE_PLAYING) return 4;
    if (state === STATE_OVERDUBBING) return 5;
    if (state === STATE_STOPPED) return 6;
    return 0;
  }

  storeFrame(sequenceWord, lowWord, highWord, frame) {
    const sequence = Atomics.load(this.control, sequenceWord);
    const odd = (sequence & 1) === 0 ? sequence + 1 : sequence + 2;
    Atomics.store(this.control, sequenceWord, odd);
    const high = Math.floor(frame / FRAME_WORD_MODULUS);
    const low = frame - high * FRAME_WORD_MODULUS;
    Atomics.store(this.control, lowWord, low | 0);
    Atomics.store(this.control, highWord, high | 0);
    Atomics.store(this.control, sequenceWord, odd + 1);
  }

  storeTrackStartFrame(meta, frame) {
    const high = Math.floor(frame / FRAME_WORD_MODULUS);
    const low = frame - high * FRAME_WORD_MODULUS;
    meta[RECORD_START_LOW] = low | 0;
    meta[RECORD_START_HIGH] = high | 0;
  }

  frameFromWords(low, high) {
    return (high >>> 0) * FRAME_WORD_MODULUS + (low >>> 0);
  }
}

registerProcessor('webrc505-realtime', BrowserLooperProcessor);
