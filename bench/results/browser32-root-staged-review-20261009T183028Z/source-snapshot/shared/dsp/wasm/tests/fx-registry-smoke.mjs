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
assert.equal(wasm.webrc_dsp_capabilities(), 7);
assert.equal(wasm.webrc_dsp_fx_catalog_size(), 53);
assert.equal(wasm.webrc_dsp_managed_memory_capacity_bytes(), 48 * 1024 * 1024);

const expectedAvailable = new Set([
  1, 2, 3, 4, 5, 7, 8, 9, 11, 13, 25, 26, 27,
  29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39,
  46, 47, 48, 49, 50, 51, 52, 53,
]);
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
function runProcess(handle, inLeft, inRight, outLeft, outRight, frames, events = null) {
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

const handles = [];
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

  const handle = wasm.webrc_dsp_fx_create(ordinal, 48000, frames, 2);
  assert.notEqual(handle, 0, `FX ordinal ${ordinal} create failed (${wasm.webrc_dsp_fx_last_create_status()})`);
  assert.equal(wasm.webrc_dsp_fx_last_create_status(), 0);
  handles.push({ ordinal, handle });
  assert.ok(wasm.webrc_dsp_fx_fixed_latency_samples(handle) >= -1);
  assert.ok(wasm.webrc_dsp_fx_latency_model(handle) <= 2);

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
  assert.equal(runProcess(handle, inLeft.address, inRight.address, outLeft.address, outRight.address, frames), 0);
  assert.equal(runProcess(handle, inLeft.address, inRight.address, outLeft.address, outRight.address, frames, [
    { frameOffset: 128, parameterId: parameter.id, value: parameter.defaultValue },
  ]), 0);
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
    assert.equal(runProcess(handle, inLeft.address, inRight.address, outLeft.address, outRight.address, frames), 0);
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
}

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

const beforeUnsupported = wasm.webrc_dsp_managed_memory_bytes();
assert.equal(wasm.webrc_dsp_fx_create(6, 48000, frames, 2), 0);
assert.equal(wasm.webrc_dsp_fx_last_create_status(), -3);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), beforeUnsupported,
  'unavailable processor creation must not consume ledger bytes');

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
assert.equal(wasm.webrc_dsp_fx_destroy(invariantHandle), 0);
assert.equal(wasm.webrc_dsp_fx_destroy(controlHandle), 0);
for (const { handle } of handles) assert.equal(wasm.webrc_dsp_fx_destroy(handle), 0);
for (const buffer of buffers) release(buffer);
assert.equal(wasm.webrc_dsp_managed_memory_bytes(), baselineBytes);
assert.equal(wasm.memory.buffer.byteLength, initialMemoryBytes);
assert.deepEqual(wasiCalls, { fd_close: 0, fd_write: 0, fd_seek: 0 });

console.log(JSON.stringify({
  result: 'PASS',
  assertions: 'catalog/ABI, 32 available processors including composite, modulated-delay, rhythmic and spatial families, stereo output, sample-accurate events, ledger rejection, handle-domain and no-I/O checks',
  availableOrdinals: [...expectedAvailable],
  unsupportedOrdinalsRemainMetadataOnly: 53 - expectedAvailable.size,
  createdAndProcessed: handles.length,
  performanceAdapters: performanceCases.map(({ ordinal }) => ordinal),
  delayCandidatesBeforeBudgetRejection: delayHandles.length,
  exhaustionStatus,
  memoryGrowthBytes: memory.buffer.byteLength - initialMemoryBytes,
  wasiCalls,
  moduleSha256: sha256(moduleBytes),
  sourceSetSha256: manifest.sourceSetSha256,
}, null, 2));
