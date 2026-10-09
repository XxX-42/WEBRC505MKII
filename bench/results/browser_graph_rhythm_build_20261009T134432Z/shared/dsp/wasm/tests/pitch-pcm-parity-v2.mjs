import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const manifestPath = path.resolve(process.argv[2] ?? 'bench/results/dsp_pcm_parity_v2/manifest.json');
const wasmPath = path.resolve(process.argv[3] ?? 'test-results/dsp-wasm/webrc-dsp.wasm');
const wasmBuildPath = path.resolve(process.argv[4] ?? 'test-results/dsp-wasm/webrc-dsp.build.json');
const outputPath = path.resolve(process.argv[5] ?? 'test-results/dsp-wasm/pitch-pcm-parity-v2.compare.json');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const wasmBuild = JSON.parse(await fs.readFile(wasmBuildPath, 'utf8'));
const wasmBytes = await fs.readFile(wasmPath);
const wasmSha = sha256(wasmBytes);
assert.equal(manifest.schemaVersion, 2, 'Native parity producer must use schema v2');
assert.equal(wasmBuild.schemaVersion, 1);
assert.equal(wasmBuild.artifact.sha256, wasmSha, 'WASM artifact does not match its build manifest');
assert.equal(wasmBuild.artifact.byteLength, wasmBytes.byteLength);
assert.equal(wasmBuild.build.emsdkCommit, '35ff8a6d150541276abbc6bae512ca90bcfbe220');
assert.match(wasmBuild.build.compilerIdentity,
  /6\.0\.10 \(d6c521a7f05449857c76bd99e396895583cf2083\)$/);

const currentSourceSet = Object.keys(wasmBuild.sourceFiles).sort()
  .map(relative => `${relative}=${wasmBuild.sourceFiles[relative]}`).join('\n');
assert.equal(wasmBuild.sourceSetSha256, sha256(Buffer.from(currentSourceSet, 'utf8')),
  'WASM build manifest source-set digest is malformed');
for (const [relative, expectedHash] of Object.entries(wasmBuild.sourceFiles)) {
  const actual = await fs.readFile(path.resolve(repoRoot, relative));
  assert.equal(sha256(actual), expectedHash, `stale WASM source: ${relative}`);
}
assert.ok(Array.isArray(manifest.fixtures) && manifest.fixtures.length > 0,
  'parity manifest has no fixtures');
assert.ok(manifest.source && manifest.nativeToolchain && Array.isArray(manifest.vendorPins),
  'Native provenance must include source, toolchain, and vendor pins');
assert.equal(manifest.source.sourceWasStableAcrossRun, true, 'Native sources changed during fixture generation');
assert.ok(manifest.vendorPins.some(pin => pin.name === 'signalsmith-stretch' &&
  pin.commit === 'a670068d9aeb64913331d5cc29337b19a457a7df' && pin.license === 'MIT'),
  'Native fixtures must use the shared Signalsmith Stretch commit');
assert.ok(manifest.vendorPins.some(pin => pin.name === 'signalsmith-linear' &&
  pin.commit === 'de55e6a50ffcf6f8f43f649692d94691c7025151' && pin.license === 'MIT'),
  'Native fixtures must use the shared Signalsmith Linear commit');
const nativeFileManifestPath = path.resolve(path.dirname(manifestPath), manifest.source.fileManifest);
const nativeFileManifestBytes = await fs.readFile(nativeFileManifestPath);
assert.equal(sha256(nativeFileManifestBytes), manifest.source.sourceFileManifestSha256,
  'Native source-file manifest fingerprint');
const nativeFileManifest = JSON.parse(nativeFileManifestBytes.toString('utf8'));
assert.equal(nativeFileManifest.sourceTreeSha256, manifest.source.sourceTreeSha256);
assert.equal(nativeFileManifest.fileCount, manifest.source.sourceFileCount);
for (const nativeFile of nativeFileManifest.files) {
  const normalized = nativeFile.path.replaceAll('\\', '/');
  if (wasmBuild.sourceFiles[normalized]) {
    assert.equal(nativeFile.sha256, wasmBuild.sourceFiles[normalized],
      `Native/WASM source mismatch: ${normalized}`);
  }
}

