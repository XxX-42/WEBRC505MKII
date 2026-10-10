import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const modulePath = path.resolve(process.argv[2] ?? 'test-results/dsp-wasm/webrc-dsp.wasm');
const manifestPath = path.resolve(process.argv[3] ?? 'test-results/dsp-wasm/webrc-dsp.build.json');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const manifestBytes = await fs.readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
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

const module = await WebAssembly.compile(moduleBytes);
assert.deepEqual(WebAssembly.Module.imports(module).map(({ module, name, kind }) => [module, name, kind]), [
  ['wasi_snapshot_preview1', 'fd_close', 'function'],
  ['wasi_snapshot_preview1', 'fd_write', 'function'],
  ['wasi_snapshot_preview1', 'fd_seek', 'function'],
]);
const wasiCalls = { fd_close: 0, fd_write: 0, fd_seek: 0 };
const { instance } = await WebAssembly.instantiate(moduleBytes, { wasi_snapshot_preview1: {
  fd_close() { wasiCalls.fd_close += 1; return 8; },
  fd_write() { wasiCalls.fd_write += 1; return 8; },
  fd_seek() { wasiCalls.fd_seek += 1; return 8; },
} });
const wasm = instance.exports;
wasm._initialize();
const memory = wasm.memory;
const initialMemoryBytes = memory.buffer.byteLength;
assert.equal(initialMemoryBytes, 64 * 1024 * 1024);
assert.equal(wasm.webrc_dsp_abi_version(), 2);
assert.equal(wasm.webrc_dsp_extended_api_version(), 1);
assert.equal(wasm.webrc_dsp_fx_api_version(), 1);
assert.equal(wasm.webrc_dsp_fx_create_v2_api_version(), 2);
assert.equal(wasm.webrc_dsp_fx_profile_setup_api_version(), 1);
assert.equal(wasm.webrc_dsp_capabilities(), 7);
assert.equal(wasm.webrc_dsp_fx_catalog_size(), 53);
assert.equal(wasm.webrc_dsp_managed_memory_capacity_bytes(), 48 * 1024 * 1024);

const expectedAvailable = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
  23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45,
  46, 47, 48, 49, 50, 51, 52, 53,
]);
const expectedHistoryWarmup = new Set([5, 7, 33, 36, 37, 38, 39, 50, 51]);
const decoder = new TextDecoder();
function readCString(pointer) {
  assert.ok(pointer > 0 && pointer < memory.buffer.byteLength, `invalid metadata pointer ${pointer}`);
  const bytes = new Uint8Array(memory.buffer, pointer);
  const end = bytes.indexOf(0);
  assert.notEqual(end, -1, 'FX metadata string is not NUL terminated');
  return decoder.decode(bytes.subarray(0, end));
}

const baselineBytes = wasm.webrc_dsp_managed_memory_bytes();
const catalog = [];
for (let ordinal = 1; ordinal <= 53; ordinal += 1) {
  const id = readCString(wasm.webrc_dsp_fx_id_pointer(ordinal));
  const name = readCString(wasm.webrc_dsp_fx_name_pointer(ordinal));
  const family = readCString(wasm.webrc_dsp_fx_family_pointer(ordinal));
  assert.ok(id.startsWith('rc505mkii.fx.'));
  assert.ok(name.length > 0 && family.length > 0);
  const available = wasm.webrc_dsp_fx_is_processor_available(ordinal) === 1;
  assert.equal(available, expectedAvailable.has(ordinal), `unexpected readiness for ordinal ${ordinal}`);
  assert.equal(wasm.webrc_dsp_fx_official_parameters_validated(ordinal), 0,
    'reconstruction-safe metadata must not claim validated official parameters');
  catalog.push({ ordinal, id, name, family, available });
}
assert.equal(new Set(catalog.map(item => item.id)).size, 53);

