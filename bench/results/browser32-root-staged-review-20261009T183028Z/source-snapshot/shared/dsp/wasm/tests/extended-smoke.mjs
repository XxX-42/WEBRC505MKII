import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const modulePath = path.resolve(process.argv[2] ?? 'test-results/dsp-wasm/webrc-dsp.wasm');
const manifestPath = path.resolve(process.argv[3] ?? 'test-results/dsp-wasm/webrc-dsp.build.json');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const moduleBytes = await fs.readFile(modulePath);
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.sourceFilesStableDuringBuild, true);
assert.equal(manifest.artifact.sha256, sha256(moduleBytes));
assert.equal(manifest.artifact.byteLength, moduleBytes.byteLength);
assert.equal(manifest.build.emsdkCommit, '35ff8a6d150541276abbc6bae512ca90bcfbe220');
assert.match(manifest.build.compilerIdentity, /6\.0\.10 \(d6c521a7f05449857c76bd99e396895583cf2083\)$/);
const sourceSet = Object.keys(manifest.sourceFiles).sort()
  .map(relative => `${relative}=${manifest.sourceFiles[relative]}`).join('\n');
assert.equal(manifest.sourceSetSha256, sha256(Buffer.from(sourceSet, 'utf8')));
for (const [relative, expectedHash] of Object.entries(manifest.sourceFiles)) {
  const source = await fs.readFile(path.resolve(repoRoot, relative));
  assert.equal(sha256(source), expectedHash, `stale WASM source: ${relative}`);
}

const imports = WebAssembly.Module.imports(await WebAssembly.compile(moduleBytes));
assert.deepEqual(imports.map(({ module, name, kind }) => [module, name, kind]), [
  ['wasi_snapshot_preview1', 'fd_close', 'function'],
  ['wasi_snapshot_preview1', 'fd_write', 'function'],
  ['wasi_snapshot_preview1', 'fd_seek', 'function'],
]);
const wasiCalls = { fd_close: 0, fd_write: 0, fd_seek: 0 };
const wasi = {
  fd_close() { wasiCalls.fd_close += 1; return 8; },
  fd_write() { wasiCalls.fd_write += 1; return 8; },
  fd_seek() { wasiCalls.fd_seek += 1; return 8; },
};
const { instance } = await WebAssembly.instantiate(moduleBytes, { wasi_snapshot_preview1: wasi });
const wasm = instance.exports;
wasm._initialize();
const memory = wasm.memory;
const initialMemoryBytes = memory.buffer.byteLength;
assert.equal(initialMemoryBytes, 64 * 1024 * 1024);
assert.equal(wasm.webrc_dsp_abi_version(), 2);
assert.equal(wasm.webrc_dsp_extended_api_version(), 1);
assert.equal(wasm.webrc_dsp_capabilities(), 7);

const Kind = {
  wdf: 100, oversampled: 101, pattern: 102, scheduler: 103, midSide: 104,
  onset: 105, bitrate: 106, ringMod: 107, yin: 108, psolaBuffer: 109,
  streamingPsola: 110, phaseVocoder: 111, vocoder: 112, signalsmith: 113,
  granular: 114, fdn: 115, convolver: 116, freeze: 117, reverse: 118,
  platter: 119, drums: 120, rhythm: 121, incrementalYin: 126, liveMonoPitch: 127,
};
const Control = {
  nonlinearDrive: 2, patternGains: 3, schedulerTempo: 4, midSideWidth: 5,
  onsetParameters: 6, bitrateParameters: 7, ringModParameters: 8,
  streamingPitch: 9, vocoderEnvelope: 10, vocoderGain: 11,
  stretchTranspose: 12, fdnParameters: 14, granularParameters: 15,
  freeze: 16, reverseSegment: 17, platterSpeed: 18, platterInertia: 19,
  liveMonoPitchRatio: 20,
};
const Status = { ok: 0, badHandle: -1, badArgument: -2, badKind: -3, tooLarge: -4, noEstimate: -9 };
const sampleRate = 48000;
const maxBlock = 512;
const allocations = [];
const handles = [];

function allocate(frames) {
  const token = wasm.webrc_dsp_alloc_f32_token(frames);
  assert.notEqual(token, 0, `unable to allocate ${frames} transfer frames`);
  const address = wasm.webrc_dsp_transfer_address(token);
  assert.notEqual(address, 0);
  const buffer = { token, address, frames, f32: new Float32Array(memory.buffer, address, frames) };
  allocations.push(buffer);
  return buffer;
}

function release(buffer) {
  if (!allocations.includes(buffer)) return;
  assert.equal(wasm.webrc_dsp_free_transfer_token(buffer.token), Status.ok);
  allocations.splice(allocations.indexOf(buffer), 1);
}

function create(kind, options = [], channels = 1, seed = 1n) {
  let optionsBuffer;
  if (options.length) {
    optionsBuffer = allocate(options.length);
    optionsBuffer.f32.set(options);
  }
  const handle = wasm.webrc_dsp_extended_create(
    kind, sampleRate, maxBlock, channels, optionsBuffer?.address ?? 0,
    options.length, seed);
  if (optionsBuffer) release(optionsBuffer);
  assert.notEqual(handle, 0, `extended kind ${kind} create failed: ${wasm.webrc_dsp_extended_last_create_status()}`);
  assert.equal(wasm.webrc_dsp_extended_last_create_status(), Status.ok);
  handles.push(handle);
  return handle;
}

