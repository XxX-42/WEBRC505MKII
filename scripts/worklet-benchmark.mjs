import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`Synthetic Node/V8 benchmark for the actual AudioWorklet processor source. No hardware or browser callback is opened.\n\nUsage:\n  node scripts/worklet-benchmark.mjs [--iterations 10000] [--warmup 1000] [--burst-samples 100] [--phase-minutes 30]\n\nDefault runs five-track 48 kHz / 128-frame REC, PLAY, overdub, Clear, Record, command-burst and protocol assertions.\n--phase-minutes opts into an actual accelerated VM process-loop simulation; it is still not a real 30-minute device run.\nOutputs are written below the system TEMP directory.\n`);
  process.exit(0);
}

const sampleRate = 48_000;
const quantumFrames = 128;
const iterations = parsePositiveInt(args.iterations ?? '10000', '--iterations', 100_000);
const warmup = parsePositiveInt(args.warmup ?? '1000', '--warmup', 100_000);
const burstSamples = parsePositiveInt(args.burstSamples ?? '100', '--burst-samples', 10_000);
const burstWarmup = parsePositiveInt(args.burstWarmup ?? '10', '--burst-warmup', 1_000);
const phaseMinutes = parseNonNegativeInt(args.phaseMinutes ?? '0', '--phase-minutes', 120);
const phaseYieldBlocks = parsePositiveInt(args.phaseYieldBlocks ?? '256', '--phase-yield-blocks', 100_000);
const phaseYieldMs = parseNonNegativeInt(args.phaseYieldMs ?? '5', '--phase-yield-ms', 60_000);
const tempRoot = path.resolve(os.tmpdir());
const outputRoot = path.resolve(args.outputDir ?? path.join(
  tempRoot,
  `webrc-worklet-bench-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomBytes(4).toString('hex')}`,
));
if (!isWithin(tempRoot, outputRoot)) throw new Error(`Output directory must be under the system TEMP directory: ${outputRoot}`);
fs.mkdirSync(outputRoot, { recursive: true });

const require = createRequire(pathToFileURL(path.join(repoRoot, 'package.json')));
const typescript = require('typescript');
const protocolSourcePath = path.join(repoRoot, 'src', 'audio', 'browserRealtimeProtocol.ts');
const workletSourcePath = path.join(repoRoot, 'public', 'worklets', 'looper-processor.js');
const protocolSource = fs.readFileSync(protocolSourcePath, 'utf8');
const workletSource = fs.readFileSync(workletSourcePath, 'utf8');
const protocol = loadProtocolExports(protocolSource, protocolSourcePath, typescript);
const protocolAudit = auditProtocolMirror(protocol, workletSource, workletSourcePath);

if (args.auditOnly) {
  process.stdout.write(JSON.stringify({ protocolAudit, workletSourcePath, protocolSourcePath }, null, 2) + '\n');
  process.exit(0);
}

if (sampleRate !== protocol.BROWSER_REALTIME_SAMPLE_RATE || quantumFrames !== protocol.BROWSER_REALTIME_QUANTUM_FRAMES) {
  throw new Error('Benchmark configuration must match the exported 48 kHz / 128-frame protocol.');
}

const status = protocol.BrowserRealtimeStatus;
const opcode = protocol.BrowserRealtimeOpcode;
const controlWord = protocol.ControlWord;
const trackWord = protocol.TrackMetaWord;
const trackCount = protocol.BROWSER_REALTIME_TRACK_COUNT;
const processorState = {
  EMPTY: readWorkletIntegerConstant(workletSource, 'STATE_EMPTY', workletSourcePath),
  REC_STANDBY: readWorkletIntegerConstant(workletSource, 'STATE_REC_STANDBY', workletSourcePath),
  RECORDING: readWorkletIntegerConstant(workletSource, 'STATE_RECORDING', workletSourcePath),
  REC_FINISHING: readWorkletIntegerConstant(workletSource, 'STATE_REC_FINISHING', workletSourcePath),
  PLAYING: readWorkletIntegerConstant(workletSource, 'STATE_PLAYING', workletSourcePath),
  OVERDUBBING: readWorkletIntegerConstant(workletSource, 'STATE_OVERDUBBING', workletSourcePath),
  STOPPED: readWorkletIntegerConstant(workletSource, 'STATE_STOPPED', workletSourcePath),
};
const loopLengths = [127, 131, 137, 139, 149];
if (loopLengths.length !== trackCount || loopLengths.some((length) => length === quantumFrames || quantumFrames % length === 0)) {
  throw new Error('Phase loop lengths must be distinct non-divisors of the audio quantum.');
}

const runStartedAt = new Date().toISOString();
const scenarioResults = [];
const rawSamples = [];
const diagnostics = [];

scenarioResults.push(runSteadyScenario('five_track_record', 'record', iterations, warmup));
scenarioResults.push(runSteadyScenario('five_track_playback', 'play', iterations, warmup));
scenarioResults.push(runSteadyScenario('five_track_overdub', 'overdub', iterations, warmup));
scenarioResults.push(runCommandScenario('clear_five_tracks', opcode.CLEAR, iterations, warmup));
scenarioResults.push(runCommandScenario('record_start_five_tracks', opcode.START_RECORD, iterations, warmup));
scenarioResults.push(runCommandBurstScenario(burstSamples, burstWarmup));
diagnostics.push(runProtocolBehaviorAssertions());
if (phaseMinutes > 0) {
  diagnostics.push(await runLongPlaybackPhaseSimulation(phaseMinutes, phaseYieldBlocks, phaseYieldMs));
}

for (const result of scenarioResults) {
  for (let index = 0; index < result.samplesMs.length; index += 1) {
    rawSamples.push({
      scenario: result.scenario,
      sampleIndex: index + 1,
      elapsedMs: result.samplesMs[index],
      quantumFrames,
      sampleRate,
      blockStartFrame: result.firstMeasuredFrame + index * quantumFrames,
    });
  }
}

