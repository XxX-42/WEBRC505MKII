import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 48_000;
const repositoryRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const modulePath = resolve(process.argv[2] ?? 'test-results/dsp-wasm/webrc-dsp.wasm');
const nativeGoldenPath = resolve(process.argv[3] ?? 'shared/dsp/benchmarks/results/native_primitives_golden.json');
const moduleBytes = await readFile(modulePath);
const manifestPath = resolve(process.argv[4] ?? modulePath.replace(/\.wasm$/i, '.build.json'));
const buildManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(buildManifest.schemaVersion, 1, 'WASM build manifest schema');
assert.equal(buildManifest.sourceFilesStableDuringBuild, true, 'compiled inputs stayed stable for this build');
assert.equal(buildManifest.artifact.byteLength, moduleBytes.byteLength);
assert.equal(buildManifest.artifact.sha256, sha256(moduleBytes), 'WASM artifact matches its build manifest');
assert.equal(buildManifest.build.emsdkCommit, '35ff8a6d150541276abbc6bae512ca90bcfbe220');
assert.match(buildManifest.build.compilerIdentity, /6\.0\.10 \(d6c521a7f05449857c76bd99e396895583cf2083\)$/);
assert.ok(buildManifest.build.flags.includes('-fno-exceptions'));
assert.ok(buildManifest.build.flags.includes('-fno-rtti'));
assert.ok(buildManifest.build.flags.includes('-sALLOW_MEMORY_GROWTH=0'));
assert.ok(buildManifest.build.flags.includes('-sINITIAL_MEMORY=67108864'));
const canonicalSourceSet = Object.keys(buildManifest.sourceFiles ?? {}).sort()
  .map(relativePath => `${relativePath}=${buildManifest.sourceFiles[relativePath]}`).join('\n');
assert.equal(buildManifest.sourceSetSha256, sha256(Buffer.from(canonicalSourceSet, 'utf8')),
  'source-set digest matches the manifest file hashes');
for (const [relativePath, expectedSha256] of Object.entries(buildManifest.sourceFiles ?? {})) {
  const currentSha256 = sha256(await readFile(resolve(repositoryRoot, relativePath)));
  assert.equal(currentSha256, expectedSha256,
    `current source ${relativePath} differs from the source set that produced this WASM; rebuild before acceptance`);
}
const nativeGolden = JSON.parse(await readFile(nativeGoldenPath, 'utf8'));
assert.equal(nativeGolden.schemaVersion, 1, 'Native PCM runner schema');
assert.equal(nativeGolden.sampleRate, SAMPLE_RATE);
assert.equal(nativeGolden.frames, 32);
const wasmModule = await WebAssembly.compile(moduleBytes);
const wasmImports = WebAssembly.Module.imports(wasmModule);
assert.deepEqual(wasmImports.map(({ module, name, kind }) => [module, name, kind]), [
  ['wasi_snapshot_preview1', 'fd_close', 'function'],
  ['wasi_snapshot_preview1', 'fd_write', 'function'],
  ['wasi_snapshot_preview1', 'fd_seek', 'function'],
], 'standalone WASM must have only the documented, unused WASI stdio imports');
const wasiIoCalls = { fd_close: 0, fd_write: 0, fd_seek: 0 };
const WASI_EBADF = 8;
const wasiSnapshotPreview1 = {
  fd_close(_fd) {
    wasiIoCalls.fd_close += 1;
    return WASI_EBADF;
  },
  fd_write(_fd, _iov, _iovcnt, _written) {
    wasiIoCalls.fd_write += 1;
    return WASI_EBADF;
  },
  fd_seek(_fd, _offset, _whence, _newOffset) {
    wasiIoCalls.fd_seek += 1;
    return WASI_EBADF;
  },
};
const instance = await WebAssembly.instantiate(wasmModule, { wasi_snapshot_preview1: wasiSnapshotPreview1 });
const exports = instance.exports;
exports._initialize();
const wasm = { ...exports, HEAPF32: new Float32Array(exports.memory.buffer) };
for (const name of [
  'webrc_dsp_api_version', 'webrc_dsp_abi_version', 'webrc_dsp_extended_api_version',
  'webrc_dsp_capabilities', 'webrc_dsp_max_block_frames', 'webrc_dsp_last_create_status',
  'webrc_dsp_managed_memory_bytes', 'webrc_dsp_managed_memory_capacity_bytes',
  'webrc_dsp_create', 'webrc_dsp_destroy', 'webrc_dsp_reset', 'webrc_dsp_configure',
  'webrc_dsp_seed', 'webrc_dsp_process', 'webrc_dsp_equal_power_crossfade',
  'webrc_dsp_equal_power_pan', 'webrc_dsp_sinc8_read', 'webrc_dsp_sinc8_lookahead_samples',
  'webrc_dsp_alloc_f32', 'webrc_dsp_free', 'webrc_dsp_alloc_f32_token',
  'webrc_dsp_transfer_address', 'webrc_dsp_free_transfer_token',
  'webrc_dsp_extended_create', 'webrc_dsp_extended_last_create_status',
  'webrc_dsp_extended_destroy', 'webrc_dsp_extended_process_mono',
]) {
  wasm[`_${name}`] = exports[name];
}
assert.equal(typeof wasm._initialize, 'function');