function allocate(frames) {
  const token = wasm.webrc_dsp_alloc_f32_token(frames);
  assert.notEqual(token, 0, `unable to allocate ${frames} setup transfer frames`);
  const address = wasm.webrc_dsp_transfer_address(token);
  assert.ok(address > 0 && address % 4 === 0 && address + frames * 4 <= memory.buffer.byteLength);
  return { token, address, samples: new Float32Array(memory.buffer, address, frames) };
}
function release(buffer) {
  assert.equal(wasm.webrc_dsp_free_transfer_token(buffer.token), 0);
}
function createFxV2(ordinal, parameters) {
  if (parameters.length === 0) {
    return wasm.webrc_dsp_fx_create_v2(ordinal, 48000, frames, 2, 0, 0, 0);
  }
  const ids = allocate(parameters.length);
  const values = allocate(parameters.length);
  const idsU32 = new Uint32Array(memory.buffer, ids.address, parameters.length);
  for (let index = 0; index < parameters.length; index += 1) {
    idsU32[index] = parameters[index][0];
    values.samples[index] = parameters[index][1];
  }
  const handle = wasm.webrc_dsp_fx_create_v2(ordinal, 48000, frames, 2,
    ids.address, values.address, parameters.length);
  release(values);
  release(ids);
  return handle;
}
function createFxV2Raw(ordinal, sampleRate, maxBlockFrames, channels, idsAddress, valuesAddress, count) {
  return wasm.webrc_dsp_fx_create_v2(ordinal, sampleRate, maxBlockFrames, channels,
    idsAddress, valuesAddress, count);
}
function withRawParameterSpans(parameters, callback) {
  const ids = allocate(parameters.length);
  const values = allocate(parameters.length);
  const idsU32 = new Uint32Array(memory.buffer, ids.address, parameters.length);
  for (let index = 0; index < parameters.length; index += 1) {
    idsU32[index] = parameters[index][0];
    values.samples[index] = parameters[index][1];
  }
  try { return callback(ids, values); }
  finally { release(values); release(ids); }
}
function withProfileParameterSpans(parameters, callback) {
  if (parameters.length === 0) return callback(0, 0, 0);
  return withRawParameterSpans(parameters,
    (ids, values) => callback(ids.address, values.address, parameters.length));
}
function profileMemoryInfo(ordinal, parameters) {
  const output = allocate(10);
  try {
    const status = withProfileParameterSpans(parameters, (idsAddress, valuesAddress, count) =>
      wasm.webrc_dsp_fx_memory_info_for_parameters(ordinal, 48000, frames, 2,
        idsAddress, valuesAddress, count, output.address));
    const view = new DataView(memory.buffer, output.address, 40);
    return {
      status,
      objectBytes: Number(view.getBigUint64(0, true)),
      persistentBytes: Number(view.getBigUint64(8, true)),
      scratchBytes: Number(view.getBigUint64(16, true)),
      peakBytes: Number(view.getBigUint64(24, true)),
      supported: view.getUint32(32, true),
    };
  } finally { release(output); }
}
function profileWarmupFrames(ordinal, parameters) {
  const output = allocate(1);
  try {
    const status = withProfileParameterSpans(parameters, (idsAddress, valuesAddress, count) =>
      wasm.webrc_dsp_fx_startup_warmup_upper_bound_samples_for_parameters(ordinal, 48000, frames, 2,
        idsAddress, valuesAddress, count, output.address));
    return { status, frames: new Uint32Array(memory.buffer, output.address, 1)[0] };
  } finally { release(output); }
}
function runProcess(handle, inLeft, inRight, outLeft, outRight, frames, events = null, ordinal = 0) {
  if (ordinal === 20) {
    let offsets = null;
    let parameterIds = null;
    let values = null;
    if (events) {
      offsets = allocate(events.length);
      parameterIds = allocate(events.length);
      values = allocate(events.length);
      const offsetsU32 = new Uint32Array(memory.buffer, offsets.address, events.length);
      const parameterIdsU32 = new Uint32Array(memory.buffer, parameterIds.address, events.length);
      for (let index = 0; index < events.length; index += 1) {
        offsetsU32[index] = events[index].frameOffset;
        parameterIdsU32[index] = events[index].parameterId;
        values.samples[index] = events[index].value;
      }
    }
    const status = wasm.webrc_dsp_fx_process_stereo_context_v1(
      handle, inLeft, inRight, outLeft, outRight, frames,
      offsets?.address ?? 0, parameterIds?.address ?? 0, values?.address ?? 0, events?.length ?? 0,
      inLeft, inRight, frames, 2, 0, 0,
    );
    if (values) release(values);
    if (parameterIds) release(parameterIds);
    if (offsets) release(offsets);
    return status;
  }
  if (!events) {
    return wasm.webrc_dsp_fx_process_stereo(handle, inLeft, inRight, outLeft, outRight, frames);
  }
  const offsets = allocate(events.length);
  const parameterIds = allocate(events.length);
  const values = allocate(events.length);
  const offsetsU32 = new Uint32Array(memory.buffer, offsets.address, events.length);
  const parameterIdsU32 = new Uint32Array(memory.buffer, parameterIds.address, events.length);
  for (let index = 0; index < events.length; index += 1) {
    offsetsU32[index] = events[index].frameOffset;
    parameterIdsU32[index] = events[index].parameterId;
    values.samples[index] = events[index].value;
  }
  const status = wasm.webrc_dsp_fx_process_stereo_events(
    handle, inLeft, inRight, outLeft, outRight, frames,
    offsets.address, parameterIds.address, values.address, events.length,
  );
  release(values);
  release(parameterIds);
  release(offsets);
  return status;
}