function configure(handle, control, values, seed = 1n) {
  const buffer = allocate(values.length);
  buffer.f32.set(values);
  const status = wasm.webrc_dsp_extended_configure(handle, control, buffer.address, values.length, seed);
  release(buffer);
  assert.equal(status, Status.ok, `control ${control} failed for handle ${handle}`);
}

function assertFiniteNonZero(samples, label, minimumRms = 1e-8) {
  let power = 0;
  for (let index = 0; index < samples.length; index += 1) {
    assert.ok(Number.isFinite(samples[index]), `${label}[${index}] finite`);
    power += samples[index] * samples[index];
  }
  const rms = Math.sqrt(power / Math.max(1, samples.length));
  assert.ok(rms > minimumRms, `${label} RMS ${rms} exceeds ${minimumRms}`);
  return rms;
}

function fillSine(buffer, frames, frequency, amplitude = 0.5, phase = 0) {
  for (let index = 0; index < frames; index += 1) {
    buffer.f32[index] = amplitude * Math.sin(2 * Math.PI * frequency * index / sampleRate + phase);
  }
}

function readCString(address, maximumBytes = 96) {
  assert.ok(Number.isInteger(address) && address > 0, 'C string pointer is non-null');
  const bytes = new Uint8Array(memory.buffer, address, maximumBytes);
  let length = 0;
  while (length < bytes.length && bytes[length] !== 0) length += 1;
  assert.ok(length < bytes.length, 'C string is null terminated within bound');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
}

function readPitchRuntimeMetrics(address) {
  const view = new DataView(memory.buffer, address, 88);
  return {
    analysisCount: view.getBigUint64(0, true),
    totalInputFrames: view.getBigUint64(8, true),
    latestWindowEndFrame: view.getBigUint64(16, true),
    declaredPathFrames: view.getBigUint64(24, true),
    firstEstimateColdStartFrames: view.getBigUint64(32, true),
    preparedKind: view.getUint32(40, true),
    analysisBusy: view.getUint32(44, true),
    analysisWindowFrames: view.getUint32(48, true),
    analysisHopFrames: view.getUint32(52, true),
    processingLagFrames: view.getUint32(56, true),
    estimateAgeFrames: view.getUint32(60, true),
    lastWorkUnits: view.getUint32(64, true),
    workBudget: view.getUint32(68, true),
    resynthesisLatencySamples: view.getUint32(72, true),
    latencyModel: view.getUint32(76, true),
    pitchRatio: view.getFloat32(80, true),
  };
}

const inputLeft = allocate(maxBlock);
const inputRight = allocate(maxBlock);
const inputAux = allocate(maxBlock);
const outputLeft = allocate(maxBlock);
const outputRight = allocate(maxBlock);
const outputAux = allocate(maxBlock);
const parameters = allocate(maxBlock * 2);
const stereoPhaseBuffer = allocate(maxBlock * 2);
const phaseCycles = new Float64Array(memory.buffer, stereoPhaseBuffer.address, maxBlock);

fillSine(inputLeft, maxBlock, 440);
fillSine(inputRight, maxBlock, 660, 0.25, 0.3);

// F07: physical diode model and real oversampled ADAA/WDF engine.
const diode = create(Kind.wdf);
configure(diode, 1, [1000, 2e-9, 0.02585, 1]);
assert.equal(wasm.webrc_dsp_extended_process_mono(diode, inputLeft.address,
  outputLeft.address, maxBlock), Status.ok);
assertFiniteNonZero(outputLeft.f32, 'WDF diode');

const nonlinear = create(Kind.oversampled, [2, 0, 2]);
assert.equal(wasm.webrc_dsp_extended_process_mono(nonlinear, inputLeft.address,
  outputLeft.address, maxBlock), Status.ok);
assertFiniteNonZero(outputLeft.f32, '2x oversampled ADAA');

// F16/F27 and F20: phase-driven pattern and absolute sample event.
const pattern = create(Kind.pattern, [16, 0.08]);
const gains = allocate(4);
gains.f32.set([1, 0, 1, 0]);
assert.equal(wasm.webrc_dsp_extended_pattern_set_gains(pattern, gains.address, 4, 0), Status.ok);
inputLeft.f32.fill(1, 0, maxBlock);
for (let index = 0; index < maxBlock; index += 1) phaseCycles[index] = index / maxBlock;
assert.equal(wasm.webrc_dsp_extended_process_pattern(pattern, inputLeft.address,
  stereoPhaseBuffer.address, outputLeft.address, maxBlock), Status.ok);
assert.ok(outputLeft.f32.some(value => value > 0.5));
assert.ok(outputLeft.f32.some(value => value < 0.5));

const scheduler = create(Kind.scheduler, [120, 960]);
assert.equal(wasm.webrc_dsp_extended_schedule_absolute(scheduler, 100n, 2, 0.75), Status.ok);
const scheduled = allocate(6);
const eventCount = allocate(1);
assert.equal(wasm.webrc_dsp_extended_collect_events(scheduler, 64n, 64,
  scheduled.address, 1, eventCount.address), Status.ok);