const report = {
  diagnosticStatus: diagnostics.some((item) => Number(item.assertionErrors ?? 0) > 0) ? 'FAILED' : 'PASS',
  diagnosticStatusScope: 'PASS/FAILED reflects source/protocol/state/phase assertions only; Node deadline counters are reported separately and no hardware qualification is implied.',
  qualificationStatus: 'NOT_HARDWARE_QUALIFIED',
  benchmark: 'Actual public/worklets/looper-processor.js process() in a Node vm AudioWorkletProcessor stub; synthetic V8 only',
  startedAt: runStartedAt,
  completedAt: new Date().toISOString(),
  sampleRate,
  quantumFrames,
  blockBudgetMs: quantumFrames / sampleRate * 1000,
  measuredIterationsPerSteadyScenario: iterations,
  warmupBlocksPerSteadyScenario: warmup,
  commandBurstSamples: burstSamples,
  commandBurstWarmupBlocks: burstWarmup,
  loopFramesForPhaseChecks: loopLengths,
  timer: 'Node perf_hooks.performance.now() around processor.process(); includes vm call edge, excludes queue/setup, verification and host-yield time',
  limitations: [
    'This is accelerated/synthetic Node V8 execution, not a Chromium AudioWorklet callback measurement.',
    'The processor-reported deadline counter uses Node performance.now() and does not represent device XRUNs.',
    'A 30-minute phase run, when requested, processes the real worklet callback against synthetic sample buffers with sampleFrame advanced rapidly; it is not 30 minutes of wall time or a hardware stability test.',
    'No microphone, render endpoint, loopback, or physical audio stream is opened.',
  ],
  protocolAudit,
  scenarios: scenarioResults.map(({ samplesMs: _samplesMs, ...summary }) => summary),
  diagnostics,
};

const rawPath = path.join(outputRoot, 'raw-results.json');
const samplesCsvPath = path.join(outputRoot, 'process-samples.csv');
const summaryCsvPath = path.join(outputRoot, 'summary.csv');
const phaseSummary = diagnostics.find((item) => item.name === 'accelerated_vm_playback_phase') ?? null;
const phaseSummaryCsvPath = phaseSummary ? path.join(outputRoot, 'phase-summary.csv') : null;
const reproPath = path.join(outputRoot, 'repro-command.ps1');
fs.writeFileSync(rawPath, JSON.stringify({ ...report, processSampleCount: rawSamples.length, processSamplesMs: scenarioResults.map((scenario) => ({ scenario: scenario.scenario, samplesMs: scenario.samplesMs })) }, null, 2), 'utf8');
fs.writeFileSync(samplesCsvPath, toCsv(rawSamples), 'utf8');
fs.writeFileSync(summaryCsvPath, toCsv(report.scenarios), 'utf8');
if (phaseSummaryCsvPath) fs.writeFileSync(phaseSummaryCsvPath, toCsv([phaseSummary]), 'utf8');
const phaseArgs = phaseMinutes > 0 ? ` --phase-minutes ${phaseMinutes} --phase-yield-blocks ${phaseYieldBlocks} --phase-yield-ms ${phaseYieldMs}` : '';
const escapedRoot = repoRoot.replaceAll("'", "''");
fs.writeFileSync(reproPath,
  `Set-Location '${escapedRoot}'\nnode scripts/worklet-benchmark.mjs --iterations ${iterations} --warmup ${warmup} --burst-samples ${burstSamples} --burst-warmup ${burstWarmup}${phaseArgs}\n`,
  'utf8',
);
process.stdout.write(JSON.stringify({ diagnosticStatus: report.diagnosticStatus, diagnosticStatusScope: report.diagnosticStatusScope, qualificationStatus: report.qualificationStatus, outputRoot, rawPath, samplesCsvPath, summaryCsvPath, phaseSummaryCsvPath, reproPath, protocolAudit, scenarios: report.scenarios, diagnostics }, null, 2) + '\n');
if (report.diagnosticStatus !== 'PASS') process.exitCode = 1;

function loadProtocolExports(source, filename, ts) {
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const moduleObject = { exports: {} };
  const sandbox = {
    module: moduleObject,
    exports: moduleObject.exports,
    SharedArrayBuffer,
    Int32Array,
    Float32Array,
    Atomics,
    console,
  };
  vm.runInNewContext(compiled, sandbox, { filename, timeout: 5000 });
  return moduleObject.exports;
}