const Kind = {
  smoother: 1,
  biquad: 2,
  svf: 3,
  lagrange: 5,
  delayMatrix: 10,
};
const Control = {
  smootherTarget: 1,
  biquadLowpass: 2,
  svfFrequencyQ: 6,
  delayMatrixFeedback: 13,
};
const Status = { ok: 0, badHandle: -1, blockTooLarge: -4, memoryBudget: -7, badKind: -3 };
const ExtKind = { wdfDiode: 100 };
const MAX_BLOCK = 512;
const bytesBefore = wasm.HEAPF32.buffer.byteLength;
assert.equal(bytesBefore, 64 * 1024 * 1024, 'WASM memory is fixed at the build-time reservation');
assert.equal(wasm._webrc_dsp_api_version(), 1);
assert.equal(wasm._webrc_dsp_abi_version(), 2);
assert.equal(wasm._webrc_dsp_extended_api_version(), 1);
assert.equal(wasm._webrc_dsp_capabilities(), 0x00000003);
assert.equal(wasm.malloc, undefined, 'raw malloc is not exported to callback clients');
let transferAllocationBytes = 0;

function allocate(frames) {
  const address = wasm._webrc_dsp_alloc_f32(frames);
  assert.ok(address !== 0, `unable to reserve ${frames} transfer frames`);
  transferAllocationBytes += frames * Float32Array.BYTES_PER_ELEMENT + 1024;
  return { address, view: new Float32Array(wasm.HEAPF32.buffer, address, frames) };
}

function create(kind, maxDelaySamples = 0) {
  const handle = wasm._webrc_dsp_create(kind, SAMPLE_RATE, MAX_BLOCK, 1, maxDelaySamples);
  assert.ok(handle !== 0, `create failed with status ${wasm._webrc_dsp_last_create_status()}`);
  assert.equal(wasm._webrc_dsp_last_create_status(), Status.ok);
  return handle;
}

function createExtended(kind, parameters = [], seed = 1n) {
  let parameterAddress = 0;
  if (parameters.length) {
    const buffer = allocate(parameters.length);
    buffer.view.set(parameters);
    parameterAddress = buffer.address;
  }
  const handle = wasm._webrc_dsp_extended_create(kind, SAMPLE_RATE, MAX_BLOCK, 1,
    parameterAddress, parameters.length, seed);
  assert.ok(handle !== 0, `extended create failed with status ${wasm._webrc_dsp_extended_last_create_status()}`);
  assert.equal(wasm._webrc_dsp_extended_last_create_status(), Status.ok);
  return handle;
}

function assertPcm(actual, expected, label, tolerance = 2e-7) {
  assert.equal(actual.length, expected.length, `${label}: sample count`);
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(Number.isFinite(actual[i]), `${label}[${i}] must be finite`);
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance,
      `${label}[${i}] expected ${expected[i]}, received ${actual[i]}`);
  }
}