assert.equal(new Uint32Array(memory.buffer, eventCount.address, 1)[0], 1);
const eventView = new DataView(memory.buffer, scheduled.address, 24);
assert.equal(eventView.getBigUint64(0, true), 100n);
assert.equal(eventView.getUint32(8, true), 2);
assert.equal(eventView.getFloat32(12, true), 0.75);
assert.equal(eventView.getUint32(16, true), 36);

// F22 / F11: stereo width plus a sample-by-sample onset output stream.
const width = create(Kind.midSide, [140], 2);
configure(width, Control.midSideWidth, [1.5, 0.25, 10]);
assert.equal(wasm.webrc_dsp_extended_process_stereo(width, inputLeft.address,
  inputRight.address, outputLeft.address, outputRight.address, maxBlock), Status.ok);
assertFiniteNonZero(outputLeft.f32, 'mid-side width left');
assertFiniteNonZero(outputRight.f32, 'mid-side width right');

const onset = create(Kind.onset);
configure(onset, Control.onsetParameters, [0.02, 1.2, 1, 10]);
inputLeft.f32.fill(0, 0, maxBlock);
inputLeft.f32.fill(0.8, 64, maxBlock);
const onsetOutput = allocate(maxBlock * 3);
assert.equal(wasm.webrc_dsp_extended_process_onset(onset, inputLeft.address,
  onsetOutput.address, maxBlock), Status.ok);
const onsetView = new DataView(memory.buffer, onsetOutput.address, maxBlock * 12);
assert.ok(Array.from({ length: maxBlock }, (_, i) => onsetView.getUint32(i * 12 + 8, true)).some(Boolean),
  'onset detector emits a transient event');

// F29/F06: quantizer/dither and ring modulation each produce their signal path.
const bitRate = create(Kind.bitrate, [], 1, 0x12345678n);
configure(bitRate, Control.bitrateParameters, [8, 1, 0.7, 1, 10], 0x12345678n);
fillSine(inputLeft, maxBlock, 997, 0.6);
assert.equal(wasm.webrc_dsp_extended_process_mono(bitRate, inputLeft.address,
  outputLeft.address, maxBlock), Status.ok);
assertFiniteNonZero(outputLeft.f32, 'dithered bitrate reducer');
const ringMod = create(Kind.ringMod);
configure(ringMod, Control.ringModParameters, [1000, 1, 10]);
assert.equal(wasm.webrc_dsp_extended_process_mono(ringMod, inputLeft.address,
  outputLeft.address, maxBlock), Status.ok);
assertFiniteNonZero(outputLeft.f32, 'ring modulator');

// F09/F10/F11: fixed-frame YIN, offline buffer PSOLA, and prepared streaming PSOLA.
const pitchInput = allocate(2048);
fillSine(pitchInput, 2048, 220, 0.7);
const yin = create(Kind.yin, [2048, 80, 1000, 0.15]);
const estimate = allocate(5);
assert.equal(wasm.webrc_dsp_extended_yin_analyze(yin, pitchInput.address, 2048,
  estimate.address), Status.ok);
assert.ok(Math.abs(estimate.f32[0] - 220) < 2.5, `YIN estimates 220 Hz, got ${estimate.f32[0]}`);
assert.equal(new Uint32Array(memory.buffer, estimate.address + 16, 1)[0], 1);

const longMonoIn = allocate(8192);
const longMonoOut = allocate(8192);
fillSine(longMonoIn, 4096, 220, 0.6);
const psolaBuffer = create(Kind.psolaBuffer, [8192, 1000]);
assert.equal(wasm.webrc_dsp_extended_process_pitch_buffer(psolaBuffer,
  longMonoIn.address, longMonoOut.address, 4096, sampleRate / 220, 1.5), Status.ok);
assertFiniteNonZero(longMonoOut.f32.subarray(0, 4096), 'whole-buffer TD-PSOLA');

const streamingPsola = create(Kind.streamingPsola, [1000]);
assert.equal(wasm.webrc_dsp_extended_streaming_set_pitch(streamingPsola,
  estimate.address, 1.5), Status.ok);
assert.ok(wasm.webrc_dsp_extended_output_latency_samples(streamingPsola) > 0);
assert.equal(wasm.webrc_dsp_extended_process_mono(streamingPsola,
  pitchInput.address, outputLeft.address, 512), Status.ok);
assert.ok(outputLeft.f32.subarray(0, 512).every(Number.isFinite));

// Incremental F10 and the measured-input LIVE_MONO F10->F11 adapter.
const incrementalFrames = 16384;
const incrementalInput = allocate(incrementalFrames);
fillSine(incrementalInput, incrementalFrames, 220, 0.7);
const incrementalYin = create(Kind.incrementalYin,
  [4096, 80, 1000, 0.15, 512, 32768]);
const incrementalEstimate = allocate(5);
incrementalEstimate.f32.fill(-9);
assert.equal(wasm.webrc_dsp_extended_pitch_get_estimate(incrementalYin,
  incrementalEstimate.address), Status.noEstimate,
  'incremental YIN reports that no completed window exists before input');
assert.ok(incrementalEstimate.f32.every(value => value === -9),
  'no-estimate status leaves the caller output unchanged');