function auditProtocolMirror(exports, source, filename) {
  const constantPairs = [
    ['TRACK_COUNT', exports.BROWSER_REALTIME_TRACK_COUNT],
    ['OUTPUT_COUNT', exports.BROWSER_REALTIME_TRACK_COUNT + 2],
    ['COMMAND_CAPACITY', exports.BROWSER_REALTIME_COMMAND_CAPACITY],
    ['COMMAND_WORDS', exports.BROWSER_REALTIME_COMMAND_WORDS],
    ['COMMAND_WORD_OFFSET', exports.CONTROL_COMMANDS_WORD_OFFSET],
    ['CONTROL_HEADER_BYTES', exports.CONTROL_HEADER_BYTES],
    ['TRACK_META_BYTES', exports.TRACK_META_BYTES],
    ['TRACK_META_WORDS', exports.TRACK_META_WORDS],
    ['FRAME_WORD_MODULUS', 0x1_0000_0000],
  ];
  const mirrored = [];
  for (const [name, expected] of constantPairs) {
    const actual = readWorkletIntegerConstant(source, name, filename);
    if (actual !== expected) throw new Error(`${name} diverges: worklet=${actual}, protocol=${expected}`);
    mirrored.push({ name, value: actual });
  }

  const controlPairs = {
    COMMAND_READ: 'COMMAND_READ', COMMAND_WRITE: 'COMMAND_WRITE',
    RENDER_FRAME_SEQUENCE: 'RENDER_FRAME_SEQUENCE', RENDER_FRAME_LOW: 'RENDER_FRAME_LOW',
    RENDER_FRAME_HIGH: 'RENDER_FRAME_HIGH', UNDERRUNS: 'UNDERRUNS',
    LAST_ACK_SEQUENCE: 'LAST_ACK_SEQUENCE', LAST_ACK_FRAME_SEQUENCE: 'LAST_ACK_FRAME_SEQUENCE',
    LAST_ACK_FRAME_LOW: 'LAST_ACK_FRAME_LOW', LAST_ACK_FRAME_HIGH: 'LAST_ACK_FRAME_HIGH',
    OUTPUT_MONITOR_ENABLED: 'OUTPUT_MONITOR_ENABLED', BPM_WORD: 'BPM',
    RHYTHM_RUNNING: 'RHYTHM_RUNNING', RHYTHM_PATTERN: 'RHYTHM_PATTERN',
    COMMAND_OVERRUNS: 'COMMAND_OVERRUNS', DEADLINE_MISSES: 'DEADLINE_MISSES',
    LAST_QUANTUM_FRAMES: 'LAST_QUANTUM_FRAMES', MASTER_ORIGIN_LOW: 'MASTER_ORIGIN_LOW',
    MASTER_ORIGIN_HIGH: 'MASTER_ORIGIN_HIGH', TRACK_CAPACITY_OVERRUNS: 'TRACK_CAPACITY_OVERRUNS',
    DEADLINE_METRIC_AVAILABLE: 'DEADLINE_METRIC_AVAILABLE', INPUT_DROPOUT_BLOCKS: 'INPUT_DROPOUT_BLOCKS',
  };
  auditNamedValues(source, filename, controlPairs, exports.ControlWord, 'control-word');

  const trackMetaPairs = {
    TRACK_STATE: 'STATE', LOOP_FRAMES: 'LOOP_FRAMES', RECORDING_FRAMES: 'RECORDING_FRAMES',
    PLAY_POSITION: 'PLAY_POSITION', CAPACITY_FRAMES: 'CAPACITY_FRAMES',
    RECORD_START_LOW: 'RECORD_START_LOW', RECORD_START_HIGH: 'RECORD_START_HIGH', REVERSE: 'REVERSE',
  };
  auditNamedValues(source, filename, trackMetaPairs, exports.TrackMetaWord, 'track-meta-word');

  const opcodePairs = {
    OPCODE_START_RECORD: 'START_RECORD', OPCODE_STOP_RECORD: 'STOP_RECORD', OPCODE_PLAY: 'PLAY',
    OPCODE_STOP: 'STOP', OPCODE_START_OVERDUB: 'START_OVERDUB', OPCODE_STOP_OVERDUB: 'STOP_OVERDUB',
    OPCODE_CLEAR: 'CLEAR', OPCODE_SET_REVERSE: 'SET_REVERSE', OPCODE_SET_MONITOR: 'SET_MONITOR',
    OPCODE_SET_RHYTHM: 'SET_RHYTHM', OPCODE_SET_BPM: 'SET_BPM', OPCODE_SET_CLOCK: 'SET_CLOCK',
    OPCODE_EXPORT_TRACK: 'EXPORT_TRACK', OPCODE_SET_ALIGNMENT: 'SET_ALIGNMENT',
    OPCODE_CANCEL_PENDING: 'CANCEL_PENDING',
  };
  auditNamedValues(source, filename, opcodePairs, exports.BrowserRealtimeOpcode, 'opcode');

  const statusPairs = {
    STATUS_OK: 'OK', STATUS_LATE: 'LATE', STATUS_MISSING_TRACK_STORAGE: 'MISSING_TRACK_STORAGE',
    STATUS_TRACK_CAPACITY_REACHED: 'TRACK_CAPACITY_REACHED', STATUS_INVALID_STATE: 'INVALID_STATE',
    STATUS_COMMAND_OVERFLOW: 'COMMAND_OVERFLOW', STATUS_CANCELLED: 'CANCELLED', STATUS_INVALID_TRACK: 'INVALID_TRACK',
  };
  auditNamedValues(source, filename, statusPairs, exports.BrowserRealtimeStatus, 'status');

  const statePairs = {
    STATE_EMPTY: 0, STATE_REC_STANDBY: 1, STATE_RECORDING: 2, STATE_REC_FINISHING: 3,
    STATE_PLAYING: 4, STATE_OVERDUBBING: 5, STATE_STOPPED: 6,
  };
  auditNamedValues(source, filename, statePairs, statePairs, 'track-state');

  const controlStatesOffset = readWorkletExpression(source, 'TRACK_STATES_WORD_OFFSET', filename).replace(/\s+/g, '');
  const expectedStatesOffset = `${exports.CONTROL_COMMANDS_WORD_OFFSET}+COMMAND_CAPACITY*COMMAND_WORDS`;
  if (controlStatesOffset !== expectedStatesOffset) throw new Error(`Worklet track-state offset expression changed: ${controlStatesOffset}`);
  const positionsOffset = readWorkletExpression(source, 'TRACK_POSITIONS_WORD_OFFSET', filename).replace(/\s+/g, '');
  if (positionsOffset !== 'TRACK_STATES_WORD_OFFSET+TRACK_COUNT') throw new Error(`Worklet track-position offset expression changed: ${positionsOffset}`);

  const controlBuffer = exports.createControlSharedBuffer();
  if (controlBuffer.byteLength !== exports.CONTROL_BUFFER_BYTE_LENGTH) throw new Error('Protocol createControlSharedBuffer() size mismatch.');
  const trackBuffer = exports.createTrackSharedBuffer(31);
  if (trackBuffer.byteLength !== exports.TRACK_META_BYTES + 31 * Float32Array.BYTES_PER_ELEMENT) throw new Error('Protocol createTrackSharedBuffer() size mismatch.');
  const highFrame = 0x1_0000_0000 + 123;
  const [lowWord, highWord] = exports.frameToWords(highFrame);
  if (exports.frameFromWords(lowWord, highWord) !== highFrame) throw new Error('Protocol frame word round-trip mismatch.');

  const registration = loadWorkletRegistration(source, filename);
  if (registration.name !== exports.BROWSER_REALTIME_WORKLET_NAME) {
    throw new Error(`Processor registration name diverges: ${registration.name} vs ${exports.BROWSER_REALTIME_WORKLET_NAME}`);
  }

  return {
    ok: true,
    workletName: registration.name,
    trackCount: exports.BROWSER_REALTIME_TRACK_COUNT,
    commandCapacity: exports.BROWSER_REALTIME_COMMAND_CAPACITY,
    commandWords: exports.BROWSER_REALTIME_COMMAND_WORDS,
    controlBufferBytes: controlBuffer.byteLength,
    trackMetaBytes: exports.TRACK_META_BYTES,
    commandBaseWordOffset: exports.CONTROL_COMMANDS_WORD_OFFSET,
    trackStatesByteOffset: exports.CONTROL_TRACK_STATES_BYTE_OFFSET,
    trackPositionsByteOffset: exports.CONTROL_TRACK_POSITIONS_BYTE_OFFSET,
    mirroredConstants: mirrored,
    mirroredControlWordCount: Object.keys(controlPairs).length,
    mirroredTrackMetaWordCount: Object.keys(trackMetaPairs).length,
    mirroredOpcodeCount: Object.keys(opcodePairs).length,
    mirroredStatusCount: Object.keys(statusPairs).length,
    workletStateValuesChecked: Object.keys(statePairs).length,
    highFrameWordRoundTrip: highFrame,
  };
}