const input = allocate(MAX_BLOCK);
const output = allocate(MAX_BLOCK);
const outputRight = allocate(MAX_BLOCK);
const outputAux = allocate(MAX_BLOCK);
const parameters = allocate(MAX_BLOCK * 2);
const leftGain = allocate(1);
const rightGain = allocate(1);
const scalar = allocate(1);

const firstTransferToken = wasm._webrc_dsp_alloc_f32_token(64);
assert.ok(firstTransferToken !== 0, 'token-aware transfer allocation succeeds');
const firstTransferAddress = wasm._webrc_dsp_transfer_address(firstTransferToken);
assert.ok(firstTransferAddress !== 0, 'valid transfer token resolves its address');
assert.equal(wasm._webrc_dsp_destroy(firstTransferToken), Status.badKind,
  'base destroy rejects a transfer-domain token');
assert.equal(wasm._webrc_dsp_free_transfer_token(firstTransferToken), Status.ok);
assert.equal(wasm._webrc_dsp_free_transfer_token(firstTransferToken), Status.badHandle,
  'double token free is rejected');
assert.equal(wasm._webrc_dsp_transfer_address(firstTransferToken), 0,
  'stale token cannot resolve an address');
const replacementTransferToken = wasm._webrc_dsp_alloc_f32_token(64);
assert.ok(replacementTransferToken !== 0 && replacementTransferToken !== firstTransferToken,
  'transfer slot reuse advances its generation');
const replacementTransferAddress = wasm._webrc_dsp_transfer_address(replacementTransferToken);
assert.equal(replacementTransferAddress, firstTransferAddress,
  'the allocator reuses this same-size freed transfer address in the stale-token regression');
assert.equal(wasm._webrc_dsp_free_transfer_token(firstTransferToken), Status.badHandle,
  'stale free cannot release a later transfer even if malloc reuses its address');
assert.equal(wasm._webrc_dsp_transfer_address(replacementTransferToken), replacementTransferAddress);
assert.equal(wasm._webrc_dsp_free_transfer_token(replacementTransferToken), Status.ok);

assert.equal(wasm._webrc_dsp_equal_power_crossfade(1, 0, 0.5, scalar.address), Status.ok);
assertPcm([scalar.view[0]], [0.7071067811865476], 'equal-power center crossfade', 2e-8);
assert.equal(wasm._webrc_dsp_equal_power_pan(0, leftGain.address, rightGain.address), Status.ok);
assertPcm([leftGain.view[0], rightGain.view[0]],
  [0.7071067811865476, 0.7071067811865475], 'equal-power center pan', 2e-8);
assert.equal(wasm._webrc_dsp_sinc8_lookahead_samples(), 4);

const smoother = create(Kind.smoother);
assert.equal(wasm._webrc_dsp_extended_destroy(smoother), Status.badKind,
  'extended destroy rejects a live base-domain handle');
assert.equal(wasm._webrc_dsp_free_transfer_token(smoother), Status.badKind,
  'transfer free rejects a live base-domain handle');
const smootherControl = allocate(2);
smootherControl.view.set([1, 10]);
assert.equal(wasm._webrc_dsp_configure(smoother, Control.smootherTarget,
  smootherControl.address, 2), Status.ok);
assert.equal(wasm._webrc_dsp_process(smoother, 0, 0, output.address, 0, 0, 0, 4), Status.ok);
assertPcm(output.view.subarray(0, 4), [
  0.002081155776977539,
  0.004157980438321829,
  0.006230482831597328,
  0.008298671804368496,
], '48 kHz 10 ms parameter smoother PCM');

const biquad = create(Kind.biquad);
const filterControl = allocate(3);
filterControl.view.set([1000, Math.SQRT1_2, 0]);
input.view.fill(0, 0, 8);
input.view[0] = 1;
assert.equal(wasm._webrc_dsp_configure(biquad, Control.biquadLowpass,
  filterControl.address, 3), Status.ok);
assert.equal(wasm._webrc_dsp_process(biquad, input.address, 0, output.address, 0, 0, 0, 8), Status.ok);
assertPcm(output.view.subarray(0, 8), [
  0.003916126675903797,
  0.01494135893881321,
  0.027785466983914375,
  0.03802374750375748,
  0.04593619331717491,
  0.05179191380739212,
  0.05584675818681717,
  0.05834154412150383,
], 'RBJ low-pass impulse PCM', 4e-7);