assert.equal(wasm.webrc_dsp_extended_pitch_get_estimate(yin,
  incrementalEstimate.address), Status.badKind,
  'incremental getter rejects the offline YIN handle');
let incrementalOffset = 0;
const partitions = [64, 128, 256, 512];
let incrementalCall = 0;
while (incrementalOffset < incrementalFrames) {
  const frames = Math.min(partitions[incrementalCall++ % partitions.length],
    incrementalFrames - incrementalOffset);
  assert.equal(wasm.webrc_dsp_extended_process_yin(incrementalYin,
    incrementalInput.address + incrementalOffset * 4, frames), Status.ok);
  incrementalOffset += frames;
}
assert.equal(wasm.webrc_dsp_extended_pitch_get_estimate(incrementalYin,
  incrementalEstimate.address), Status.ok);
assert.ok(Math.abs(incrementalEstimate.f32[0] - 220) < 1,
  `incremental YIN estimates 220 Hz, got ${incrementalEstimate.f32[0]}`);
assert.equal(new Uint32Array(memory.buffer, incrementalEstimate.address + 16, 1)[0], 1);
const incrementalMetricsBuffer = allocate(22);
assert.equal(wasm.webrc_dsp_extended_pitch_get_metrics(incrementalYin,
  incrementalMetricsBuffer.address), Status.ok);
const incrementalMetrics = readPitchRuntimeMetrics(incrementalMetricsBuffer.address);
assert.equal(incrementalMetrics.preparedKind, Kind.incrementalYin);
assert.ok(incrementalMetrics.analysisCount > 0n);
assert.equal(incrementalMetrics.totalInputFrames, BigInt(incrementalFrames));
assert.equal(incrementalMetrics.analysisWindowFrames, 4096);
assert.equal(incrementalMetrics.analysisHopFrames, 512);
assert.ok(incrementalMetrics.firstEstimateColdStartFrames >= 4096n &&
  incrementalMetrics.firstEstimateColdStartFrames <= BigInt(incrementalFrames));
assert.ok(incrementalMetrics.lastWorkUnits <= incrementalMetrics.workBudget);
assert.equal(incrementalMetrics.latencyModel, 1,
  'YIN reports window-availability observation separately from callback timing');
assert.equal(wasm.webrc_dsp_extended_process_yin(incrementalYin,
  incrementalInput.address, maxBlock + 1), Status.tooLarge,
  'incremental YIN rejects an oversized quantum before ingesting it');
assert.equal(wasm.webrc_dsp_extended_pitch_get_metrics(incrementalYin,
  incrementalMetricsBuffer.address), Status.ok);
assert.equal(readPitchRuntimeMetrics(incrementalMetricsBuffer.address).totalInputFrames,
  BigInt(incrementalFrames), 'rejected oversized quantum leaves the input timeline unchanged');

const invalidPitchOption = allocate(6);
invalidPitchOption.f32.set([4096, 512, 2048, 40, 1000, 0.15]);
const managedBeforeInvalidPitchCreate = wasm.webrc_dsp_managed_memory_bytes();
assert.equal(wasm.webrc_dsp_extended_create(Kind.liveMonoPitch, sampleRate, maxBlock, 2,
  invalidPitchOption.address, 6, 1n), 0,
  'LIVE_MONO preflight rejects stereo analysis instead of silently downmixing');
assert.equal(wasm.webrc_dsp_extended_last_create_status(), Status.badArgument);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), managedBeforeInvalidPitchCreate,
  'rejected pitch setup releases its reservation');
invalidPitchOption.f32.set([4096, 512, 2048, 40, 1000, 1.0]);
assert.equal(wasm.webrc_dsp_extended_create(Kind.liveMonoPitch, sampleRate, maxBlock, 1,
  invalidPitchOption.address, 6, 1n), 0,
  'LIVE_MONO rejects an exclusive YIN-threshold bound before allocation');
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), managedBeforeInvalidPitchCreate);
release(invalidPitchOption);

const liveFrames = 24576;
const liveInput = allocate(liveFrames);
const liveOutput = allocate(liveFrames);
fillSine(liveInput, liveFrames, 55, 0.24);
const liveMonoPitch = create(Kind.liveMonoPitch,
  [4096, 512, 32768, 40, 1000, 0.15]);
configure(liveMonoPitch, Control.liveMonoPitchRatio, [1.5]);
const liveEstimate = allocate(5);
assert.equal(wasm.webrc_dsp_extended_pitch_get_estimate(liveMonoPitch,
  liveEstimate.address), Status.noEstimate);
let liveOffset = 0;
let liveCall = 0;
while (liveOffset < liveFrames) {
  const frames = Math.min(partitions[liveCall++ % partitions.length], liveFrames - liveOffset);
  assert.equal(wasm.webrc_dsp_extended_process_mono(liveMonoPitch,
    liveInput.address + liveOffset * 4, liveOutput.address + liveOffset * 4, frames), Status.ok);
  liveOffset += frames;
}
assert.ok(liveOutput.f32.every(Number.isFinite), 'LIVE_MONO emits finite samples over varied quanta');
assertFiniteNonZero(liveOutput.f32.subarray(liveFrames - 8192), 'LIVE_MONO pitch-shifted tail', 1e-5);
assert.equal(wasm.webrc_dsp_extended_pitch_get_estimate(liveMonoPitch,
  liveEstimate.address), Status.ok);