const wasmModule = await WebAssembly.compile(wasmBytes);
const imports = WebAssembly.Module.imports(wasmModule);
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
const instance = await WebAssembly.instantiate(wasmModule, { wasi_snapshot_preview1: wasi });
const wasm = instance.exports;
wasm._initialize();
const memory = wasm.memory;
assert.equal(memory.buffer.byteLength, 64 * 1024 * 1024);
assert.equal(wasm.webrc_dsp_abi_version(), 2);
assert.equal(wasm.webrc_dsp_extended_api_version(), 1);
assert.equal(wasm.webrc_dsp_capabilities(), 3);

const Status = { ok: 0 };
const KindSignalsmithStretch = 113;
const ControlStretchTranspose = 12;
const modeIds = { LIVE_MONO: 0, LIVE_POLY: 1, HQ_RENDER: 2 };
const allocationTokens = new Set();
const sidecarCache = new Map();

function checkedSpan(address, byteLength, alignment, label) {
  assert.ok(Number.isInteger(address) && address > 0, `${label}: nonzero linear-memory address`);
  assert.ok(Number.isInteger(byteLength) && byteLength >= 0, `${label}: valid byte length`);
  assert.equal(address % alignment, 0, `${label}: alignment`);
  assert.ok(address + byteLength <= memory.buffer.byteLength, `${label}: in-bounds span`);
}

function allocF32(frames, label) {
  const token = wasm.webrc_dsp_alloc_f32_token(frames);
  assert.notEqual(token, 0, `${label}: transfer-buffer allocation`);
  const address = wasm.webrc_dsp_transfer_address(token);
  checkedSpan(address, frames * 4, 4, label);
  allocationTokens.add(token);
  return { token, address, frames, view: new Float32Array(memory.buffer, address, frames) };
}

function freeF32(buffer) {
  if (!buffer) return;
  assert.ok(allocationTokens.delete(buffer.token), 'transfer token was released once');
  assert.equal(wasm.webrc_dsp_free_transfer_token(buffer.token), Status.ok);
}

function seedValue(seed) {
  if (typeof seed === 'number') {
    assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff, '32-bit adapter seed');
    return BigInt(seed);
  }
  const value = BigInt(seed);
  assert.ok(value >= 0n && value <= 0xffffffffn, '32-bit adapter seed');
  return value;
}