const svf = create(Kind.svf);
const svfControl = allocate(3);
svfControl.view.set([1000, Math.SQRT1_2, 0]);
input.view.fill(0, 0, 4);
input.view[0] = 1;
assert.equal(wasm._webrc_dsp_configure(svf, Control.svfFrequencyQ,
  svfControl.address, 3), Status.ok);
assert.equal(wasm._webrc_dsp_process(svf, input.address, 0, output.address,
  outputRight.address, outputAux.address, 0, 4), Status.ok);
// TPT SVF impulse reference at 48 kHz/1 kHz, Q=sqrt(1/2), no coefficient ramp.
assertPcm(output.view.subarray(0, 4), [
  0.003916126675903797,
  0.01494135893881321,
  0.027785466983914375,
  0.03802374377846718,
], 'TPT SVF low output PCM', 5e-7);
assertPcm(outputRight.view.subarray(0, 4), [
  0.05974854901432991,
  0.10846399515867233,
  0.0874992161989212,
  0.06870673596858978,
], 'TPT SVF band output PCM', 5e-7);
assertPcm(outputAux.view.subarray(0, 4), [
  0.9115866422653198,
  -0.16833262145519257,
  -0.15152804553508759,
  -0.1351897418498993,
], 'TPT SVF high output PCM', 5e-7);

const delayFrames = [0, 0, 0, 0, 0, 0, 0, 0];
input.view.set([1, 0, 0, 0, 0, 0, 0, 0]);
parameters.view.fill(3, 0, delayFrames.length);
const lagrange = create(Kind.lagrange, 64);
assert.equal(wasm._webrc_dsp_process(lagrange, input.address, 0, output.address,
  0, 0, parameters.address, delayFrames.length), Status.ok);
assertPcm(output.view.subarray(0, delayFrames.length), [0, 0, 0, 1, 0, 0, 0, 0],
  'three-sample Lagrange delay impulse', 0);

const sincInput = allocate(8);
sincInput.view.set([0, 0, 1, 0, 0, 0, 0, 0]);
const sincOutput = wasm._webrc_dsp_sinc8_read(sincInput.address, 8, 2, 0);
assert.ok(Math.abs(sincOutput - 1) < 2e-7, `sinc8 integer read expected unity, got ${sincOutput}`);

const delayMatrix = create(Kind.delayMatrix);
const delayFeedbackControl = allocate(2);
delayFeedbackControl.view.set([0.2, 0.1]);
assert.equal(wasm._webrc_dsp_configure(delayMatrix, Control.delayMatrixFeedback,
  delayFeedbackControl.address, 2), Status.ok);
input.view.fill(0, 0, 2);
input.view[0] = 1;
outputRight.view.fill(0, 0, 2);
parameters.view.fill(0, 0, 4);
parameters.view[0] = 0.5;
parameters.view[2] = 0.25;
assert.equal(wasm._webrc_dsp_process(delayMatrix, input.address, outputRight.address,
  output.address, outputAux.address, 0, parameters.address, 2), Status.ok);
assertPcm([output.view[0], outputAux.view[0]], [1.125, 0.1], 'stereo delay feedback matrix');
assert.equal(wasm._webrc_dsp_reset(delayMatrix), Status.ok);

const extendedWdf = createExtended(ExtKind.wdfDiode);
assert.equal(wasm._webrc_dsp_destroy(extendedWdf), Status.badKind,
  'base destroy rejects an extended-domain handle');
assert.equal(wasm._webrc_dsp_extended_destroy(biquad), Status.badKind,
  'extended destroy rejects a base-domain handle');
assert.equal(wasm._webrc_dsp_extended_process_mono(biquad, input.address, output.address, 8), Status.badKind,
  'extended processor rejects a base-domain handle');
input.view.fill(0, 0, 32);
input.view[0] = 1;
assert.equal(wasm._webrc_dsp_extended_process_mono(extendedWdf, input.address, output.address, 32), Status.ok);
const preservedExtendedPcm = Array.from(output.view.subarray(0, 32));