assert.ok(Math.abs(liveEstimate.f32[0] - 55) < 1,
  `LIVE_MONO detector tracks 55 Hz input, got ${liveEstimate.f32[0]}`);
const liveDetectedHz = liveEstimate.f32[0];
let positiveCrossings = 0;
const liveTailStart = liveFrames - 8192;
for (let index = liveTailStart + 1; index < liveFrames; index += 1) {
  if (liveOutput.f32[index - 1] <= 0 && liveOutput.f32[index] > 0) positiveCrossings += 1;
}
const outputFrequency = positiveCrossings * sampleRate / 8192;
assert.ok(Math.abs(outputFrequency - 82.5) < 8,
  `LIVE_MONO resynthesizes near 1.5x to 82.5 Hz, got ${outputFrequency}`);
const liveMetricsBuffer = allocate(22);
assert.equal(wasm.webrc_dsp_extended_pitch_get_metrics(liveMonoPitch,
  liveMetricsBuffer.address), Status.ok);
const liveMetrics = readPitchRuntimeMetrics(liveMetricsBuffer.address);
assert.equal(liveMetrics.preparedKind, Kind.liveMonoPitch);
assert.equal(liveMetrics.analysisBusy, 0xffffffff,
  'LIVE_MONO does not claim analysis idle when its adapter has no busy getter');
assert.equal(liveMetrics.analysisWindowFrames, 4096);
assert.equal(liveMetrics.resynthesisLatencySamples, 3600);
assert.equal(liveMetrics.declaredPathFrames, 7696n,
  'declared window-plus-resynthesis bound is reported independently');
assert.ok(liveMetrics.analysisCount > 0n);
assert.ok(liveMetrics.firstEstimateColdStartFrames >= 4096n &&
  liveMetrics.firstEstimateColdStartFrames <= BigInt(liveFrames));
assert.equal(liveMetrics.pitchRatio, 1.5);
assert.equal(liveMetrics.latencyModel, 2);
assert.ok(liveMetrics.lastWorkUnits <= liveMetrics.workBudget);
const beforeInvalidRatio = liveMetrics.pitchRatio;
const invalidRatioBuffer = allocate(1);
invalidRatioBuffer.f32[0] = Infinity;
assert.equal(wasm.webrc_dsp_extended_configure(liveMonoPitch,
  Control.liveMonoPitchRatio, invalidRatioBuffer.address, 1, 1n), Status.badArgument);
release(invalidRatioBuffer);
assert.equal(wasm.webrc_dsp_extended_pitch_get_metrics(liveMonoPitch,
  liveMetricsBuffer.address), Status.ok);
assert.equal(readPitchRuntimeMetrics(liveMetricsBuffer.address).pitchRatio, beforeInvalidRatio,
  'rejected pitch-ratio control preserves the active candidate state');
assert.equal(wasm.webrc_dsp_extended_reset(liveMonoPitch), Status.ok);
assert.equal(wasm.webrc_dsp_extended_pitch_get_estimate(liveMonoPitch,
  liveEstimate.address), Status.noEstimate,
  'reset clears detector readiness before another input window');
liveEstimate.f32.fill(-11);
assert.equal(wasm.webrc_dsp_extended_pitch_get_estimate(liveMonoPitch,
  liveEstimate.address), Status.noEstimate);
assert.ok(liveEstimate.f32.every(value => value === -11),
  'reset no-estimate result leaves caller memory untouched');
assert.equal(wasm.webrc_dsp_extended_pitch_get_metrics(liveMonoPitch,
  liveMetricsBuffer.address), Status.ok);
assert.equal(readPitchRuntimeMetrics(liveMetricsBuffer.address).analysisCount, 0n);

// F12/F13: explicit complex phase-vocoder and linked-stereo multiband vocoder.
const phaseVocoder = create(Kind.phaseVocoder, [512, 128, 128]);
const spectrumIn = allocate(1024);
const spectrumOut = allocate(1024);
spectrumIn.f32[10] = 1;
assert.equal(wasm.webrc_dsp_extended_process_spectrum(phaseVocoder,
  spectrumIn.address, spectrumOut.address, 1.25), Status.ok);
assert.ok(spectrumOut.f32.every(Number.isFinite));
const vocoder = create(Kind.vocoder, [16, 80, 10000, 1.25], 2);
configure(vocoder, Control.vocoderEnvelope, [3, 80]);
configure(vocoder, Control.vocoderGain, [1]);
assert.equal(wasm.webrc_dsp_extended_process_vocoder(vocoder,
  inputLeft.address, inputRight.address, inputLeft.address, inputRight.address,
  outputLeft.address, outputRight.address, maxBlock), Status.ok);
assertFiniteNonZero(outputLeft.f32, 'linked-stereo vocoder left', 1e-10);
assertFiniteNonZero(outputRight.f32, 'linked-stereo vocoder right', 1e-10);

const stretch = create(Kind.signalsmith, [0, 1, 512, 128, 0], 1, 7n);
configure(stretch, Control.stretchTranspose, [1.25, 0]);
const stretchStatus = wasm.webrc_dsp_extended_process_pitch_stretch(stretch,
  inputLeft.address, 0, 512, outputLeft.address, 0, 512);