const frames = 512;
const buffers = Array.from({ length: 4 }, () => allocate(frames));
const [inLeft, inRight, outLeft, outRight] = buffers;
for (let frame = 0; frame < frames; frame += 1) {
  inLeft.samples[frame] = 0.2 * Math.sin(2 * Math.PI * 440 * frame / 48000);
  inRight.samples[frame] = 0.17 * Math.sin(2 * Math.PI * 997 * frame / 48000 + 0.31);
}

const defaultPreampSelectors = [[82, 3], [83, 1], [84, 0], [85, 0], [86, 0]];
for (const ordinal of expectedAvailable) {
  const infoAddress = allocate(10);
  const infoView = new DataView(memory.buffer, infoAddress.address, 36);
  assert.equal(wasm.webrc_dsp_fx_memory_info(ordinal, 48000, frames, 2, infoAddress.address), 0);
  const memoryInfo = {
    objectBytes: Number(infoView.getBigUint64(0, true)),
    persistentBytes: Number(infoView.getBigUint64(8, true)),
    scratchBytes: Number(infoView.getBigUint64(16, true)),
    peakBytes: Number(infoView.getBigUint64(24, true)),
    supported: infoView.getUint32(32, true),
  };
  assert.equal(memoryInfo.supported, 1);
  assert.ok(memoryInfo.peakBytes >= memoryInfo.objectBytes + memoryInfo.persistentBytes + memoryInfo.scratchBytes);
  assert.ok(memoryInfo.peakBytes > 0);
  release(infoAddress);

  const handle = ordinal === 23
    ? createFxV2(ordinal, defaultPreampSelectors)
    : wasm.webrc_dsp_fx_create(ordinal, 48000, frames, 2);
  assert.notEqual(handle, 0, `FX ordinal ${ordinal} create failed (${wasm.webrc_dsp_fx_last_create_status()})`);
  assert.equal(wasm.webrc_dsp_fx_last_create_status(), 0);
  assert.ok(wasm.webrc_dsp_fx_fixed_latency_samples(handle) >= -1);
  assert.ok(wasm.webrc_dsp_fx_latency_model(handle) <= 2);
  const warmupAddress = allocate(1);
  assert.equal(wasm.webrc_dsp_fx_startup_warmup_upper_bound_samples(
    ordinal, 48000, frames, 2, warmupAddress.address), 0,
  `FX ordinal ${ordinal} needs an explicit supported startup warmup bound`);
  const warmupOut = new Uint32Array(memory.buffer, warmupAddress.address, 1);
  const actualWarmup = wasm.webrc_dsp_fx_startup_warmup_frames(handle);
  assert.ok(Number.isInteger(actualWarmup) && actualWarmup >= 0 && actualWarmup <= warmupOut[0],
    `FX ordinal ${ordinal} prepared warmup must fit the static bound`);
  if (expectedHistoryWarmup.has(ordinal)) assert.ok(warmupOut[0] > 0,
    `FX ordinal ${ordinal} has finite startup history and must not report a zero bound`);
  release(warmupAddress);

  const parameterCount = wasm.webrc_dsp_fx_parameter_count(ordinal);
  assert.ok(parameterCount > 0, `processor ${ordinal} must expose its bounded controls`);
  const parameterInfo = allocate(8);
  const parameterView = new DataView(memory.buffer, parameterInfo.address, 32);
  const firstParameterAddress = parameterInfo.address;
  assert.equal(wasm.webrc_dsp_fx_parameter_info(ordinal, 0, firstParameterAddress), 0);
  const parameter = {
    id: parameterView.getUint32(0, true),
    minimum: parameterView.getFloat32(4, true),
    maximum: parameterView.getFloat32(8, true),
    defaultValue: parameterView.getFloat32(12, true),
    namePointer: parameterView.getUint32(16, true),
    unitPointer: parameterView.getUint32(20, true),
    origin: parameterView.getUint32(24, true),
  };
  assert.ok(parameter.id > 0 && parameter.minimum <= parameter.defaultValue && parameter.defaultValue <= parameter.maximum);
  assert.ok(readCString(parameter.namePointer).length > 0 && readCString(parameter.unitPointer).length > 0);
  assert.equal(parameter.origin, 0, 'parameter origin must identify reconstruction-safe bounds');
  release(parameterInfo);

  assert.equal(wasm.webrc_dsp_fx_set_parameter(handle, parameter.id, Number.NaN), -2);
  assert.equal(wasm.webrc_dsp_fx_set_parameter(handle, parameter.id, parameter.maximum + 1), -2);
  assert.equal(runProcess(handle, inLeft.address, inRight.address, outLeft.address, outRight.address, frames, null, ordinal), 0);
  assert.equal(runProcess(handle, inLeft.address, inRight.address, outLeft.address, outRight.address, frames, [
    { frameOffset: 128, parameterId: parameter.id, value: parameter.defaultValue },
  ], ordinal), 0);
  assert.ok(outLeft.samples.every(Number.isFinite) && outRight.samples.every(Number.isFinite));
  assert.equal(wasm.webrc_dsp_fx_reset(handle), 0);
  let outputEnergy = 0;
  let channelDifference = 0;
  let totalSamples = 0;
  // Give delay/reverse/reverb implementations time to produce their first wet
  // output while respecting the exact prepared maximum (512 frames).
  for (let blockStart = 0; blockStart < 8192; blockStart += frames) {
    for (let frame = 0; frame < frames; frame += 1) {
      const absoluteFrame = blockStart + frame;
      inLeft.samples[frame] = 0.2 * Math.sin(2 * Math.PI * 440 * absoluteFrame / 48000);
      inRight.samples[frame] = 0.17 * Math.sin(2 * Math.PI * 997 * absoluteFrame / 48000 + 0.31);
    }
    assert.equal(runProcess(handle, inLeft.address, inRight.address, outLeft.address, outRight.address, frames, null, ordinal), 0);
    for (let frame = 0; frame < frames; frame += 1) {
      outputEnergy += outLeft.samples[frame] ** 2 + outRight.samples[frame] ** 2;
      channelDifference += Math.abs(outLeft.samples[frame] - outRight.samples[frame]);
      totalSamples += 2;
    }
  }
  if (ordinal !== 53) {
    assert.ok(Number.isFinite(outputEnergy) && outputEnergy / totalSamples > 1e-14,
      `FX ordinal ${ordinal} produced no finite stereo output after 8192 frames`);
    assert.ok(channelDifference / (totalSamples / 2) > 1e-8,
      `FX ordinal ${ordinal} collapsed independent input channels`);
  }
  assert.equal(wasm.webrc_dsp_fx_process_stereo_events(handle,
    inLeft.address, inRight.address, outLeft.address, outRight.address, frames,
    0, 0, 0, 1), -2, 'event call must reject missing spans');
  assert.equal(wasm.webrc_dsp_fx_process_stereo(handle,
    memory.buffer.byteLength, inRight.address, outLeft.address, outRight.address, frames), -2,
  'process must reject an aligned pointer that starts at the end of linear memory');
  assert.equal(wasm.webrc_dsp_fx_process_stereo(handle,
    inLeft.address + 1, inRight.address, outLeft.address, outRight.address, frames), -2,
  'process must reject a misaligned input span');
  assert.equal(wasm.webrc_dsp_fx_process_stereo_events(handle,
    inLeft.address, inRight.address, outLeft.address, outRight.address, frames,
    memory.buffer.byteLength, 0, 0, 1), -2,
  'event processing must reject out-of-bounds event spans');
  assert.equal(wasm.webrc_dsp_fx_destroy(handle), 0);
}