const fixtureHandles = [];
const fixtureBuffers = [];
function fixtureBuffer(values) {
  const buffer = allocate(values.length);
  buffer.view.set(values);
  fixtureBuffers.push(buffer);
  return buffer;
}
function createGoldenHandle(kind) {
  const handle = create(kind);
  fixtureHandles.push(handle);
  return handle;
}
function compareNativeFixture(name, actual, channel = 'output') {
  const reference = nativeGolden.fixtures[name]?.[channel];
  assert.ok(Array.isArray(reference), `Native fixture ${name}.${channel} exists`);
  assertPcm(actual, reference, `Native/WASM ${name}.${channel}`, 1.1e-6);
}

const nativeBiquad = nativeGolden.fixtures.biquad_lowpass;
const nativeBiquadInput = fixtureBuffer(nativeBiquad.input);
const nativeBiquadParams = fixtureBuffer([nativeBiquad.parameters.frequencyHz, nativeBiquad.parameters.q, 0]);
const nativeBiquadHandle = createGoldenHandle(Kind.biquad);
assert.equal(wasm._webrc_dsp_configure(nativeBiquadHandle, Control.biquadLowpass,
  nativeBiquadParams.address, 3), Status.ok);
assert.equal(wasm._webrc_dsp_process(nativeBiquadHandle, nativeBiquadInput.address, 0,
  output.address, 0, 0, 0, nativeGolden.frames), Status.ok);
compareNativeFixture('biquad_lowpass', output.view.subarray(0, nativeGolden.frames));

const nativeAllpass = nativeGolden.fixtures.allpass1;
const nativeAllpassInput = fixtureBuffer(nativeAllpass.input);
const nativeAllpassParams = fixtureBuffer([nativeAllpass.parameters.phaseCenterHz, 0]);
const nativeAllpassHandle = createGoldenHandle(4);
assert.equal(wasm._webrc_dsp_configure(nativeAllpassHandle, 7, nativeAllpassParams.address, 2), Status.ok);
assert.equal(wasm._webrc_dsp_process(nativeAllpassHandle, nativeAllpassInput.address, 0,
  output.address, 0, 0, 0, nativeGolden.frames), Status.ok);
compareNativeFixture('allpass1', output.view.subarray(0, nativeGolden.frames));

const nativeSvf = nativeGolden.fixtures.tpt_svf;
const nativeSvfInput = fixtureBuffer(nativeSvf.input);
const nativeSvfParams = fixtureBuffer([nativeSvf.parameters.frequencyHz, nativeSvf.parameters.q, 0]);
const nativeSvfHandle = createGoldenHandle(Kind.svf);
assert.equal(wasm._webrc_dsp_configure(nativeSvfHandle, Control.svfFrequencyQ,
  nativeSvfParams.address, 3), Status.ok);
assert.equal(wasm._webrc_dsp_process(nativeSvfHandle, nativeSvfInput.address, 0,
  output.address, outputRight.address, outputAux.address, 0, nativeGolden.frames), Status.ok);
compareNativeFixture('tpt_svf', output.view.subarray(0, nativeGolden.frames), 'low');
compareNativeFixture('tpt_svf', outputRight.view.subarray(0, nativeGolden.frames), 'band');
compareNativeFixture('tpt_svf', outputAux.view.subarray(0, nativeGolden.frames), 'high');

const nativeAdaa = nativeGolden.fixtures.adaa_cubic;
const nativeAdaaInput = fixtureBuffer(nativeAdaa.input);
const nativeAdaaParams = fixtureBuffer([nativeAdaa.parameters.drive]);
const nativeAdaaHandle = createGoldenHandle(8);
assert.equal(wasm._webrc_dsp_configure(nativeAdaaHandle, 11, nativeAdaaParams.address, 1), Status.ok);
assert.equal(wasm._webrc_dsp_process(nativeAdaaHandle, nativeAdaaInput.address, 0,
  output.address, 0, 0, 0, nativeGolden.frames), Status.ok);
compareNativeFixture('adaa_cubic', output.view.subarray(0, nativeGolden.frames));