function auditNamedValues(source, filename, pairs, expectedValues, kind) {
  for (const [workletName, protocolName] of Object.entries(pairs)) {
    const expected = typeof protocolName === 'number' ? protocolName : expectedValues[protocolName];
    const actual = readWorkletIntegerConstant(source, workletName, filename);
    if (actual !== expected) throw new Error(`${kind} ${workletName} diverges: worklet=${actual}, expected=${expected}`);
  }
}

function readWorkletIntegerConstant(source, name, filename) {
  const match = source.match(new RegExp(`\\bconst\\s+${escapeRegExp(name)}\\s*=\\s*(0[xX][0-9a-fA-F_]+|[0-9][0-9_]*)\\s*;`));
  if (!match) throw new Error(`Could not find literal worklet constant ${name} in ${filename}`);
  return Number(match[1].replaceAll('_', ''));
}

function readWorkletExpression(source, name, filename) {
  const match = source.match(new RegExp(`\\bconst\\s+${escapeRegExp(name)}\\s*=\\s*([^;]+);`));
  if (!match) throw new Error(`Could not find worklet expression ${name} in ${filename}`);
  return match[1];
}

function loadWorkletRegistration(source, filename) {
  let registration = null;
  const counters = emptyMessageCounters();
  class AudioWorkletProcessorStub {
    constructor() {
      this.port = { onmessage: null, onmessageerror: null, postMessage: (message) => countMessage(counters, message) };
    }
  }
  const globals = {
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    SharedArrayBuffer,
    Int32Array,
    Float32Array,
    Atomics,
    performance,
    currentFrame: 0,
    sampleRate: 48_000,
    registerProcessor: (name, constructor) => { registration = { name, constructor }; },
    console,
  };
  vm.runInNewContext(source, globals, { filename, timeout: 5000 });
  if (!registration) throw new Error(`registerProcessor() was not called by ${filename}`);
  return registration;
}

function createHarness(capacityFrames = sampleRate * 35, attachedTrackCount = trackCount) {
  const controlBuffer = protocol.createControlSharedBuffer();
  const control = new Int32Array(controlBuffer);
  const stateView = new Int32Array(controlBuffer, protocol.CONTROL_TRACK_STATES_BYTE_OFFSET, trackCount);
  const positionView = new Float32Array(controlBuffer, protocol.CONTROL_TRACK_POSITIONS_BYTE_OFFSET, trackCount);
  const tracks = [];
  for (let track = 0; track < trackCount; track += 1) {
    const buffer = protocol.createTrackSharedBuffer(capacityFrames);
    const meta = new Int32Array(buffer, 0, protocol.TRACK_META_WORDS);
    const data = new Float32Array(buffer, protocol.TRACK_META_BYTES, capacityFrames);
    Atomics.store(meta, trackWord.STATE, processorState.EMPTY);
    Atomics.store(meta, trackWord.CAPACITY_FRAMES, capacityFrames);
    Atomics.store(meta, trackWord.ALIGNMENT_SAMPLES, 0);
    tracks.push({ buffer, meta, data });
  }

  const counters = emptyMessageCounters();
  class AudioWorkletProcessorStub {
    constructor() {
      this.port = { onmessage: null, onmessageerror: null, postMessage: (message) => countMessage(counters, message) };
    }
  }
  let registration = null;
  const vmGlobals = {
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    SharedArrayBuffer,
    Int32Array,
    Float32Array,
    Atomics,
    performance,
    currentFrame: 0,
    sampleRate,
    registerProcessor: (name, constructor) => { registration = { name, constructor }; },
    console,
  };
  vm.runInNewContext(workletSource, vmGlobals, { filename: workletSourcePath, timeout: 5000 });
  if (!registration || registration.name !== protocol.BROWSER_REALTIME_WORKLET_NAME) throw new Error('Actual worklet registration was not captured.');
  const processor = new registration.constructor({ processorOptions: { controlBuffer } });
  for (let track = 0; track < attachedTrackCount; track += 1) {
    processor.handlePortMessage({ type: 'ATTACH_TRACK', track, buffer: tracks[track].buffer });
  }

  const inputLeft = new Float32Array(quantumFrames);
  const inputRight = new Float32Array(quantumFrames);
  for (let frame = 0; frame < quantumFrames; frame += 1) {
    inputLeft[frame] = Math.sin(frame * 0.03125) * 0.1;
    inputRight[frame] = Math.cos(frame * 0.0234375) * 0.1;
  }
  const inputs = [[inputLeft, inputRight]];
  const outputs = Array.from({ length: protocolAudit.mirroredConstants.find((entry) => entry.name === 'OUTPUT_COUNT').value }, () => [new Float32Array(quantumFrames), new Float32Array(quantumFrames)]);
  return {
    controlBuffer,
    control,
    stateView,
    positionView,
    tracks,
    counters,
    processor,
    vmGlobals,
    inputs,
    outputs,
    frame: 0,
    nextSequence: 1,
    processBlock() {
      vmGlobals.currentFrame = this.frame;
      const keepAlive = processor.process(inputs, outputs);
      this.frame += quantumFrames;
      if (keepAlive !== true) throw new Error('Worklet process() unexpectedly requested shutdown.');
    },
  };
}

function queueCommand(harness, op, track, args = {}) {
  const accepted = protocol.queueSharedCommand(harness.control, {
    sequence: harness.nextSequence++,
    opcode: op,
    track,
    targetFrame: args.targetFrame ?? harness.frame,
    arg0: args.arg0 ?? 0,
    arg1: args.arg1 ?? 0,
    flags: args.flags ?? 0,
  });
  if (!accepted) throw new Error(`Command producer overflow in ${op}/${track}`);
}

function initializeLoopTracks(harness, lengths = loopLengths, stateValue = processorState.STOPPED) {
  for (let track = 0; track < trackCount; track += 1) {
    const { meta, data } = harness.tracks[track];
    const length = lengths[track];
    Atomics.store(meta, trackWord.STATE, stateValue);
    Atomics.store(meta, trackWord.LOOP_FRAMES, length);
    Atomics.store(meta, trackWord.RECORDING_FRAMES, length);
    Atomics.store(meta, trackWord.PLAY_POSITION, 0);
    Atomics.store(meta, trackWord.REVERSE, 0);
    for (let frame = 0; frame < length; frame += 1) data[frame] = (track + 1) * 0.125 + frame * 0.00001;
  }
}