const preampLedgerBaseline = wasm.webrc_dsp_managed_memory_bytes();
assert.equal(wasm.webrc_dsp_fx_create(23, 48000, frames, 2), 0,
  'legacy create must refuse PREAMP because it cannot specify prepare-time models');
assert.equal(wasm.webrc_dsp_fx_last_create_status(), -2);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), preampLedgerBaseline);
assert.equal(createFxV2(23, [[82, 3], [83, 1], [84, 0], [85, 0], [86, Number.NaN]]), 0,
  'non-finite PREAMP selectors must be rejected');
assert.equal(wasm.webrc_dsp_fx_last_create_status(), -2);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), preampLedgerBaseline);
assert.equal(createFxV2(23, [[82, 3], [83, 1], [84, 0], [85, 0], [86, 0], [82, 4]]), 0,
  'duplicate PREAMP selectors must be rejected');
assert.equal(wasm.webrc_dsp_fx_last_create_status(), -2);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), preampLedgerBaseline);
assert.equal(createFxV2(23, [[82, 9], [83, 1], [84, 0], [85, 0], [86, 0]]), 0,
  'out-of-range PREAMP selectors must be rejected');
assert.equal(wasm.webrc_dsp_fx_last_create_status(), -2);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), preampLedgerBaseline);

withRawParameterSpans(defaultPreampSelectors, (ids, values) => {
  assert.equal(createFxV2Raw(23, 48000, frames, 2, ids.address + 1, values.address, 5), 0,
    'misaligned parameter spans must be rejected before reading');
  assert.equal(wasm.webrc_dsp_fx_last_create_status(), -2);
  assert.equal(createFxV2Raw(23, 48000, frames, 2, memory.buffer.byteLength, values.address, 5), 0,
    'out-of-bounds parameter ID spans must be rejected');
  assert.equal(wasm.webrc_dsp_fx_last_create_status(), -2);
  assert.equal(createFxV2Raw(23, 48000, frames, 2, ids.address, memory.buffer.byteLength - 4, 5), 0,
    'out-of-bounds parameter value spans must be rejected');
  assert.equal(wasm.webrc_dsp_fx_last_create_status(), -2);
});
assert.equal(createFxV2Raw(23, 48000, frames, 2, 0, 0, 257), 0,
  'oversized initial parameter batches must be rejected before reading their spans');