assert.equal(stretchStatus, Status.ok);
assertFiniteNonZero(outputLeft.f32, 'Signalsmith mono stretch', 1e-10);
assert.ok(wasm.webrc_dsp_extended_input_latency_samples(stretch) > 0);
assert.ok(wasm.webrc_dsp_extended_output_latency_samples(stretch) > 0);

// F15/F17/F18/F19: prepared stereo texture, FDN, partitioned convolution, freeze.
const granular = create(Kind.granular, [1], 2, 123n);
configure(granular, Control.granularParameters, [40, 30, 0.75, 0.25, 0.8], 123n);
assert.equal(wasm.webrc_dsp_extended_process_stereo(granular,
  inputLeft.address, inputRight.address, outputLeft.address, outputRight.address, maxBlock), Status.ok);
assert.ok(outputLeft.f32.every(Number.isFinite) && outputRight.f32.every(Number.isFinite));

const fdn = create(Kind.fdn, [8, 0.12], 2);
configure(fdn, Control.fdnParameters, [1.2, 8000, 0.17, 0.15, 0.995, 0.65]);
inputLeft.f32.fill(0, 0, maxBlock);
inputRight.f32.fill(0, 0, maxBlock);
inputLeft.f32[0] = 1;
assert.equal(wasm.webrc_dsp_extended_process_stereo(fdn,
  inputLeft.address, inputRight.address, outputLeft.address, outputRight.address, maxBlock), Status.ok);
assertFiniteNonZero(outputLeft.f32, 'FDN reverb left', 1e-10);
assertFiniteNonZero(outputRight.f32, 'FDN reverb right', 1e-10);

const irLL = allocate(64);
const irLR = allocate(64);
const irRL = allocate(64);
const irRR = allocate(64);
irLL.f32[0] = 1;
irRR.f32[0] = 1;
const convolver = wasm.webrc_dsp_extended_create_convolver(sampleRate, maxBlock, 2,
  16, 64, irLL.address, irLR.address, irRL.address, irRR.address);
assert.notEqual(convolver, 0, `partitioned convolver create status ${wasm.webrc_dsp_extended_last_create_status()}`);
handles.push(convolver);
assert.equal(wasm.webrc_dsp_extended_output_latency_samples(convolver), 16);
inputLeft.f32.fill(0, 0, 64);
inputRight.f32.fill(0, 0, 64);
inputLeft.f32[0] = 1;
assert.equal(wasm.webrc_dsp_extended_process_stereo(convolver,
  inputLeft.address, inputRight.address, outputLeft.address, outputRight.address, 64), Status.ok);
assert.ok(outputLeft.f32.subarray(0, 64).some(value => Math.abs(value) > 1e-5),
  'partitioned convolver renders its real impulse response');

const freeze = create(Kind.freeze, [512, 128], 2);
configure(freeze, Control.freeze, [0, 1]);
const invalidFreeze = allocate(2);
invalidFreeze.f32.set([1, Number.NaN]);
assert.equal(wasm.webrc_dsp_extended_configure(freeze, Control.freeze,
  invalidFreeze.address, 2, 0n), Status.badArgument,
  'invalid spectral freeze control is rejected before changing freeze state');
release(invalidFreeze);
fillSine(inputLeft, maxBlock, 440);
fillSine(inputRight, maxBlock, 330, 0.3, 0.2);
assert.equal(wasm.webrc_dsp_extended_process_stereo(freeze,
  inputLeft.address, inputRight.address, outputLeft.address, outputRight.address, maxBlock), Status.ok);
assert.ok(wasm.webrc_dsp_extended_output_latency_samples(freeze) >= 512);
assert.ok(outputLeft.f32.every(Number.isFinite) && outputRight.f32.every(Number.isFinite));

// F25/F26/F24: reverse segment, inertial platter, and seeded drum voice pool.
const reverse = create(Kind.reverse, [2048, 1024, 128], 2);
configure(reverse, Control.reverseSegment, [1024, 128]);
assert.equal(wasm.webrc_dsp_extended_output_latency_samples(reverse), 1920);
let reverseFinite = true;
for (let block = 0; block < 8; block += 1) {
  fillSine(inputLeft, maxBlock, 220 + block, 0.4);
  fillSine(inputRight, maxBlock, 330 + block, 0.25);
  assert.equal(wasm.webrc_dsp_extended_process_stereo(reverse,
    inputLeft.address, inputRight.address, outputLeft.address, outputRight.address, maxBlock), Status.ok);
  reverseFinite &&= outputLeft.f32.every(Number.isFinite) && outputRight.f32.every(Number.isFinite);
}
assert.ok(reverseFinite);

const platter = create(Kind.platter);
configure(platter, Control.platterSpeed, [0.5]);
configure(platter, Control.platterInertia, [2, 0.8]);
const phaseCyclesOut = new Float64Array(memory.buffer, stereoPhaseBuffer.address, maxBlock);
assert.equal(wasm.webrc_dsp_extended_process_platter(platter, outputLeft.address,
  stereoPhaseBuffer.address, outputRight.address, maxBlock), Status.ok);