function runSteadyScenario(name, mode, sampleCount, warmupCount) {
  const recordCapacity = Math.max(sampleRate * 35, (sampleCount + warmupCount + 8) * quantumFrames);
  const harness = createHarness(recordCapacity);
  if (mode === 'record') {
    for (let track = 0; track < trackCount; track += 1) queueCommand(harness, opcode.START_RECORD, track);
  } else {
    initializeLoopTracks(harness, loopLengths, mode === 'overdub' ? processorState.PLAYING : processorState.STOPPED);
    for (let track = 0; track < trackCount; track += 1) {
      queueCommand(harness, mode === 'play' ? opcode.PLAY : opcode.START_OVERDUB, track, { arg0: mode === 'play' ? 1 : 0 });
    }
  }
  harness.processBlock(); // Apply setup commands; this block is outside warmup and measured samples.

  let blockOrdinal = 0;
  const verify = () => {
    blockOrdinal += 1;
    if (mode === 'record') {
      for (const track of harness.tracks) {
        if (Atomics.load(track.meta, trackWord.STATE) !== processorState.RECORDING) throw new Error('Recording state changed unexpectedly.');
      }
      return;
    }
    const elapsedFrames = (blockOrdinal + 1) * quantumFrames;
    for (let track = 0; track < trackCount; track += 1) {
      const expected = elapsedFrames % loopLengths[track];
      const actual = Atomics.load(harness.tracks[track].meta, trackWord.PLAY_POSITION);
      if (actual !== expected) throw new Error(`${name}: track ${track + 1} phase mismatch at frame ${elapsedFrames}: expected ${expected}, got ${actual}`);
    }
  };
  const samplesMs = runProcessSamples(harness, sampleCount, warmupCount, verify);
  const metrics = readRuntimeMetrics(harness);
  const expectedRecordFrames = mode === 'record' ? (sampleCount + warmupCount + 1) * quantumFrames : null;
  if (mode === 'record') {
    for (const [track, item] of harness.tracks.entries()) {
      const actual = Atomics.load(item.meta, trackWord.RECORDING_FRAMES);
      if (actual !== expectedRecordFrames) throw new Error(`REC track ${track + 1} frame count: expected ${expectedRecordFrames}, got ${actual}`);
    }
    if (metrics.trackCapacityOverruns !== 0) throw new Error('Unexpected recording capacity overrun.');
    if (metrics.inputDropoutBlocks !== 0) throw new Error('Unexpected input dropout in synthetic input test.');
  } else {
    const expectedElapsedFrames = (sampleCount + warmupCount + 1) * quantumFrames;
    for (let track = 0; track < trackCount; track += 1) {
      const expected = expectedElapsedFrames % loopLengths[track];
      const actual = Atomics.load(harness.tracks[track].meta, trackWord.PLAY_POSITION);
      if (actual !== expected) throw new Error(`${name} final phase mismatch on track ${track + 1}: ${expected} vs ${actual}`);
    }
  }
  return {
    scenario: name,
    sampleCount,
    warmupBlocks: warmupCount,
    callbacks: sampleCount + warmupCount,
    framesPerCallback: quantumFrames,
    firstMeasuredFrame: (warmupCount + 1) * quantumFrames,
    processMs: distribution(samplesMs),
    samplesMs,
    phaseChecksPerTrack: mode === 'record' ? 0 : sampleCount + warmupCount + 1,
    loopFrames: mode === 'record' ? [] : loopLengths,
    finalRuntimeMetrics: metrics,
    messageCounts: { ...harness.counters },
  };
}

function runCommandScenario(name, commandOpcode, sampleCount, warmupCount) {
  const isClear = commandOpcode === opcode.CLEAR;
  const harness = createHarness(isClear ? Math.max(...loopLengths) : sampleRate * 35);
  if (isClear) initializeLoopTracks(harness, loopLengths, processorState.PLAYING);
  const total = sampleCount + warmupCount;
  const samplesMs = new Float64Array(sampleCount);
  let firstMeasuredFrame = 0;
  for (let index = 0; index < total; index += 1) {
    if (isClear) initializeLoopMetadata(harness, loopLengths, 4);
    else resetTrackMetadata(harness);
    for (let track = 0; track < trackCount; track += 1) queueCommand(harness, commandOpcode, track, { arg0: isClear ? 0 : 1 });
    if (index === warmupCount) firstMeasuredFrame = harness.frame;
    const start = index >= warmupCount ? performance.now() : 0;
    harness.processBlock();
    if (index >= warmupCount) samplesMs[index - warmupCount] = performance.now() - start;

    for (const [trackIndex, track] of harness.tracks.entries()) {
      if (isClear) {
        if (Atomics.load(track.meta, trackWord.STATE) !== processorState.EMPTY || Atomics.load(track.meta, trackWord.LOOP_FRAMES) !== 0 || Atomics.load(track.meta, trackWord.PLAY_POSITION) !== 0) {
          throw new Error(`Clear failed to reset track ${trackIndex + 1} metadata.`);
        }
      } else if (Atomics.load(track.meta, trackWord.STATE) !== processorState.RECORDING || Atomics.load(track.meta, trackWord.RECORDING_FRAMES) !== quantumFrames) {
        throw new Error(`Record-start command failed for track ${trackIndex + 1}.`);
      }
    }
  }
  const metrics = readRuntimeMetrics(harness);
  return {
    scenario: name,
    sampleCount,
    warmupBlocks: warmupCount,
    commandsPerCallback: trackCount,
    commandQueueSubmissionTiming: 'excluded; only actual vm processor.process() call is timed',
    framesPerCallback: quantumFrames,
    firstMeasuredFrame,
    processMs: distribution(samplesMs),
    samplesMs,
    finalRuntimeMetrics: metrics,
    messageCounts: { ...harness.counters },
  };
}

function runCommandBurstScenario(sampleCount, warmupCount) {
  const harness = createHarness(Math.max(...loopLengths));
  const burstSize = protocol.BROWSER_REALTIME_COMMAND_CAPACITY;
  const total = sampleCount + warmupCount;
  const samplesMs = new Float64Array(sampleCount);
  let firstMeasuredFrame = 0;
  for (let index = 0; index < total; index += 1) {
    for (let command = 0; command < burstSize; command += 1) {
      queueCommand(harness, opcode.SET_MONITOR, -1, { arg0: command & 1 });
    }
    if (index === warmupCount) firstMeasuredFrame = harness.frame;
    const start = index >= warmupCount ? performance.now() : 0;
    harness.processBlock();
    if (index >= warmupCount) samplesMs[index - warmupCount] = performance.now() - start;
  }
  const metrics = readRuntimeMetrics(harness);
  if (metrics.commandQueueDepth !== 0 || metrics.commandOverruns !== 0) throw new Error('The nominal full command burst overflowed or was not drained.');
  if (harness.counters.ackCount !== total * burstSize) throw new Error(`Expected ${total * burstSize} command ACKs, got ${harness.counters.ackCount}.`);
  return {
    scenario: 'command_burst_256',
    sampleCount,
    warmupBlocks: warmupCount,
    commandsPerCallback: burstSize,
    commandQueueSubmissionTiming: 'excluded; only actual vm processor.process() call is timed',
    framesPerCallback: quantumFrames,
    firstMeasuredFrame,
    processMs: distribution(samplesMs),
    samplesMs,
    finalRuntimeMetrics: metrics,
    messageCounts: { ...harness.counters },
  };
}