assert.equal(wasm.webrc_dsp_fx_last_create_status(), -2);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), preampLedgerBaseline,
  'invalid pointer spans must not reserve any managed bytes');

const ordinaryFrequency = allocate(1);
const ordinaryFrequencyId = allocate(1);
new Uint32Array(memory.buffer, ordinaryFrequencyId.address, 1)[0] = 1;
ordinaryFrequency.samples[0] = 4000;
assert.equal(createFxV2Raw(1, 8000, frames, 2, ordinaryFrequencyId.address,
  ordinaryFrequency.address, 1), 0,
  'filter creation must reject an ordinary frequency above its low-rate Nyquist-safe limit');
assert.equal(wasm.webrc_dsp_fx_last_create_status(), -2,
  'an out-of-range low-rate filter parameter must fail validation before reservation');
release(ordinaryFrequencyId);
release(ordinaryFrequency);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), preampLedgerBaseline,
  'rejected low-rate frequency must not reserve managed memory');

const lowRatePreampIds = allocate(5);
const lowRatePreampValues = allocate(5);
const lowRatePreampIdView = new Uint32Array(memory.buffer, lowRatePreampIds.address, 5);
const lowRatePreampSelectors = [[82, 3], [83, 1], [84, 0], [85, 0], [86, 0]];
for (let index = 0; index < lowRatePreampSelectors.length; index += 1) {
  lowRatePreampIdView[index] = lowRatePreampSelectors[index][0];
  lowRatePreampValues.samples[index] = lowRatePreampSelectors[index][1];
}
assert.equal(createFxV2Raw(23, 4000, frames, 2, lowRatePreampIds.address,
  lowRatePreampValues.address, lowRatePreampSelectors.length), 0,
  'unsupported sample-rate preflight must reject a valid selector batch before prepare');
assert.equal(wasm.webrc_dsp_fx_last_create_status(), -3);
release(lowRatePreampValues);
release(lowRatePreampIds);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), preampLedgerBaseline);
assert.equal(createFxV2(23, [[82, 3], [83, 1], [84, 0], [85, 0]]), 0,
  'PREAMP v2 create must require all five selectors');
assert.equal(wasm.webrc_dsp_fx_last_create_status(), -2);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), preampLedgerBaseline,
  'rejected PREAMP selectors must not reserve or publish a handle');
assert.equal(createFxV2(23, [[82, 3.5], [83, 1], [84, 0], [85, 0], [86, 0]]), 0,
  'fractional prepare-time selectors must be rejected');
assert.equal(wasm.webrc_dsp_fx_last_create_status(), -2);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), preampLedgerBaseline);

const preampSettings = [
  [48, 1], [3, 1], [61, 7],
  [82, 3], [83, 1], [84, 0], [85, 0], [86, 0],
];
const alternatePreampSettings = [
  [48, 1], [3, 1], [61, 7],
  [82, 8], [83, 8], [84, 3], [85, 1], [86, 5],
];
const defaultPreamp = createFxV2(23, preampSettings);
const alternatePreamp = createFxV2(23, alternatePreampSettings);
assert.notEqual(defaultPreamp, 0, `default PREAMP v2 create failed (${wasm.webrc_dsp_fx_last_create_status()})`);
assert.notEqual(alternatePreamp, 0, `selected PREAMP v2 create failed (${wasm.webrc_dsp_fx_last_create_status()})`);
const preampBound = allocate(1);
assert.equal(wasm.webrc_dsp_fx_startup_warmup_upper_bound_samples(23, 48000, frames, 2, preampBound.address), 0);
const preampBoundFrames = new Uint32Array(memory.buffer, preampBound.address, 1)[0];
assert.ok(wasm.webrc_dsp_fx_startup_warmup_frames(defaultPreamp) <= preampBoundFrames);
assert.ok(wasm.webrc_dsp_fx_startup_warmup_frames(alternatePreamp) <= preampBoundFrames);
let preampDifference = 0;
for (let blockStart = 0; blockStart < 8192; blockStart += frames) {
  for (let frame = 0; frame < frames; frame += 1) {
    const absoluteFrame = blockStart + frame;
    inLeft.samples[frame] = 0.2 * Math.sin(2 * Math.PI * 110 * absoluteFrame / 48000);
    inRight.samples[frame] = 0.13 * Math.sin(2 * Math.PI * 293 * absoluteFrame / 48000 + 0.27);
  }
  assert.equal(runProcess(defaultPreamp, inLeft.address, inRight.address, outLeft.address, outRight.address, frames), 0);
  const defaultLeft = outLeft.samples.slice();
  const defaultRight = outRight.samples.slice();
  assert.equal(runProcess(alternatePreamp, inLeft.address, inRight.address, outLeft.address, outRight.address, frames), 0);
  for (let frame = 0; frame < frames; frame += 1) {
    preampDifference += Math.abs(defaultLeft[frame] - outLeft.samples[frame]) +
      Math.abs(defaultRight[frame] - outRight.samples[frame]);
  }
}
assert.ok(preampDifference > 1e-3,
  'nondefault PREAMP selectors must change rendered PCM after prepare');