assert.ok(outputLeft.f32.every(Number.isFinite) && outputRight.f32.every(Number.isFinite));
assert.ok(Array.from(phaseCyclesOut).every(Number.isFinite));

const drums = create(Kind.drums, [], 2, 991n);
const kick = allocate(5);
kick.f32.set([150, 45, 0.08, 0.65, 0.9]);
assert.equal(wasm.webrc_dsp_extended_trigger_drum(drums, 2, kick.address, 20), Status.ok);
assert.equal(wasm.webrc_dsp_extended_process_stereo(drums, 0, 0,
  outputLeft.address, outputRight.address, maxBlock), Status.ok);
assertFiniteNonZero(outputLeft.f32, 'kick voice left', 1e-10);
assertFiniteNonZero(outputRight.f32, 'kick voice right', 1e-10);

// Clean-room rhythm kind 121: immutable 240-pattern/16-kit data, explicit
// absolute frame rendering, real stereo PCM, and partition-invariant output.
assert.equal(wasm.webrc_dsp_extended_rhythm_pattern_count(), 240);
assert.equal(wasm.webrc_dsp_extended_rhythm_kit_count(), 16);
assert.equal(readCString(wasm.webrc_dsp_extended_rhythm_patterns_sha256()),
  'd0c9efa799f2a48193c426e2f5cb54182c6f564da6a8f90c7070785654b89115');
assert.equal(readCString(wasm.webrc_dsp_extended_rhythm_kits_sha256()),
  'af2315cd8bba5d60a8b7125ef7afef4f8bb359ebdd9475bda617e6129468c3f0');
const rhythmMetrics = allocate(14);
const rhythmMetricsView = new DataView(memory.buffer, rhythmMetrics.address, 56);
const rhythmProfiles = [
  ['uniform-64', 64], ['uniform-128', 128], ['uniform-256', 256],
  ['uniform-512', 512], ['mixed-64-512', 0],
];
let referenceRhythmLeft;
let referenceRhythmRight;
for (const [profile, fixedFrames] of rhythmProfiles) {
  const rhythm = create(Kind.rhythm, [0, 0, 120], 2);
  assert.equal(wasm.webrc_dsp_extended_output_latency_samples(rhythm), 0);
  assert.equal(wasm.webrc_dsp_extended_rhythm_algorithmic_latency_samples(rhythm), 0);
  assert.equal(wasm.webrc_dsp_extended_rhythm_set_pattern(rhythm, 240), Status.badArgument,
    'out-of-range pattern selection is rejected');
  assert.equal(wasm.webrc_dsp_extended_rhythm_set_kit(rhythm, 16), Status.badArgument,
    'out-of-range kit selection is rejected');
  assert.equal(wasm.webrc_dsp_extended_rhythm_queue_pattern_kit(rhythm, 240, 0), Status.badArgument,
    'queued out-of-range clean-room pattern is rejected');
  assert.equal(wasm.webrc_dsp_extended_rhythm_queue_pattern_kit(rhythm, 1, 7), Status.ok,
    'a valid pattern/kit pair is queued for the next downbeat');
  assert.equal(wasm.webrc_dsp_extended_rhythm_queue_variation(rhythm, 0), Status.ok);
  assert.equal(wasm.webrc_dsp_extended_rhythm_queue_tempo(rhythm, 120), Status.ok);
  assert.equal(wasm.webrc_dsp_extended_rhythm_start_words(rhythm, 0, 0, 0), Status.ok);
  assert.equal(wasm.webrc_dsp_extended_rhythm_start_words(rhythm, 0, 0, 0), Status.badArgument,
    'a duplicate start request is rejected');
  const renderedLeft = new Float32Array(15360);
  const renderedRight = new Float32Array(15360);
  let frame = 0;
  let mixedCursor = 0;
  const mixed = [64, 128, 256, 512];
  while (frame < renderedLeft.length) {
    const requested = fixedFrames || mixed[mixedCursor++ % mixed.length];
    const blockFrames = Math.min(requested, renderedLeft.length - frame);
    const result = wasm.webrc_dsp_extended_rhythm_process_block_words(
      rhythm, frame >>> 0, Math.floor(frame / 0x1_0000_0000) >>> 0,
      outputLeft.address, outputRight.address, blockFrames);
    assert.equal(result, Status.ok, `${profile} processes frame ${frame} (${blockFrames})`);
    assert.ok(outputLeft.f32.subarray(0, blockFrames).every(Number.isFinite));
    assert.ok(outputRight.f32.subarray(0, blockFrames).every(Number.isFinite));
    renderedLeft.set(outputLeft.f32.subarray(0, blockFrames), frame);
    renderedRight.set(outputRight.f32.subarray(0, blockFrames), frame);
    frame += blockFrames;
  }
  assertFiniteNonZero(renderedLeft, `${profile} clean-room rhythm left`, 1e-7);
  assertFiniteNonZero(renderedRight, `${profile} clean-room rhythm right`, 1e-7);
  assert.equal(wasm.webrc_dsp_extended_rhythm_get_metrics(rhythm, rhythmMetrics.address), Status.ok);
  assert.equal(rhythmMetricsView.getUint32(0, true), 1, 'renderer remains in playback');
  assert.equal(wasm.webrc_dsp_extended_rhythm_selected_pattern(rhythm), 1);
  assert.equal(wasm.webrc_dsp_extended_rhythm_selected_kit(rhythm), 7);
  assert.equal(wasm.webrc_dsp_extended_rhythm_is_playing(rhythm), 1);
  assert.ok(rhythmMetricsView.getUint32(12, true) > 0, 'drum voices were triggered');
  assert.ok(rhythmMetricsView.getBigUint64(32, true) > 0n, 'rhythm events were triggered');
  const thisLeftBytes = Buffer.from(renderedLeft.buffer);
  const thisRightBytes = Buffer.from(renderedRight.buffer);
  if (!referenceRhythmLeft) {
    referenceRhythmLeft = thisLeftBytes;
    referenceRhythmRight = thisRightBytes;
  } else {
    assert.deepEqual(thisLeftBytes, referenceRhythmLeft, `${profile} left PCM matches other partitions`);
    assert.deepEqual(thisRightBytes, referenceRhythmRight, `${profile} right PCM matches other partitions`);
  }
}
assert.equal(wasm.webrc_dsp_extended_rhythm_queue_fill(handles.at(-1)), Status.ok);
assert.equal(wasm.webrc_dsp_extended_rhythm_queue_ending(handles.at(-1)), Status.ok);
assert.equal(wasm.webrc_dsp_extended_rhythm_queue_stop(handles.at(-1)), Status.ok);