function runProcessSamples(harness, sampleCount, warmupCount, afterBlock) {
  const samplesMs = new Float64Array(sampleCount);
  for (let index = 0; index < warmupCount; index += 1) {
    harness.processBlock();
    afterBlock?.(index);
  }
  for (let index = 0; index < sampleCount; index += 1) {
    const start = performance.now();
    harness.processBlock();
    samplesMs[index] = performance.now() - start;
    afterBlock?.(warmupCount + index);
  }
  return samplesMs;
}

function runProtocolBehaviorAssertions() {
  const lateHarness = createHarness(Math.max(...loopLengths));
  queueCommand(lateHarness, opcode.SET_MONITOR, -1, { arg0: 1, targetFrame: 0 });
  lateHarness.processBlock();
  queueCommand(lateHarness, opcode.SET_MONITOR, -1, { arg0: 0, targetFrame: 0 });
  lateHarness.processBlock();
  queueCommand(lateHarness, 999, 0);
  lateHarness.processBlock();
  if (lateHarness.counters.ackOk !== 1 || lateHarness.counters.ackLate !== 1 || lateHarness.counters.ackInvalidState !== 1) {
    throw new Error('On-time/late/invalid acknowledgement assertions failed.');
  }
  if (lateHarness.control[controlWord.LAST_QUANTUM_FRAMES] !== quantumFrames) throw new Error('LAST_QUANTUM_FRAMES did not match the processed quantum.');

  const missingStorageHarness = createHarness(Math.max(...loopLengths), trackCount - 1);
  queueCommand(missingStorageHarness, opcode.PLAY, trackCount - 1);
  let missingStorageProcessorError = null;
  try {
    missingStorageHarness.processBlock();
  } catch (error) {
    missingStorageProcessorError = { name: error.name, message: error.message, stack: error.stack };
  }
  const missingStorageAckOk = missingStorageProcessorError === null && missingStorageHarness.counters.ackMissingStorage === 1;
  const invalidTrackHarness = createHarness(Math.max(...loopLengths));
  queueCommand(invalidTrackHarness, opcode.PLAY, trackCount);
  invalidTrackHarness.processBlock();
  if (invalidTrackHarness.counters.ackInvalidTrack !== 1) throw new Error('Out-of-range track command did not return INVALID_TRACK ACK.');
  if (!missingStorageAckOk) throw new Error('Missing track storage command did not return its expected ACK without a process exception.');

  const overflowHarness = createHarness(Math.max(...loopLengths));
  let accepted = 0;
  for (let index = 0; index < protocol.BROWSER_REALTIME_COMMAND_CAPACITY + 1; index += 1) {
    const isAccepted = protocol.queueSharedCommand(overflowHarness.control, {
      sequence: overflowHarness.nextSequence++, opcode: opcode.SET_MONITOR, track: -1,
      targetFrame: 0, arg0: index & 1,
    });
    if (isAccepted) accepted += 1;
  }
  if (accepted !== protocol.BROWSER_REALTIME_COMMAND_CAPACITY || Atomics.load(overflowHarness.control, controlWord.COMMAND_OVERRUNS) !== 1) {
    throw new Error('Command queue bounded-capacity/drop-counter assertion failed.');
  }
  overflowHarness.processBlock();
  if (overflowHarness.counters.ackCount !== protocol.BROWSER_REALTIME_COMMAND_CAPACITY) throw new Error('Full command queue did not drain exactly its bounded capacity.');

  const capacityHarness = createHarness(quantumFrames);
  queueCommand(capacityHarness, opcode.START_RECORD, 0);
  capacityHarness.processBlock();
  capacityHarness.processBlock();
  const capacityMetrics = readRuntimeMetrics(capacityHarness);
  if (capacityMetrics.trackCapacityOverruns !== 1 || capacityHarness.counters.capacityEvents !== 1) {
    throw new Error('Track capacity overflow/counter assertion failed.');
  }

  const clearHarness = createHarness(128);
  const clearLength = 64;
  const track = clearHarness.tracks[0];
  track.data.fill(0.75, 0, clearLength);
  Atomics.store(track.meta, trackWord.STATE, processorState.PLAYING);
  Atomics.store(track.meta, trackWord.LOOP_FRAMES, clearLength);
  Atomics.store(track.meta, trackWord.RECORDING_FRAMES, clearLength);
  queueCommand(clearHarness, opcode.CLEAR, 0);
  clearHarness.processBlock();
  assertSilent(clearHarness.outputs[0][0], 'Clear left output');
  assertSilent(clearHarness.outputs[0][1], 'Clear right output');
  queueCommand(clearHarness, opcode.PLAY, 0);
  clearHarness.processBlock();
  assertSilent(clearHarness.outputs[0][0], 'post-Clear invalid Play left output');
  assertSilent(clearHarness.outputs[0][1], 'post-Clear invalid Play right output');
  if (Atomics.load(track.meta, trackWord.LOOP_FRAMES) !== 0 || Atomics.load(track.meta, trackWord.PLAY_POSITION) !== 0) {
    throw new Error('Clear did not reset loop length/playhead while old storage remained allocated.');
  }

  return {
    name: 'protocol_and_state_assertions',
    onTimeLateInvalidMissingAckCounts: {
      onTime: lateHarness.counters.ackOk,
      late: lateHarness.counters.ackLate,
      invalidState: lateHarness.counters.ackInvalidState,
      missingTrackStorage: missingStorageHarness.counters.ackMissingStorage,
      invalidTrack: invalidTrackHarness.counters.ackInvalidTrack,
    },
    missingTrackStorageAcknowledgementPassed: missingStorageAckOk,
    missingTrackStorageProcessorError: missingStorageProcessorError,
    producerQueueCapacity: protocol.BROWSER_REALTIME_COMMAND_CAPACITY,
    producerAcceptedCommandsAtOverflow: accepted,
    producerDropCounter: Atomics.load(overflowHarness.control, controlWord.COMMAND_OVERRUNS),
    capacityOverrunCount: capacityMetrics.trackCapacityOverruns,
    capacityNotificationCount: capacityHarness.counters.capacityEvents,
    clearPointerResetAndNoGhostPlayback: true,
    assertionErrors: missingStorageAckOk ? 0 : 1,
  };
}