assert.equal(wasm.webrc_dsp_fx_destroy(defaultPreamp), 0);
assert.equal(wasm.webrc_dsp_fx_destroy(alternatePreamp), 0);
release(preampBound);

// Exercise every performance adapter with real stereo input and enough
// contiguous frames to cross its first beat/flick boundary. The controls are
// reconstruction-safe adapter inputs, not claims about the vendor UI contract.
const performanceCases = [
  { ordinal: 50, controls: [[49, 300], [50, 0.125], [52, 0.6], [53, 1.25], [48, 1]] },
  { ordinal: 51, controls: [[49, 300], [50, 0.125], [21, 1], [7, 0.35], [48, 1]] },
  { ordinal: 52, controls: [[49, 300], [50, 0.125], [54, 0.25], [48, 1]] },
  { ordinal: 53, controls: [[21, 1], [55, 0.65], [48, 1]] },
];
const performanceFrames = 12_288;
for (const { ordinal, controls } of performanceCases) {
  const handle = wasm.webrc_dsp_fx_create(ordinal, 48000, 512, 2);
  assert.notEqual(handle, 0, `performance FX ordinal ${ordinal} create failed`);
  for (const [parameterId, value] of controls) {
    assert.equal(wasm.webrc_dsp_fx_set_parameter(handle, parameterId, value), 0,
      `performance FX ordinal ${ordinal} rejected valid setup control ${parameterId}`);
  }
  let squaredDifference = 0;
  let outputEnergy = 0;
  for (let blockStart = 0; blockStart < performanceFrames; blockStart += 128) {
    for (let frame = 0; frame < 128; frame += 1) {
      const absoluteFrame = blockStart + frame;
      inLeft.samples[frame] = 0.2 * Math.sin(2 * Math.PI * 440 * absoluteFrame / 48000);
      inRight.samples[frame] = 0.17 * Math.sin(2 * Math.PI * 997 * absoluteFrame / 48000 + 0.31);
    }
    assert.equal(runProcess(handle, inLeft.address, inRight.address,
      outLeft.address, outRight.address, 128), 0,
    `performance FX ordinal ${ordinal} rejected an actual 128-frame block`);
    for (let frame = 0; frame < 128; frame += 1) {
      const dl = outLeft.samples[frame] - inLeft.samples[frame];
      const dr = outRight.samples[frame] - inRight.samples[frame];
      squaredDifference += dl * dl + dr * dr;
      outputEnergy += outLeft.samples[frame] ** 2 + outRight.samples[frame] ** 2;
    }
  }
  assert.ok(Number.isFinite(squaredDifference) && squaredDifference > 1e-7,
    `performance FX ordinal ${ordinal} must produce a non-dry stereo transformation`);
  assert.ok(Number.isFinite(outputEnergy) && outputEnergy > 1e-5,
    `performance FX ordinal ${ordinal} must retain finite stereo program energy`);
  if (ordinal === 53) assert.equal(wasm.webrc_dsp_fx_fixed_latency_samples(handle), 960);
  else assert.equal(wasm.webrc_dsp_fx_fixed_latency_samples(handle), -1);
  assert.equal(wasm.webrc_dsp_fx_destroy(handle), 0);
}

const baseHandle = wasm.webrc_dsp_create(2, 48000, frames, 1, 0);
assert.notEqual(baseHandle, 0);
assert.equal(wasm.webrc_dsp_fx_process_stereo(baseHandle, inLeft.address, 0,
  outLeft.address, 0, frames), -3, 'FX calls must reject a handle from another domain');