const nativeCompressor = nativeGolden.fixtures.dual_detector_compressor;
const nativeCompressorLeft = fixtureBuffer(nativeCompressor.inputLeft);
const nativeCompressorRight = fixtureBuffer(nativeCompressor.inputRight);
const nativeCompressorParams = fixtureBuffer([
  nativeCompressor.parameters.thresholdDb,
  nativeCompressor.parameters.ratio,
  nativeCompressor.parameters.kneeDb,
  nativeCompressor.parameters.attackMs,
  nativeCompressor.parameters.releaseMs,
  nativeCompressor.parameters.rmsMix,
  nativeCompressor.parameters.makeupDb,
]);
const nativeCompressorHandle = createGoldenHandle(9);
assert.equal(wasm._webrc_dsp_configure(nativeCompressorHandle, 12,
  nativeCompressorParams.address, 7), Status.ok);
assert.equal(wasm._webrc_dsp_process(nativeCompressorHandle, nativeCompressorLeft.address,
  nativeCompressorRight.address, output.address, outputRight.address, 0, 0, nativeGolden.frames), Status.ok);
compareNativeFixture('dual_detector_compressor', output.view.subarray(0, nativeGolden.frames), 'outputLeft');
compareNativeFixture('dual_detector_compressor', outputRight.view.subarray(0, nativeGolden.frames), 'outputRight');

const isolatedCompressor = createGoldenHandle(9);
assert.equal(wasm._webrc_dsp_configure(isolatedCompressor, 12, nativeCompressorParams.address, 7), Status.ok);
const silence = fixtureBuffer(new Array(nativeGolden.frames).fill(0));
assert.equal(wasm._webrc_dsp_process(isolatedCompressor, nativeCompressorLeft.address, silence.address,
  output.address, outputRight.address, 0, 0, nativeGolden.frames), Status.ok);
assertPcm(outputRight.view.subarray(0, nativeGolden.frames),
  new Array(nativeGolden.frames).fill(0), 'compressor no right-to-left channel synthesis', 0);

const nativeOscillator = nativeGolden.fixtures.polyblep_triangle;
const oscillatorFrequency = fixtureBuffer([nativeOscillator.parameters.frequencyHz]);
const oscillatorWaveform = fixtureBuffer([3]);
const nativeOscillatorHandle = createGoldenHandle(7);
assert.equal(wasm._webrc_dsp_configure(nativeOscillatorHandle, 9, oscillatorFrequency.address, 1), Status.ok);
assert.equal(wasm._webrc_dsp_configure(nativeOscillatorHandle, 10, oscillatorWaveform.address, 1), Status.ok);
assert.equal(wasm._webrc_dsp_process(nativeOscillatorHandle, 0, 0,
  output.address, 0, 0, 0, nativeGolden.frames), Status.ok);
compareNativeFixture('polyblep_triangle', output.view.subarray(0, nativeGolden.frames));
const transferMemoryBytes = transferAllocationBytes;

for (const frames of [64, 128, 256, 512]) {
  input.view.fill(0.125, 0, frames);
  assert.equal(wasm._webrc_dsp_process(biquad, input.address, 0, output.address, 0, 0, 0, frames), Status.ok,
    `${frames}-frame block should be accepted`);
}
assert.equal(wasm._webrc_dsp_process(biquad, input.address, 0, output.address,
  0, 0, 0, MAX_BLOCK + 1), Status.blockTooLarge,
'oversize block must be rejected before touching the DSP state');

input.view.fill(0, 0, 32);
input.view[0] = 1;
assert.equal(wasm._webrc_dsp_reset(biquad), Status.ok);
assert.equal(wasm._webrc_dsp_process(biquad, input.address, 0, output.address, 0, 0, 0, 32), Status.ok);
const preservedPcm = Array.from(output.view.subarray(0, 32));
assert.equal(wasm._webrc_dsp_reset(biquad), Status.ok);

const staleHandle = lagrange;
assert.equal(wasm._webrc_dsp_destroy(staleHandle), Status.ok);
const reusedSlot = create(Kind.smoother);
assert.notEqual(reusedSlot, staleHandle, 'slot reuse increments the opaque handle generation');
assert.equal(wasm._webrc_dsp_reset(staleHandle), Status.badHandle);
assert.equal(wasm._webrc_dsp_destroy(staleHandle), Status.badHandle);
assert.equal(wasm._webrc_dsp_process(reusedSlot, 0, 0, output.address, 0, 0, 0, 1), Status.ok);