const rhythmGap = create(Kind.rhythm, [0, 0, 120], 2);
assert.equal(wasm.webrc_dsp_extended_rhythm_process_block(rhythmGap, 0n,
  outputLeft.address, outputRight.address, 64), Status.ok);
outputLeft.f32.fill(1, 0, 64);
outputRight.f32.fill(1, 0, 64);
assert.equal(wasm.webrc_dsp_extended_rhythm_process_block(rhythmGap, 128n,
  outputLeft.address, outputRight.address, 64), Status.badArgument,
  'noncontiguous rhythm frame ranges fail closed');
assert.ok(outputLeft.f32.subarray(0, 64).every(value => value === 0));
assert.ok(outputRight.f32.subarray(0, 64).every(value => value === 0));

// Utilities shared by the portable STFT and reverb code.
const fftBuffer = allocate(16);
fftBuffer.f32[0] = 1;
assert.equal(wasm.webrc_dsp_extended_fft_transform(fftBuffer.address, 8, 0), Status.ok);
assert.ok(fftBuffer.f32.every(Number.isFinite));
assert.equal(wasm.webrc_dsp_extended_normalized_hadamard(fftBuffer.address, 8), Status.ok);
const ratio = allocate(1);
assert.equal(wasm.webrc_dsp_extended_pitch_ratio(12, ratio.address), Status.ok);
assert.ok(Math.abs(ratio.f32[0] - 2) < 1e-6);

// Mixed base + extended + transfer allocations share the same explicit ledger.
const beforeRejection = wasm.webrc_dsp_managed_memory_bytes();
assert.ok(beforeRejection > 0);
assert.ok(beforeRejection <= wasm.webrc_dsp_managed_memory_capacity_bytes());
assert.equal(wasm.memory.buffer.byteLength, initialMemoryBytes);
for (const handle of handles) assert.equal(wasm.webrc_dsp_extended_destroy(handle), Status.ok);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), allocations.reduce((sum, item) =>
  sum + item.frames * 4 + 1024, 0));
for (const buffer of [...allocations]) release(buffer);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), 0);
assert.equal(wasm.memory.buffer.byteLength, initialMemoryBytes);
assert.deepEqual(wasiCalls, { fd_close: 0, fd_write: 0, fd_seek: 0 });

console.log(JSON.stringify({
  suite: 'shared-dsp-wasm-extended-smoke',
  wasmSha256: manifest.artifact.sha256,
  sourceSetSha256: manifest.sourceSetSha256,
  extendedKindsCreated: Object.values(Kind),
  pitchProbe: {
    incrementalYinInputHz: 220,
    incrementalYinEstimatedHz: incrementalEstimate.f32[0],
    incrementalAnalysisCount: incrementalMetrics.analysisCount.toString(),
    incrementalFirstEstimateFrames: incrementalMetrics.firstEstimateColdStartFrames.toString(),
    incrementalLastWorkUnits: incrementalMetrics.lastWorkUnits,
    incrementalWorkBudget: incrementalMetrics.workBudget,
    liveMonoInputHz: 55,
    liveMonoDetectedHz: liveDetectedHz,
    liveMonoOutputZeroCrossingHz: outputFrequency,
    liveMonoDeclaredWindowPlusResynthesisFrames: liveMetrics.declaredPathFrames.toString(),
    liveMonoFirstEstimateFrames: liveMetrics.firstEstimateColdStartFrames.toString(),
    liveMonoProcessingLagFrames: liveMetrics.processingLagFrames,
    liveMonoEstimateAgeFrames: liveMetrics.estimateAgeFrames,
    liveMonoLatencyModel: liveMetrics.latencyModel,
  },
  capabilities: wasm.webrc_dsp_capabilities(),
  memoryBytes: initialMemoryBytes,
  wasiCalls,
  result: 'PASS',
}, null, 2));