assert.equal(wasm.webrc_dsp_fx_destroy(baseHandle), -3, 'FX destroy must reject a base-domain handle');
assert.equal(wasm.webrc_dsp_destroy(baseHandle), 0);

const defaultLivePolyMemory = profileMemoryInfo(18, []);
assert.equal(defaultLivePolyMemory.status, 0);
assert.equal(defaultLivePolyMemory.supported, 1);
assert.ok(defaultLivePolyMemory.peakBytes < 48 * 1024 * 1024,
  'default LivePoly selection must reserve its selected profile, not the rejected HQ maximum');
const defaultLivePolyWarmup = profileWarmupFrames(18, []);
assert.equal(defaultLivePolyWarmup.status, 0);
assert.equal(defaultLivePolyWarmup.frames, 9216,
  'default LivePoly startup bound must use its selected profile instead of the HQ maximum');
const hqMemory = profileMemoryInfo(18, [[125, 2]]);
assert.equal(hqMemory.status, 0);
assert.equal(hqMemory.supported, 1);
assert.ok(hqMemory.peakBytes > 48 * 1024 * 1024,
  'explicit two-voice HQ profile must retain its real peak estimate');
const hqWarmup = profileWarmupFrames(18, [[125, 2]]);
assert.equal(hqWarmup.status, 0);
assert.equal(hqWarmup.frames, 33792);
const profileLedgerBaseline = wasm.webrc_dsp_managed_memory_bytes();
const defaultLivePoly = wasm.webrc_dsp_fx_create(18, 48000, frames, 2);
assert.notEqual(defaultLivePoly, 0,
  `legacy default creation should resolve descriptor-default LivePoly (${wasm.webrc_dsp_fx_last_create_status()})`);
assert.equal(wasm.webrc_dsp_fx_startup_warmup_frames(defaultLivePoly), defaultLivePolyWarmup.frames);
assert.equal(wasm.webrc_dsp_fx_destroy(defaultLivePoly), 0);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), profileLedgerBaseline);
assert.equal(createFxV2(18, [[125, 2]]), 0,
  'explicit HQ profile must be rejected when the actual conservative candidate peak exceeds the ledger');
assert.equal(wasm.webrc_dsp_fx_last_create_status(), -7);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), profileLedgerBaseline,
  'rejected HQ profile must leave the shared ledger unchanged');

const invalidProfileOutput = allocate(10);
const invalidProfileBytes = new Uint8Array(memory.buffer, invalidProfileOutput.address, 40);
invalidProfileBytes.fill(0x5a);
const invalidProfileBefore = invalidProfileBytes.slice();
withRawParameterSpans([[125, 0]], (ids, values) => {
  assert.equal(wasm.webrc_dsp_fx_memory_info_for_parameters(18, 48000, frames, 2,
    ids.address, values.address, 1, invalidProfileOutput.address), -2,
  'unsupported LiveMono selection for HRM must fail closed');
  assert.equal(wasm.webrc_dsp_fx_startup_warmup_upper_bound_samples_for_parameters(18, 48000, frames, 2,
    ids.address, values.address, 1, invalidProfileOutput.address), -2);
});
assert.deepEqual(new Uint8Array(memory.buffer, invalidProfileOutput.address, 40), invalidProfileBefore,
  'invalid profile queries must not publish partial output');
release(invalidProfileOutput);

const invariantHandle = wasm.webrc_dsp_fx_create(1, 48000, frames, 2);
const controlHandle = wasm.webrc_dsp_fx_create(1, 48000, frames, 2);
assert.notEqual(invariantHandle, 0);
assert.notEqual(controlHandle, 0);
const delayHandles = [];
let exhaustionStatus = 0;
for (let index = 0; index < 64; index += 1) {
  const handle = wasm.webrc_dsp_fx_create(36, 48000, frames, 2);
  if (!handle) {
    exhaustionStatus = wasm.webrc_dsp_fx_last_create_status();
    break;
  }
  delayHandles.push(handle);
}
assert.ok(delayHandles.length > 0 && exhaustionStatus === -7,
  `candidate admission should reject at the shared memory budget, got ${exhaustionStatus}`);