const memoryBeforeOversizeCreate = wasm._webrc_dsp_managed_memory_bytes();
const largeDelayHandles = [];
while (true) {
  const handle = wasm._webrc_dsp_create(Kind.lagrange, SAMPLE_RATE, MAX_BLOCK, 1, SAMPLE_RATE * 10);
  if (handle === 0) break;
  largeDelayHandles.push(handle);
}
assert.equal(wasm._webrc_dsp_last_create_status(), Status.memoryBudget,
  'delay rings that exceed the explicit state budget are rejected on setup');
assert.ok(largeDelayHandles.length > 0, 'budget test filled multiple prepared delay rings');
assert.ok(wasm._webrc_dsp_managed_memory_bytes() <= wasm._webrc_dsp_managed_memory_capacity_bytes());
assert.ok(wasm._webrc_dsp_managed_memory_bytes() > memoryBeforeOversizeCreate);
input.view.fill(0.25, 0, 64);
input.view.fill(0, 0, 32);
input.view[0] = 1;
assert.equal(wasm._webrc_dsp_process(biquad, input.address, 0, output.address, 0, 0, 0, 32), Status.ok,
  'an allocation-budget rejection must leave previously created DSP states usable');
assertPcm(output.view.subarray(0, 32), preservedPcm,
  'allocation-budget rejection leaves the active processor state/configuration usable', 1e-7);
input.view.fill(0, 0, 32);
input.view[0] = 1;
assert.equal(wasm._webrc_dsp_extended_process_mono(extendedWdf, input.address, output.address, 32), Status.ok,
  'the shared ledger rejection leaves an extended processor active');
assertPcm(output.view.subarray(0, 32), preservedExtendedPcm,
  'shared-ledger rejection leaves extended PCM unchanged', 1e-7);

const bytesAfterRendering = wasm.HEAPF32.buffer.byteLength;
assert.equal(bytesAfterRendering, bytesBefore, 'process calls never grow linear memory');

for (const handle of largeDelayHandles) assert.equal(wasm._webrc_dsp_destroy(handle), Status.ok);
for (const handle of [...fixtureHandles, smoother, biquad, svf, delayMatrix, reusedSlot]) {
  assert.equal(wasm._webrc_dsp_destroy(handle), Status.ok);
}
assert.equal(wasm._webrc_dsp_extended_destroy(extendedWdf), Status.ok);
assert.equal(wasm._webrc_dsp_extended_destroy(extendedWdf), Status.badHandle,
  'extended destroy rejects a stale/double-destroyed handle');
assert.equal(wasm._webrc_dsp_managed_memory_bytes(), transferMemoryBytes,
  'destroy releases DSP states while leaving setup transfer buffers reserved');

for (const buffer of [input, output, outputRight, outputAux, parameters, leftGain,
  rightGain, scalar, smootherControl, filterControl, svfControl, delayFeedbackControl, sincInput,
  ...fixtureBuffers]) {
  wasm._webrc_dsp_free(buffer.address);
}
assert.equal(wasm._webrc_dsp_managed_memory_bytes(), 0, 'setup transfer buffers are accounted and released');
assert.equal(wasm.HEAPF32.buffer.byteLength, bytesBefore);
assert.deepEqual(wasiIoCalls, { fd_close: 0, fd_write: 0, fd_seek: 0 },
  'all WASI stdio/file imports fail closed and remain unused during the DSP suite');

console.log(JSON.stringify({
  suite: 'shared-dsp-wasm-golden',
  apiVersion: wasm._webrc_dsp_api_version(),
  abiVersion: wasm._webrc_dsp_abi_version(),
  wasmMemoryBytes: bytesBefore,
  maxBlockFramesTested: [64, 128, 256, 512],
  nativeGoldenFixturesCompared: ['biquad_lowpass', 'allpass1', 'tpt_svf',
    'adaa_cubic', 'dual_detector_compressor', 'polyblep_triangle'],
  wasiIoCalls,
  maxDelayRingsBeforeBudgetRejection: largeDelayHandles.length,
  result: 'PASS',
}, null, 2));