async function resolveRef(ref, label) {
  assert.ok(ref && typeof ref.path === 'string', `${label}: sidecar path is required`);
  const candidates = [path.resolve(path.dirname(manifestPath), ref.path), path.resolve(repoRoot, ref.path)];
  let bytes;
  let resolved;
  for (const candidate of candidates) {
    try {
      bytes = await fs.readFile(candidate);
      resolved = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  assert.ok(bytes, `${label}: sidecar missing (${ref.path})`);
  assert.equal(bytes.byteLength, ref.bytes, `${label}: byte length`);
  assert.equal(sha256(bytes), ref.sha256, `${label}: SHA256`);
  assert.equal(ref.encoding, 'float32-le-interleaved', `${label}: encoding`);
  assert.ok(Number.isInteger(ref.frames) && ref.frames >= 0, `${label}: frames`);
  assert.ok(Number.isInteger(ref.channels) && ref.channels > 0, `${label}: channels`);
  assert.equal(bytes.byteLength, ref.frames * ref.channels * 4, `${label}: PCM shape`);
  return { bytes, path: resolved, sha256: ref.sha256, frames: ref.frames, channels: ref.channels };
}

async function loadRef(ref, label) {
  const cacheKey = `${ref.sha256}:${ref.path}`;
  if (!sidecarCache.has(cacheKey)) sidecarCache.set(cacheKey, await resolveRef(ref, label));
  return sidecarCache.get(cacheKey);
}

function decodeF32LE(bytes) {
  const values = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < values.length; ++i) values[i] = bytes.readFloatLE(i * 4);
  return values;
}

function encodeF32LE(values) {
  const bytes = Buffer.allocUnsafe(values.length * 4);
  for (let i = 0; i < values.length; ++i) bytes.writeFloatLE(values[i], i * 4);
  return bytes;
}

function partitionFrames(fixture) {
  const parts = fixture.partitions?.callbackFrames;
  assert.ok(Array.isArray(parts) && parts.length > 0, `${fixture.fixtureId}: exact callback frame list required`);
  assert.ok(parts.every(frames => Number.isInteger(frames) && frames > 0 && frames <= fixture.maxBlockFrames),
    `${fixture.fixtureId}: invalid callback frame partition`);
  assert.equal(parts.reduce((sum, frames) => sum + frames, 0), fixture.frames,
    `${fixture.fixtureId}: partition total differs from frame count`);
  return parts;
}

function validateFixtureShape(fixture) {
  assert.equal(typeof fixture.fixtureId, 'string');
  const id = fixture.fixtureId;
  assert.equal(fixture.module, 'F10-F13', `${id}: unsupported fixture module`);
  assert.equal(fixture.primitive, 'SignalsmithStretchAdapter', `${id}: primitive`);
  assert.equal(fixture.wasmKindId, KindSignalsmithStretch, `${id}: kind ID`);
  assert.ok(fixture.mode === 'LIVE_MONO' || fixture.mode === 'LIVE_POLY' || fixture.mode === 'HQ_RENDER',
    `${id}: unsupported mode`);
  assert.ok(Number.isFinite(fixture.sampleRateHz) && fixture.sampleRateHz >= 8000 && fixture.sampleRateHz <= 384000);
  assert.ok(Number.isInteger(fixture.channels) && (fixture.channels === 1 || fixture.channels === 2));
  assert.ok(Number.isInteger(fixture.maxBlockFrames) && fixture.maxBlockFrames > 0);
  assert.ok(Number.isInteger(fixture.frames) && fixture.frames > 0);
  const settings = fixture.settings;
  assert.ok(settings && typeof settings === 'object', `${id}: settings required`);
  assert.equal(settings.mode, fixture.mode, `${id}: route mode must be explicit in settings`);
  assert.equal(settings.channels, fixture.channels, `${id}: setting/layout channel mismatch`);
  assert.ok(Number.isInteger(settings.blockSamples) && settings.blockSamples > 0);
  assert.ok(Number.isInteger(settings.intervalSamples) && settings.intervalSamples > 0);
  assert.equal(typeof settings.splitComputation, 'boolean');
  assert.ok(Number.isFinite(settings.transposeRatio) && settings.transposeRatio > 0);
  assert.ok(Number.isFinite(settings.tonalityLimit));
  assert.ok(Number.isFinite(settings.formantFactor) && settings.formantFactor > 0);
  assert.equal(typeof settings.compensatePitch, 'boolean');
  assert.equal(fixture.inputPcm.channels, fixture.channels, `${id}: input channels`);
  assert.equal(fixture.inputPcm.frames, fixture.frames, `${id}: input frames`);
  assert.equal(fixture.nativeOutputPcm.channels, fixture.channels, `${id}: native output channels`);
  assert.equal(fixture.nativeOutputPcm.frames, fixture.frames, `${id}: native output frames`);
  assert.ok(Number.isFinite(fixture.tolerance?.maxAbsError) && fixture.tolerance.maxAbsError >= 0);
  assert.ok(Number.isFinite(fixture.tolerance?.rmsError) && fixture.tolerance.rmsError >= 0);
  partitionFrames(fixture);
}

const optionsBuffer = allocF32(5, 'Signalsmith prepare settings');
const inputLeft = allocF32(Math.max(...manifest.fixtures.map(f => f.maxBlockFrames)), 'input left');
const inputRight = allocF32(inputLeft.frames, 'input right');
const outputLeft = allocF32(inputLeft.frames, 'output left');
const outputRight = allocF32(inputLeft.frames, 'output right');
const results = [];
let allPass = true;
const actualOutputDirectory = `${outputPath}.wasm-pcm`;
await fs.mkdir(actualOutputDirectory, { recursive: true });
try {
  for (const fixture of manifest.fixtures) {
    validateFixtureShape(fixture);
    const id = fixture.fixtureId;
    const inputSidecar = await loadRef(fixture.inputPcm, `${id} input`);
    const nativeSidecar = await loadRef(fixture.nativeOutputPcm, `${id} native output`);
    const input = decodeF32LE(inputSidecar.bytes);
    const nativeOutput = decodeF32LE(nativeSidecar.bytes);
    const { channels, frames, maxBlockFrames, sampleRateHz: sampleRate, mode, settings } = fixture;
    assert.equal(input.length, frames * channels);
    assert.equal(nativeOutput.length, frames * channels);
    assert.equal(maxBlockFrames <= inputLeft.frames, true, `${id}: prepared block exceeds scratch`);
    assert.ok(fixture.seed !== undefined, `${id}: deterministic seed required`);
    optionsBuffer.view.set([
      modeIds[mode],
      channels,
      settings.blockSamples,
      settings.intervalSamples,
      settings.splitComputation ? 1 : 0,
    ]);
    const handle = wasm.webrc_dsp_extended_create(
      KindSignalsmithStretch,
      sampleRate,
      maxBlockFrames,
      channels,
      optionsBuffer.address,
      5,
      seedValue(fixture.seed),
    );
    assert.notEqual(handle, 0,
      `${id}: create failed with status ${wasm.webrc_dsp_extended_last_create_status()}`);
    const actual = new Float32Array(frames * channels);
    let inputLatencySamples = 0;
    let outputLatencySamples = 0;
    try {
      const ratioBuffer = allocF32(2, `${id} transpose parameters`);
      try {
        ratioBuffer.view.set([settings.transposeRatio, settings.tonalityLimit]);
        assert.equal(wasm.webrc_dsp_extended_configure(handle, ControlStretchTranspose,
          ratioBuffer.address, 2, seedValue(fixture.seed)), Status.ok,
        `${id}: transpose configuration`);
      } finally {
        freeF32(ratioBuffer);
      }
      const formantBuffer = allocF32(2, `${id} formant parameters`);
      try {
        formantBuffer.view.set([settings.formantFactor, settings.compensatePitch ? 1 : 0]);
        assert.equal(wasm.webrc_dsp_extended_configure(handle, 13,
          formantBuffer.address, 2, seedValue(fixture.seed)), Status.ok,
        `${id}: formant configuration`);
      } finally {
        freeF32(formantBuffer);
      }
      inputLatencySamples = wasm.webrc_dsp_extended_input_latency_samples(handle);
      outputLatencySamples = wasm.webrc_dsp_extended_output_latency_samples(handle);
      assert.deepEqual({ input: inputLatencySamples, output: outputLatencySamples },
        fixture.declaredLatencySamples, `${id}: native/WASM reported latency metadata`);

      let frameOffset = 0;
      for (const blockFrames of partitionFrames(fixture)) {
        for (let frame = 0; frame < blockFrames; ++frame) {
          const sourceIndex = (frameOffset + frame) * channels;
          inputLeft.view[frame] = input[sourceIndex];
          inputRight.view[frame] = channels === 2 ? input[sourceIndex + 1] : 0;
          assert.ok(Number.isFinite(inputLeft.view[frame]), `${id}: finite left input`);
          assert.ok(Number.isFinite(inputRight.view[frame]), `${id}: finite right input`);
        }
        const processStatus = wasm.webrc_dsp_extended_process_pitch_stretch(
          handle,
          inputLeft.address,
          channels === 2 ? inputRight.address : 0,
          blockFrames,
          outputLeft.address,
          channels === 2 ? outputRight.address : 0,
          blockFrames,
        );
        assert.equal(processStatus, Status.ok, `${id}: process at frame ${frameOffset}`);
        for (let frame = 0; frame < blockFrames; ++frame) {
          const outputIndex = (frameOffset + frame) * channels;
          actual[outputIndex] = outputLeft.view[frame];
          if (channels === 2) actual[outputIndex + 1] = outputRight.view[frame];
        }
        frameOffset += blockFrames;
      }
      assert.equal(frameOffset, frames);
    } finally {
      assert.equal(wasm.webrc_dsp_extended_destroy(handle), Status.ok);
    }

    let maxAbsError = 0;
    let squaredError = 0;
    let nonFiniteSamples = 0;
    let firstMaxErrorIndex = -1;
    let firstNonzeroFrameAtThreshold1e6 = null;
    let actualPeak = 0;
    let actualPower = 0;
    for (let index = 0; index < actual.length; ++index) {
      const got = actual[index];
      if (!Number.isFinite(got) || !Number.isFinite(nativeOutput[index])) {
        nonFiniteSamples += 1;
        continue;
      }
      actualPeak = Math.max(actualPeak, Math.abs(got));
      actualPower += got * got;
      if (firstNonzeroFrameAtThreshold1e6 === null && Math.abs(got) > 1e-6) {
        firstNonzeroFrameAtThreshold1e6 = Math.floor(index / channels);
      }
      const error = Math.abs(got - nativeOutput[index]);
      if (error > maxAbsError) {
        maxAbsError = error;
        firstMaxErrorIndex = index;
      }
      squaredError += error * error;
    }
    const rmsError = Math.sqrt(squaredError / Math.max(1, actual.length));
    const tolerancePass = nonFiniteSamples === 0 &&
      maxAbsError <= fixture.tolerance.maxAbsError && rmsError <= fixture.tolerance.rmsError;
    allPass &&= tolerancePass;
    const outputSidecarName = `${String(id).replace(/[^A-Za-z0-9._-]+/g, '_')}.f32le`;
    const outputSidecarPath = path.join(actualOutputDirectory, outputSidecarName);
    const outputSidecarBytes = encodeF32LE(actual);
    await fs.writeFile(outputSidecarPath, outputSidecarBytes);
    results.push({
      id,
      mode,
      channels,
      sampleRate,
      frames,
      partitionProfile: fixture.partitions.profileId,
      callbackFrames: fixture.partitions.callbackFrames,
      transposeRatio: settings.transposeRatio,
      seed: String(fixture.seed),
      nativeDeclaredLatencySamples: fixture.declaredLatencySamples ?? null,
      wasmReportedLatency: { inputSamples: inputLatencySamples, outputSamples: outputLatencySamples },
      wasmOutputMetrics: {
        rms: Math.sqrt(actualPower / Math.max(1, actual.length)),
        peak: actualPeak,
        firstNonzeroFrameAtThreshold1e6,
      },
      expectedSidecarSha256: nativeSidecar.sha256,
      wasmOutputPcm: {
        path: path.relative(repoRoot, outputSidecarPath).replaceAll('\\', '/'),
        bytes: outputSidecarBytes.byteLength,
        sha256: sha256(outputSidecarBytes),
        frames,
        channels,
        encoding: 'float32-le-interleaved',
      },
      error: { maxAbsError, rmsError, nonFiniteSamples, firstMaxErrorIndex },
      tolerance: fixture.tolerance,
      result: tolerancePass ? 'PASS' : 'FAIL',
    });
  }
} finally {
  for (const token of Array.from(allocationTokens)) {
    wasm.webrc_dsp_free_transfer_token(token);
    allocationTokens.delete(token);
  }
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify({
  schemaVersion: 1,
  suite: 'shared-dsp-wasm-native-pcm-parity-v2',
  result: allPass ? 'PASS' : 'FAIL',
  nativeManifest: path.relative(repoRoot, manifestPath).replaceAll('\\', '/'),
  nativeManifestSha256: sha256(await fs.readFile(manifestPath)),
  nativeSource: manifest.source,
  nativeToolchain: manifest.nativeToolchain,
  nativeVendorPins: manifest.vendorPins,
  wasm: { path: path.relative(repoRoot, wasmPath).replaceAll('\\', '/'), sha256: wasmSha },
  wasmSourceSetSha256: wasmBuild.sourceSetSha256,
  emsdkCommit: wasmBuild.build.emsdkCommit,
  compilerIdentity: wasmBuild.build.compilerIdentity,
  wasiCalls,
  fixtures: results,
}, null, 2)}\n`, 'utf8');
assert.deepEqual(wasiCalls, { fd_close: 0, fd_write: 0, fd_seek: 0 }, 'unexpected WASI I/O');
assert.ok(allPass, `Native/WASM parity failed; see ${outputPath}`);
console.log(JSON.stringify({ suite: 'shared-dsp-wasm-native-pcm-parity-v2', result: 'PASS',
  fixtures: results.length, wasmSha256: wasmSha, sourceSetSha256: wasmBuild.sourceSetSha256,
  wasiCalls, output: outputPath }, null, 2));