const beforePreservation = wasm.webrc_dsp_managed_memory_bytes();
assert.equal(wasm.webrc_dsp_fx_reset(invariantHandle), 0);
assert.equal(wasm.webrc_dsp_fx_reset(controlHandle), 0);
assert.equal(runProcess(invariantHandle, inLeft.address, inRight.address, outLeft.address, outRight.address, frames), 0);
const afterCandidatePcm = outLeft.samples.slice();
assert.equal(runProcess(controlHandle, inLeft.address, inRight.address, outLeft.address, outRight.address, frames), 0);
assert.deepEqual(afterCandidatePcm, outLeft.samples,
  'failed candidate preparation must leave an existing processor equivalent to its control instance');
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), beforePreservation);
assert.equal(wasm.memory.buffer.byteLength, initialMemoryBytes);
assert.ok(afterCandidatePcm.every(Number.isFinite));
for (const handle of delayHandles) assert.equal(wasm.webrc_dsp_fx_destroy(handle), 0);

const beforeSlotExhaustion = wasm.webrc_dsp_managed_memory_bytes();
// Keep selector spans allocated before consuming the handle table. Transfer
// allocations use the same generation-checked handle slots as FX states, so
// allocating these only after exhaustion would test the helper's allocation
// failure instead of the FX candidate's publish rollback.
const noSlotSelectorIds = allocate(defaultPreampSelectors.length);
const noSlotSelectorValues = allocate(defaultPreampSelectors.length);
const noSlotSelectorIdView = new Uint32Array(memory.buffer, noSlotSelectorIds.address,
  defaultPreampSelectors.length);
for (let index = 0; index < defaultPreampSelectors.length; index += 1) {
  noSlotSelectorIdView[index] = defaultPreampSelectors[index][0];
  noSlotSelectorValues.samples[index] = defaultPreampSelectors[index][1];
}
const slotHandles = [];
let slotFailureStatus = 0;
for (let index = 0; index < 1024; index += 1) {
  const handle = wasm.webrc_dsp_fx_create(1, 48000, frames, 2);
  if (!handle) {
    slotFailureStatus = wasm.webrc_dsp_fx_last_create_status();
    break;
  }
  slotHandles.push(handle);
}
assert.ok(slotHandles.length > 0 && slotFailureStatus === -5,
  `handle-table exhaustion should return NO_SLOTS (-5), got ${slotFailureStatus}`);
const beforeNoSlotCandidate = wasm.webrc_dsp_managed_memory_bytes();
assert.equal(createFxV2Raw(23, 48000, frames, 2,
  noSlotSelectorIds.address, noSlotSelectorValues.address, defaultPreampSelectors.length), 0,
  'PREAMP candidate must fail when the shared handle table has no free slot');
assert.equal(wasm.webrc_dsp_fx_last_create_status(), -5);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), beforeNoSlotCandidate,
  'no-slot candidate rejection must release its ledger reservation');
assert.equal(wasm.webrc_dsp_fx_reset(invariantHandle), 0);
assert.equal(wasm.webrc_dsp_fx_reset(controlHandle), 0);
assert.equal(runProcess(invariantHandle, inLeft.address, inRight.address, outLeft.address, outRight.address, frames), 0);
const afterNoSlotPcm = outLeft.samples.slice();
assert.equal(runProcess(controlHandle, inLeft.address, inRight.address, outLeft.address, outRight.address, frames), 0);
assert.deepEqual(afterNoSlotPcm, outLeft.samples,
  'no-slot failure must leave existing handles usable and deterministic');
for (const handle of slotHandles) assert.equal(wasm.webrc_dsp_fx_destroy(handle), 0);
release(noSlotSelectorValues);
release(noSlotSelectorIds);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), beforeSlotExhaustion);

assert.equal(wasm.webrc_dsp_fx_destroy(invariantHandle), 0);
assert.equal(wasm.webrc_dsp_fx_destroy(controlHandle), 0);
for (const buffer of buffers) release(buffer);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), baselineBytes);
assert.equal(wasm.memory.buffer.byteLength, initialMemoryBytes);
assert.deepEqual(wasiCalls, { fd_close: 0, fd_write: 0, fd_seek: 0 });

console.log(JSON.stringify({
  result: 'PASS',
  assertions: 'catalog/ABI, 53 available processors, prepare-before-publish PREAMP selector API, finite startup warmup bounds, stereo output, sample-accurate events, typed VOCODER carrier routing, ledger rejection, handle-domain and no-I/O checks',
  availableOrdinals: [...expectedAvailable],
  unsupportedOrdinalsRemainMetadataOnly: 53 - expectedAvailable.size,
  createdAndProcessed: expectedAvailable.size,
  performanceAdapters: performanceCases.map(({ ordinal }) => ordinal),
  delayCandidatesBeforeBudgetRejection: delayHandles.length,
  exhaustionStatus,
  memoryGrowthBytes: memory.buffer.byteLength - initialMemoryBytes,
  wasiCalls,
  moduleSha256: sha256(moduleBytes),
  sourceSetSha256: manifest.sourceSetSha256,
}, null, 2));