async function runLongPlaybackPhaseSimulation(minutes, yieldEveryBlocks, yieldMs) {
  const totalFrames = sampleRate * 60 * minutes;
  if (totalFrames % quantumFrames !== 0) throw new Error('Requested phase duration must end on a 128-frame boundary.');
  const blocks = totalFrames / quantumFrames;
  const harness = createHarness(Math.max(...loopLengths));
  // Start just below a 32-bit low-word boundary while remaining a 64-bit frame origin.
  // The real processor still runs every block; this forces its sequence-protected
  // high/low frame publication through an actual low-word wrap during the simulation.
  const originFrame = 2 * 0x1_0000_0000 - 2 * quantumFrames;
  const originWords = protocol.frameToWords(originFrame);
  harness.frame = originFrame;
  initializeLoopTracks(harness, loopLengths, processorState.PLAYING);
  const samplesMs = new Float64Array(blocks);
  const started = performance.now();
  let activeProcessMs = 0;
  let phaseAssertions = 0;
  let frameCounterAssertions = 0;
  let frameCounterMismatchCount = 0;
  let lowWordWrapCount = 0;
  let maxAbsolutePhaseDriftFrames = 0;
  const phaseMismatchCountByTrack = Array(trackCount).fill(0);
  const maxAbsolutePhaseDriftFramesByTrack = Array(trackCount).fill(0);
  let firstPhaseMismatch = null;
  let firstFrameCounterMismatch = null;
  for (let block = 0; block < blocks; block += 1) {
    const tick = performance.now();
    harness.processBlock();
    const elapsed = performance.now() - tick;
    samplesMs[block] = elapsed;
    activeProcessMs += elapsed;
    const processedFrames = (block + 1) * quantumFrames;
    const expectedAbsoluteFrame = originFrame + processedFrames;
    const actualAbsoluteFrame = protocol.loadSharedFrame(
      harness.control,
      controlWord.RENDER_FRAME_SEQUENCE,
      controlWord.RENDER_FRAME_LOW,
      controlWord.RENDER_FRAME_HIGH,
    );
    frameCounterAssertions += 1;
    if (actualAbsoluteFrame !== expectedAbsoluteFrame) {
      frameCounterMismatchCount += 1;
      if (!firstFrameCounterMismatch) {
        firstFrameCounterMismatch = { block: block + 1, expectedAbsoluteFrame, actualAbsoluteFrame };
      }
    }
    lowWordWrapCount = Math.floor(expectedAbsoluteFrame / 0x1_0000_0000) - Math.floor(originFrame / 0x1_0000_0000);
    for (let track = 0; track < trackCount; track += 1) {
      const expected = processedFrames % loopLengths[track];
      const actual = Atomics.load(harness.tracks[track].meta, trackWord.PLAY_POSITION);
      const drift = actual - expected;
      const absoluteDrift = Math.abs(drift);
      if (absoluteDrift > maxAbsolutePhaseDriftFramesByTrack[track]) {
        maxAbsolutePhaseDriftFramesByTrack[track] = absoluteDrift;
      }
      if (absoluteDrift > maxAbsolutePhaseDriftFrames) maxAbsolutePhaseDriftFrames = absoluteDrift;
      if (drift !== 0) {
        phaseMismatchCountByTrack[track] += 1;
        if (!firstPhaseMismatch) {
          firstPhaseMismatch = { block: block + 1, track: track + 1, processedFrames, expected, actual, drift };
        }
      }
      phaseAssertions += 1;
    }
    if (yieldEveryBlocks > 0 && (block + 1) % yieldEveryBlocks === 0) {
      await new Promise((resolve) => setTimeout(resolve, yieldMs));
    }
  }
  const wallMs = performance.now() - started;
  const metrics = readRuntimeMetrics(harness);
  const expectedFinalAbsoluteFrame = originFrame + totalFrames;
  if (metrics.renderedFrame !== expectedFinalAbsoluteFrame) {
    frameCounterMismatchCount += 1;
    if (!firstFrameCounterMismatch) {
      firstFrameCounterMismatch = {
        block: blocks,
        expectedAbsoluteFrame: expectedFinalAbsoluteFrame,
        actualAbsoluteFrame: metrics.renderedFrame,
        finalCheck: true,
      };
    }
  }
  const assertionErrors = phaseMismatchCountByTrack.reduce((sum, count) => sum + count, 0) + frameCounterMismatchCount;
  return {
    name: 'accelerated_vm_playback_phase',
    requestedMinutes: minutes,
    simulatedFrames: totalFrames,
    sampleTimelineSeconds: totalFrames / sampleRate,
    simulatedAudioSeconds: totalFrames / sampleRate,
    originFrame,
    originFrameWords: { low: originWords[0] >>> 0, high: originWords[1] >>> 0 },
    expectedFinalAbsoluteFrame,
    expectedFinalFrameWords: protocol.frameToWords(expectedFinalAbsoluteFrame).map((word) => word >>> 0),
    processorCallbacks: blocks,
    phaseAssertions,
    frameCounterAssertions,
    lowWordWrapCount,
    frameCounterMismatchCount,
    firstFrameCounterMismatch,
    phaseMismatchCountByTrack,
    maxAbsolutePhaseDriftFramesByTrack,
    maxAbsolutePhaseDriftFrames,
    firstPhaseMismatch,
    assertionErrors,
    loopFrames: loopLengths,
    finalPlayPositions: harness.tracks.map((track) => Atomics.load(track.meta, trackWord.PLAY_POSITION)),
    expectedPlayPositions: loopLengths.map((length) => totalFrames % length),
    processMs: distribution(samplesMs),
    accumulatedProcessCallMs: activeProcessMs,
    actualWallTimeSeconds: wallMs / 1000,
    wallElapsedMs: wallMs,
    yieldEveryBlocks,
    yieldMs,
    estimatedActiveFraction: wallMs > 0 ? activeProcessMs / wallMs : null,
    finalRuntimeMetrics: metrics,
    messageCounts: { ...harness.counters },
    caveat: 'This invokes the actual JS process() against preallocated synthetic buffers at an accelerated 64-bit VM currentFrame origin crossing the low 32-bit word; sampleTimelineSeconds is simulated audio time, not wall time. This is not a hardware or Chromium realtime soak.',
  };
}

function readRuntimeMetrics(harness) {
  const frame = protocol.loadSharedFrame(
    harness.control,
    controlWord.RENDER_FRAME_SEQUENCE,
    controlWord.RENDER_FRAME_LOW,
    controlWord.RENDER_FRAME_HIGH,
  );
  const read = Atomics.load(harness.control, controlWord.COMMAND_READ) >>> 0;
  const write = Atomics.load(harness.control, controlWord.COMMAND_WRITE) >>> 0;
  return {
    sampleRate,
    quantumFrames: Atomics.load(harness.control, controlWord.LAST_QUANTUM_FRAMES),
    renderedFrame: frame,
    underruns: Atomics.load(harness.control, controlWord.UNDERRUNS),
    inputDropoutBlocks: Atomics.load(harness.control, controlWord.INPUT_DROPOUT_BLOCKS),
    commandQueueDepth: (write - read) >>> 0,
    commandOverruns: Atomics.load(harness.control, controlWord.COMMAND_OVERRUNS),
    processDeadlineMisses: Atomics.load(harness.control, controlWord.DEADLINE_MISSES),
    deadlineMetricAvailable: Atomics.load(harness.control, controlWord.DEADLINE_METRIC_AVAILABLE) !== 0,
    trackCapacityOverruns: Atomics.load(harness.control, controlWord.TRACK_CAPACITY_OVERRUNS),
    trackStates: Array.from(harness.stateView),
    trackPositions: Array.from(harness.positionView),
    loopFrames: harness.tracks.map((track) => Atomics.load(track.meta, trackWord.LOOP_FRAMES)),
    recordingFrames: harness.tracks.map((track) => Atomics.load(track.meta, trackWord.RECORDING_FRAMES)),
    playPositions: harness.tracks.map((track) => Atomics.load(track.meta, trackWord.PLAY_POSITION)),
    trackCapacityFrames: harness.tracks.map((track) => Atomics.load(track.meta, trackWord.CAPACITY_FRAMES)),
  };
}

function emptyMessageCounters() {
  return {
    attachCount: 0,
    ackCount: 0,
    ackOk: 0,
    ackLate: 0,
    ackMissingStorage: 0,
    ackCapacity: 0,
    ackInvalidState: 0,
    ackCommandOverflow: 0,
    ackCancelled: 0,
    ackInvalidTrack: 0,
    capacityEvents: 0,
    bootErrors: 0,
    otherMessages: 0,
  };
}

function countMessage(counters, message) {
  if (!message || typeof message !== 'object') {
    counters.otherMessages += 1;
    return;
  }
  if (message.type === 'TRACK_ATTACHED') counters.attachCount += 1;
  else if (message.type === 'BOOT_ERROR') counters.bootErrors += 1;
  else if (message.type === 'TRACK_CAPACITY_REACHED') counters.capacityEvents += 1;
  else if (message.type === 'ACK') {
    counters.ackCount += 1;
    if (message.status === status.OK) counters.ackOk += 1;
    else if (message.status === status.LATE) counters.ackLate += 1;
    else if (message.status === status.MISSING_TRACK_STORAGE) counters.ackMissingStorage += 1;
    else if (message.status === status.TRACK_CAPACITY_REACHED) counters.ackCapacity += 1;
    else if (message.status === status.INVALID_STATE) counters.ackInvalidState += 1;
    else if (message.status === status.COMMAND_OVERFLOW) counters.ackCommandOverflow += 1;
    else if (message.status === status.CANCELLED) counters.ackCancelled += 1;
    else if (message.status === status.INVALID_TRACK) counters.ackInvalidTrack += 1;
  } else counters.otherMessages += 1;
}

function initializeLoopMetadata(harness, lengths, state) {
  for (let track = 0; track < trackCount; track += 1) {
    const meta = harness.tracks[track].meta;
    Atomics.store(meta, trackWord.STATE, state);
    Atomics.store(meta, trackWord.LOOP_FRAMES, lengths[track]);
    Atomics.store(meta, trackWord.RECORDING_FRAMES, lengths[track]);
    Atomics.store(meta, trackWord.PLAY_POSITION, 0);
    Atomics.store(meta, trackWord.REVERSE, 0);
  }
}

function resetTrackMetadata(harness) {
  for (const { meta } of harness.tracks) {
    Atomics.store(meta, trackWord.STATE, processorState.EMPTY);
    Atomics.store(meta, trackWord.LOOP_FRAMES, 0);
    Atomics.store(meta, trackWord.RECORDING_FRAMES, 0);
    Atomics.store(meta, trackWord.PLAY_POSITION, 0);
    Atomics.store(meta, trackWord.REVERSE, 0);
  }
}

function assertSilent(samples, label) {
  for (let frame = 0; frame < samples.length; frame += 1) {
    if (samples[frame] !== 0) throw new Error(`${label} emitted non-silent sample at frame ${frame}: ${samples[frame]}`);
  }
}

function distribution(values) {
  const array = Array.from(values).sort((left, right) => left - right);
  const at = (percentile) => array.length ? array[Math.ceil((array.length - 1) * percentile)] : null;
  return {
    samples: array.length,
    p50Ms: at(0.50),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: array.length ? array[array.length - 1] : null,
  };
}

function toCsv(rows) {
  if (!rows.length) return '\r\n';
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value) => {
    const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${fields.map(cell).join(',')}\r\n${rows.map((row) => fields.map((field) => cell(row[field])).join(',')).join('\r\n')}\r\n`;
}

function parseArgs(argv) {
  const parsed = {};
  const names = {
    '--iterations': 'iterations', '--warmup': 'warmup', '--burst-samples': 'burstSamples',
    '--burst-warmup': 'burstWarmup', '--phase-minutes': 'phaseMinutes',
    '--phase-yield-blocks': 'phaseYieldBlocks', '--phase-yield-ms': 'phaseYieldMs', '--output-dir': 'outputDir',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--audit-only') parsed.auditOnly = true;
    else if (names[arg]) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      parsed[names[arg]] = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function parsePositiveInt(raw, option, max) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error(`${option} must be an integer from 1 to ${max}`);
  return value;
}

function parseNonNegativeInt(raw, option, max) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`${option} must be an integer from 0 to ${max}`);
  return value;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
