import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const manifestPath = path.resolve(process.argv[2] ?? 'bench/results/dsp_pcm_parity_v2/native_pitch_core_parity_v2/manifest.json');
const wasmPath = path.resolve(process.argv[3] ?? 'test-results/dsp-wasm/webrc-dsp.wasm');
const wasmBuildPath = path.resolve(process.argv[4] ?? 'test-results/dsp-wasm/webrc-dsp.build.json');
const outputPath = path.resolve(process.argv[5] ?? 'test-results/dsp-wasm/multimodule-pcm-parity-v2.compare.json');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const wasmBuild = JSON.parse(await fs.readFile(wasmBuildPath, 'utf8'));
const wasmBytes = await fs.readFile(wasmPath);
const wasmSha = sha256(wasmBytes);

assert.ok([2, 3].includes(manifest.schemaVersion), 'Native parity producer must use schema v2 or v3');
assert.equal(wasmBuild.schemaVersion, 1);
assert.equal(wasmBuild.artifact.sha256, wasmSha, 'WASM artifact differs from build manifest');
assert.equal(wasmBuild.artifact.byteLength, wasmBytes.byteLength);
assert.equal(wasmBuild.build.emsdkCommit, '35ff8a6d150541276abbc6bae512ca90bcfbe220');
assert.match(wasmBuild.build.compilerIdentity,
  /6\.0\.10 \(d6c521a7f05449857c76bd99e396895583cf2083\)$/);
const currentSourceSet = Object.keys(wasmBuild.sourceFiles).sort()
  .map(relative => `${relative}=${wasmBuild.sourceFiles[relative]}`).join('\n');
assert.equal(wasmBuild.sourceSetSha256, sha256(Buffer.from(currentSourceSet, 'utf8')),
  'WASM source-set digest');
for (const [relative, expectedHash] of Object.entries(wasmBuild.sourceFiles)) {
  assert.equal(sha256(await fs.readFile(path.resolve(repoRoot, relative))), expectedHash,
    `stale WASM source: ${relative}`);
}
assert.ok(manifest.source && manifest.nativeToolchain && Array.isArray(manifest.vendorPins));
assert.equal(manifest.source.sourceWasStableAcrossRun, true);
assert.ok(manifest.vendorPins.some(pin => pin.name === 'signalsmith-stretch' &&
  pin.commit === 'a670068d9aeb64913331d5cc29337b19a457a7df' && pin.license === 'MIT'));
assert.ok(manifest.vendorPins.some(pin => pin.name === 'signalsmith-linear' &&
  pin.commit === 'de55e6a50ffcf6f8f43f649692d94691c7025151' && pin.license === 'MIT'));
const nativeFileManifestPath = path.resolve(path.dirname(manifestPath), manifest.source.fileManifest);
const nativeFileManifestBytes = await fs.readFile(nativeFileManifestPath);
assert.equal(sha256(nativeFileManifestBytes), manifest.source.sourceFileManifestSha256);
const nativeFileManifest = JSON.parse(nativeFileManifestBytes.toString('utf8'));
assert.equal(nativeFileManifest.sourceTreeSha256, manifest.source.sourceTreeSha256);
assert.equal(nativeFileManifest.fileCount, manifest.source.sourceFileCount);
assert.equal(nativeFileManifest.files.length, nativeFileManifest.fileCount);
const nativeSourceRoot = path.resolve(path.dirname(nativeFileManifestPath), manifest.source.sourceRoot);
const sortedNativeFiles = [...nativeFileManifest.files].map(nativeFile => ({
  ...nativeFile,
  normalizedPath: nativeFile.path.replaceAll('\\', '/'),
})).sort((a, b) => a.normalizedPath < b.normalizedPath ? -1 : a.normalizedPath > b.normalizedPath ? 1 : 0);
const nativeCanonicalSourceSet = `${sortedNativeFiles.map(file =>
  `${file.normalizedPath}=${file.sha256.toLowerCase()}`).join('\n')}\n`;
assert.equal(sha256(Buffer.from(nativeCanonicalSourceSet, 'utf8')),
  nativeFileManifest.sourceTreeSha256, 'Native copied-source-set digest');
for (const nativeFile of sortedNativeFiles) {
  const relative = nativeFile.normalizedPath;
  const nativePath = path.resolve(nativeSourceRoot, ...relative.split('/'));
  const pathFromRoot = path.relative(nativeSourceRoot, nativePath);
  assert.ok(pathFromRoot && !pathFromRoot.startsWith(`..${path.sep}`) && pathFromRoot !== '..' &&
    !path.isAbsolute(pathFromRoot), `Native source path escapes snapshot root: ${relative}`);
  const nativeBytes = await fs.readFile(nativePath);
  assert.equal(nativeBytes.byteLength, nativeFile.bytes, `Native copied-source length mismatch: ${relative}`);
  assert.equal(sha256(nativeBytes), nativeFile.sha256,
    `Native copied-source hash mismatch: ${relative}`);
  if (wasmBuild.sourceFiles[relative]) {
    assert.equal(nativeFile.sha256, wasmBuild.sourceFiles[relative], `Native/WASM source mismatch: ${relative}`);
  }
}
assert.ok(Array.isArray(manifest.fixtures) && manifest.fixtures.length > 0);

const wasmModule = await WebAssembly.compile(wasmBytes);
assert.deepEqual(WebAssembly.Module.imports(wasmModule).map(({ module, name, kind }) => [module, name, kind]), [
  ['wasi_snapshot_preview1', 'fd_close', 'function'],
  ['wasi_snapshot_preview1', 'fd_write', 'function'],
  ['wasi_snapshot_preview1', 'fd_seek', 'function'],
]);
const wasiCalls = { fd_close: 0, fd_write: 0, fd_seek: 0 };
const instance = await WebAssembly.instantiate(wasmModule, { wasi_snapshot_preview1: {
  fd_close() { wasiCalls.fd_close += 1; return 8; },
  fd_write() { wasiCalls.fd_write += 1; return 8; },
  fd_seek() { wasiCalls.fd_seek += 1; return 8; },
} });
const wasm = instance.exports;
wasm._initialize();
const memory = wasm.memory;
assert.equal(memory.buffer.byteLength, 64 * 1024 * 1024);
assert.equal(wasm.webrc_dsp_abi_version(), 2);
assert.equal(wasm.webrc_dsp_extended_api_version(), 1);
assert.equal(wasm.webrc_dsp_capabilities(), 7);

const OK = 0;
const KIND = {
  parameterSmoother: 1, biquad: 2, svf: 3, allpass: 4, lagrangeDelay: 5,
  lfo: 6, polyBlep: 7, adaa: 8, compressor: 9, delayMatrix: 10, pcg32: 11,
  yin: 108, psolaBuffer: 109, streamingPsola: 110,
  phaseVocoder: 111, multibandVocoder: 112, signalsmith: 113,
};
const CONTROL = { streamingPitch: 9, vocoderEnvelope: 10, vocoderGain: 11,
  stretchTranspose: 12, stretchFormant: 13 };
const MODE = { LIVE_MONO: 0, LIVE_POLY: 1, HQ_RENDER: 2 };
const transferTokens = new Set();
const sidecarCache = new Map();

function checkSpan(address, byteLength, alignment, label) {
  assert.ok(Number.isInteger(address) && address > 0, `${label}: invalid address`);
  assert.ok(Number.isInteger(byteLength) && byteLength >= 0, `${label}: invalid length`);
  assert.equal(address % alignment, 0, `${label}: alignment`);
  assert.ok(address + byteLength <= memory.buffer.byteLength, `${label}: outside WASM memory`);
}

function allocateF32(frames, label) {
  assert.ok(Number.isInteger(frames) && frames > 0, `${label}: allocation frames`);
  const token = wasm.webrc_dsp_alloc_f32_token(frames);
  assert.notEqual(token, 0, `${label}: transfer allocation failed`);
  const address = wasm.webrc_dsp_transfer_address(token);
  checkSpan(address, frames * 4, 4, label);
  transferTokens.add(token);
  return { token, address, frames, view: new Float32Array(memory.buffer, address, frames) };
}

function releaseF32(buffer) {
  if (!buffer) return;
  assert.ok(transferTokens.delete(buffer.token), 'transfer token released once');
  assert.equal(wasm.webrc_dsp_free_transfer_token(buffer.token), OK);
}

function asSeed(seed) {
  const value = BigInt(seed ?? 0);
  assert.ok(value >= 0n && value <= 0xffffffffffffffffn, 'adapter seed must be uint64');
  return value;
}

function fixtureSeed(fixture) {
  return fixture.seed ?? fixture.seedState ?? fixture.settings?.seedState ?? fixture.inputRecipeSeed ?? 0;
}

async function resolveRef(ref, label) {
  assert.ok(ref && typeof ref.path === 'string', `${label}: missing sidecar reference`);
  let bytes;
  let resolvedPath;
  for (const candidate of [path.resolve(path.dirname(manifestPath), ref.path), path.resolve(repoRoot, ref.path)]) {
    try {
      bytes = await fs.readFile(candidate);
      resolvedPath = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  assert.ok(bytes, `${label}: sidecar not found: ${ref.path}`);
  assert.equal(bytes.byteLength, ref.bytes, `${label}: byte length`);
  assert.equal(sha256(bytes), ref.sha256, `${label}: SHA256`);
  return { bytes, path: resolvedPath, sha256: ref.sha256 };
}

async function loadPcm(ref, label, expectedFrames, expectedChannels) {
  const data = await resolveRef(ref, label);
  assert.equal(ref.encoding, 'float32-le-interleaved', `${label}: PCM encoding`);
  assert.equal(ref.frames, expectedFrames, `${label}: frame count`);
  assert.equal(ref.channels, expectedChannels, `${label}: channel count`);
  assert.equal(data.bytes.byteLength, ref.frames * ref.channels * 4, `${label}: PCM shape`);
  const values = decodeF32(data.bytes);
  for (let index = 0; index < values.length; ++index) {
    assert.ok(Number.isFinite(values[index]), `${label}: non-finite float at sample ${index}`);
  }
  return values;
}

async function loadComplex(ref, label, fftFrames) {
  const data = await resolveRef(ref, label);
  assert.equal(ref.encoding, 'float32-le-interleaved-complex', `${label}: complex encoding`);
  assert.ok(Number.isInteger(ref.frames) && ref.frames > 0);
  assert.equal(ref.channels, 1, `${label}: current phase-vocoder ABI is mono per spectrum`);
  assert.equal(ref.fftFrames, fftFrames, `${label}: FFT frame count`);
  assert.equal(data.bytes.byteLength, ref.frames * fftFrames * ref.channels * 2 * 4,
    `${label}: complex sidecar shape`);
  const values = decodeF32(data.bytes);
  for (let index = 0; index < values.length; ++index) {
    assert.ok(Number.isFinite(values[index]), `${label}: non-finite float at sample ${index}`);
  }
  return values;
}

async function cachedPcm(ref, label, frames, channels) {
  const key = `pcm:${ref.sha256}:${ref.path}`;
  if (!sidecarCache.has(key)) sidecarCache.set(key, await loadPcm(ref, label, frames, channels));
  return sidecarCache.get(key);
}

function decodeF32(bytes) {
  assert.equal(bytes.byteLength % 4, 0, 'float sidecar byte alignment');
  const values = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < values.length; ++i) values[i] = bytes.readFloatLE(i * 4);
  return values;
}

function encodeF32(values) {
  const bytes = Buffer.allocUnsafe(values.length * 4);
  for (let i = 0; i < values.length; ++i) {
    assert.ok(Number.isFinite(values[i]), `WASM output contains a non-finite float at sample ${i}`);
    bytes.writeFloatLE(values[i], i * 4);
  }
  return bytes;
}

function validateAudioOutputShape(fixture, run) {
  const frames = run.outputFrames ?? fixture.frames;
  const channels = run.outputChannels ?? fixture.nativeOutputPcm?.channels ?? fixture.channels;
  const encoding = run.encoding ?? 'float32-le-interleaved';
  assert.ok(Number.isInteger(frames) && frames > 0, `${fixture.fixtureId}: invalid WASM output frame count`);
  assert.ok(Number.isInteger(channels) && channels > 0 && channels <= 3,
    `${fixture.fixtureId}: invalid WASM output channel count`);
  assert.ok(run.actual instanceof Float32Array, `${fixture.fixtureId}: WASM output must be float32`);

  if (encoding === 'float32-le-interleaved-complex') {
    const fftFrames = run.fftFrames;
    const ref = fixture.nativeOutputComplex;
    assert.ok(Number.isInteger(fftFrames) && fftFrames > 0, `${fixture.fixtureId}: complex output FFT shape is missing`);
    assert.ok(ref, `${fixture.fixtureId}: Native complex output sidecar is missing`);
    assert.equal(ref.encoding, encoding, `${fixture.fixtureId}: Native complex output encoding`);
    assert.equal(ref.frames, frames, `${fixture.fixtureId}: Native complex output frame count`);
    assert.equal(ref.channels, channels, `${fixture.fixtureId}: Native complex output channel count`);
    assert.equal(run.actual.length, frames * channels * fftFrames * 2,
      `${fixture.fixtureId}: WASM complex output float shape`);
    return { frames, channels, encoding, fftFrames };
  }

  assert.equal(encoding, 'float32-le-interleaved', `${fixture.fixtureId}: unsupported WASM output encoding`);
  const ref = fixture.nativeOutputPcm;
  assert.ok(ref, `${fixture.fixtureId}: Native PCM output sidecar is missing`);
  assert.equal(ref.encoding, encoding, `${fixture.fixtureId}: Native PCM output encoding`);
  assert.equal(ref.frames, frames, `${fixture.fixtureId}: Native PCM output frame count`);
  assert.equal(ref.channels, channels, `${fixture.fixtureId}: Native PCM output channel count`);
  assert.equal(run.actual.length, frames * channels, `${fixture.fixtureId}: WASM output float shape`);
  return { frames, channels, encoding };
}

function exactPartitions(fixture) {
  const blocks = fixture.partitions?.callbackFrames;
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${fixture.fixtureId}: callback partition list`);
  assert.ok(blocks.every(frames => Number.isInteger(frames) && frames > 0 && frames <= fixture.maxBlockFrames),
    `${fixture.fixtureId}: invalid callback block`);
  assert.equal(blocks.reduce((sum, frames) => sum + frames, 0), fixture.frames,
    `${fixture.fixtureId}: callback total differs from frames`);
  return blocks;
}

function prepareHandle(fixture, kind, params = []) {
  const options = params.length ? allocateF32(params.length, `${fixture.fixtureId} prepare options`) : null;
  if (options) options.view.set(params);
  try {
    const handle = wasm.webrc_dsp_extended_create(
      kind, fixture.sampleRateHz, fixture.maxBlockFrames, fixture.channels,
      options?.address ?? 0, params.length, asSeed(fixtureSeed(fixture)));
    assert.notEqual(handle, 0,
      `${fixture.fixtureId}: kind ${kind} create failed with status ${wasm.webrc_dsp_extended_last_create_status()}`);
    return handle;
  } finally {
    releaseF32(options);
  }
}

function configure(handle, control, values, seed, label) {
  const buffer = allocateF32(values.length, `${label} configure`);
  try {
    buffer.view.set(values);
    assert.equal(wasm.webrc_dsp_extended_configure(handle, control, buffer.address,
      values.length, asSeed(seed)), OK, `${label}: configure ${control}`);
  } finally {
    releaseF32(buffer);
  }
}

function createBaseHandle(fixture, delayFrames = 0) {
  const handle = wasm.webrc_dsp_create(fixture.wasmKindId, fixture.sampleRateHz,
    fixture.maxBlockFrames, fixture.channels, delayFrames);
  assert.notEqual(handle, 0,
    `${fixture.fixtureId}: base kind ${fixture.wasmKindId} create failed with status ${wasm.webrc_dsp_last_create_status()}`);
  return handle;
}

function configureBase(handle, control, values, label) {
  const buffer = allocateF32(values.length, `${label} base configure`);
  try {
    buffer.view.set(values);
    assert.equal(wasm.webrc_dsp_configure(handle, control, buffer.address, values.length), OK,
      `${label}: base configure ${control}`);
  } finally {
    releaseF32(buffer);
  }
}

function transferRole(fixture, role) {
  const entry = fixture.setupPayloads?.find(payload => payload.role === role);
  assert.ok(entry?.pcm, `${fixture.fixtureId}: setup payload '${role}' is required`);
  return entry.pcm;
}

function writeInterleavedToPlanes(data, channels, startFrame, frames, left, right) {
  for (let frame = 0; frame < frames; ++frame) {
    const source = (startFrame + frame) * channels;
    left.view[frame] = data[source];
    right.view[frame] = channels === 2 ? data[source + 1] : 0;
  }
}

function processPlanarFixture(fixture, input, operation, scratch, additional) {
  const { channels, frames } = fixture;
  const output = new Float32Array(frames * channels);
  let offset = 0;
  for (const blockFrames of exactPartitions(fixture)) {
    writeInterleavedToPlanes(input, channels, offset, blockFrames, scratch.inL, scratch.inR);
    if (additional?.carrier) {
      writeInterleavedToPlanes(additional.carrier, 2, offset, blockFrames,
        scratch.carrierL, scratch.carrierR);
    }
    for (let i = 0; i < blockFrames; ++i) {
      assert.ok(Number.isFinite(scratch.inL.view[i]), `${fixture.fixtureId}: finite input L`);
      assert.ok(Number.isFinite(scratch.inR.view[i]), `${fixture.fixtureId}: finite input R`);
    }
    const status = operation({ blockFrames, offset, scratch });
    assert.equal(status, OK, `${fixture.fixtureId}: process at frame ${offset}`);
    for (let frame = 0; frame < blockFrames; ++frame) {
      const target = (offset + frame) * channels;
      output[target] = scratch.outL.view[frame];
      if (channels === 2) output[target + 1] = scratch.outR.view[frame];
    }
    offset += blockFrames;
  }
  assert.equal(offset, frames);
  return output;
}

function fixtureEvents(fixture) {
  const events = fixture.events == null ? [] : Array.isArray(fixture.events) ? fixture.events : [fixture.events];
  assert.equal(fixture.eventFrameUnit ?? 'sample-frame', 'sample-frame',
    `${fixture.fixtureId}: events must use sample-frame offsets`);
  let previous = -1;
  for (const event of events) {
    assert.ok(Number.isInteger(event.frameOffset) && event.frameOffset >= 0 && event.frameOffset <= fixture.frames,
      `${fixture.fixtureId}: invalid event frame`);
    assert.ok(event.frameOffset >= previous, `${fixture.fixtureId}: events are not ordered`);
    assert.ok(Number.isInteger(event.controlId) && Array.isArray(event.values) && event.values.every(Number.isFinite),
      `${fixture.fixtureId}: malformed control event`);
    previous = event.frameOffset;
  }
  return events;
}

async function runBaseStream(fixture, scratch) {
  const id = fixture.fixtureId;
  const input = fixture.inputPcm
    ? await cachedPcm(fixture.inputPcm, `${id} input`, fixture.frames, fixture.channels)
    : null;
  const outputRef = fixture.nativeOutputPcm;
  assert.ok(outputRef, `${id}: Native PCM output is required`);
  assert.equal(outputRef.frames, fixture.frames, `${id}: Native output frame count`);
  const outputChannels = outputRef.channels;
  assert.ok(Number.isInteger(outputChannels) && outputChannels >= 1 && outputChannels <= 3,
    `${id}: unsupported output channel count`);
  const expected = await loadPcm(outputRef, `${id} Native output`, fixture.frames, outputChannels);
  const delayFrames = fixture.wasmKindId === 5 ? fixture.settings.maximumDelaySamples : 0;
  const handle = createBaseHandle(fixture, delayFrames);
  const controls = fixture.settings.controls ?? [];
  const events = fixtureEvents(fixture);
  const actual = new Float32Array(fixture.frames * outputChannels);
  let delaySamples = null;
  let delayedLeft = null;
  let delayedRight = null;
  try {
    if (fixture.wasmKindId === 1 && Number.isFinite(fixture.settings.initialValue)) {
      configureBase(handle, 16, [fixture.settings.initialValue], `${id} initial smoother state`);
    } else if (fixture.wasmKindId === 6 && Number.isFinite(fixture.settings.initialPhaseCycles)) {
      configureBase(handle, 17, [fixture.settings.initialPhaseCycles], `${id} initial LFO phase`);
    } else if (fixture.wasmKindId === 7 && Number.isFinite(fixture.settings.initialPhaseCycles)) {
      configureBase(handle, 18, [fixture.settings.initialPhaseCycles], `${id} initial oscillator phase`);
    }
    if (fixture.wasmKindId === 11) {
      assert.equal(wasm.webrc_dsp_seed(handle, asSeed(fixture.seedState ?? fixture.settings.seedState),
        asSeed(fixture.seedSequence ?? fixture.settings.seedSequence)), OK, `${id}: PCG seed`);
    }
    for (const control of controls) {
      configureBase(handle, control.controlId, control.values, `${id} initial control`);
    }
    if (fixture.wasmKindId === 5) {
      delaySamples = await cachedPcm(transferRole(fixture, 'delaySamples'), `${id} delay trajectory`, fixture.frames, 1);
    } else if (fixture.wasmKindId === 10) {
      delayedLeft = await cachedPcm(transferRole(fixture, 'delayedLeft'), `${id} feedback left`, fixture.frames, 1);
      delayedRight = await cachedPcm(transferRole(fixture, 'delayedRight'), `${id} feedback right`, fixture.frames, 1);
    }

    let cursor = 0;
    let eventIndex = 0;
    for (const blockFrames of exactPartitions(fixture)) {
      const blockStart = cursor;
      const blockEnd = blockStart + blockFrames;
      while (cursor < blockEnd) {
        while (eventIndex < events.length && events[eventIndex].frameOffset === cursor) {
          const event = events[eventIndex++];
          configureBase(handle, event.controlId, event.values, `${id} event @${cursor}`);
        }
        const nextEvent = eventIndex < events.length ? events[eventIndex].frameOffset : blockEnd;
        const segmentFrames = Math.min(blockEnd, nextEvent) - cursor;
        assert.ok(segmentFrames > 0, `${id}: event schedule stalled at ${cursor}`);
        const localOffset = cursor - blockStart;
        for (let frame = 0; frame < segmentFrames; ++frame) {
          const globalFrame = cursor + frame;
          if (input) {
            const inputBase = globalFrame * fixture.channels;
            scratch.inL.view[localOffset + frame] = input[inputBase];
            scratch.inR.view[localOffset + frame] = fixture.channels === 2 ? input[inputBase + 1] : 0;
          }
          if (delaySamples) scratch.delay.view[localOffset + frame] = delaySamples[globalFrame];
          if (delayedLeft) {
            scratch.delayStereo.view[frame] = delayedLeft[globalFrame];
            scratch.delayStereo.view[segmentFrames + frame] = delayedRight[globalFrame];
          }
        }
        const byteOffset = localOffset * Float32Array.BYTES_PER_ELEMENT;
        const inL = input ? scratch.inL.address + byteOffset : 0;
        const inR = input && fixture.channels === 2 ? scratch.inR.address + byteOffset : 0;
        const out0 = scratch.outL.address + byteOffset;
        const out1 = scratch.outR.address + byteOffset;
        const out2 = scratch.out2.address + byteOffset;
        const parameters = fixture.wasmKindId === 5
          ? scratch.delay.address + byteOffset
          : fixture.wasmKindId === 10 ? scratch.delayStereo.address : 0;
        const status = wasm.webrc_dsp_process(handle, inL, inR, out0, out1, out2,
          parameters, segmentFrames);
        assert.equal(status, OK, `${id}: process at frame ${cursor}`);
        for (let frame = 0; frame < segmentFrames; ++frame) {
          const target = (cursor + frame) * outputChannels;
          actual[target] = scratch.outL.view[localOffset + frame];
          if (outputChannels >= 2) actual[target + 1] = scratch.outR.view[localOffset + frame];
          if (outputChannels >= 3) actual[target + 2] = scratch.out2.view[localOffset + frame];
        }
        cursor += segmentFrames;
      }
    }
    while (eventIndex < events.length && events[eventIndex].frameOffset === fixture.frames) {
      const event = events[eventIndex++];
      configureBase(handle, event.controlId, event.values, `${id} terminal event`);
    }
    assert.equal(eventIndex, events.length, `${id}: unconsumed events`);
    assert.equal(cursor, fixture.frames);
  } finally {
    assert.equal(wasm.webrc_dsp_destroy(handle), OK, `${id}: base destroy`);
  }
  return { actual, expected, inputLatency: null, outputLatency: null, outputChannels };
}

function compareVectors(actual, expected, tolerance, rejectNonFinite = true) {
  assert.equal(actual.length, expected.length, 'comparison vector lengths');
  let maxAbsError = 0;
  let firstMaxErrorIndex = -1;
  let squaredError = 0;
  let nonFiniteSamples = 0;
  for (let i = 0; i < actual.length; ++i) {
    if (!Number.isFinite(actual[i]) || !Number.isFinite(expected[i])) {
      nonFiniteSamples += 1;
      continue;
    }
    const error = Math.abs(actual[i] - expected[i]);
    squaredError += error * error;
    if (error > maxAbsError) {
      maxAbsError = error;
      firstMaxErrorIndex = i;
    }
  }
  const rmsError = Math.sqrt(squaredError / Math.max(1, actual.length));
  return {
    maxAbsError,
    rmsError,
    nonFiniteSamples,
    firstMaxErrorIndex,
    pass: (!rejectNonFinite || nonFiniteSamples === 0) &&
      maxAbsError <= tolerance.maxAbsError && rmsError <= tolerance.rmsError,
  };
}

async function runSignalsmith(fixture, scratch) {
  const { fixtureId: id, settings, channels, frames } = fixture;
  assert.ok(['LIVE_MONO', 'LIVE_POLY', 'HQ_RENDER'].includes(fixture.mode));
  assert.equal(settings.mode, fixture.mode);
  assert.equal(settings.channels, channels);
  const input = await cachedPcm(fixture.inputPcm, `${id} input`, frames, channels);
  const expected = await loadPcm(fixture.nativeOutputPcm, `${id} Native output`, frames,
    fixture.nativeOutputPcm.channels);
  const handle = prepareHandle(fixture, KIND.signalsmith, [
    MODE[fixture.mode], channels, settings.blockSamples, settings.intervalSamples,
    settings.splitComputation ? 1 : 0,
  ]);
  let inputLatency = null;
  let outputLatency = null;
  let actual;
  try {
    configure(handle, CONTROL.stretchTranspose,
      [settings.transposeRatio, settings.tonalityLimit], fixture.seed, `${id} transpose`);
    configure(handle, CONTROL.stretchFormant,
      [settings.formantFactor, settings.compensatePitch ? 1 : 0], fixture.seed, `${id} formant`);
    inputLatency = wasm.webrc_dsp_extended_input_latency_samples(handle);
    outputLatency = wasm.webrc_dsp_extended_output_latency_samples(handle);
    if (fixture.declaredLatencySamples && typeof fixture.declaredLatencySamples === 'object') {
      assert.deepEqual({ input: inputLatency, output: outputLatency }, fixture.declaredLatencySamples,
        `${id}: latency getters`);
    }
    actual = processPlanarFixture(fixture, input,
      ({ blockFrames, scratch: b }) => wasm.webrc_dsp_extended_process_pitch_stretch(
        handle, b.inL.address, channels === 2 ? b.inR.address : 0, blockFrames,
        b.outL.address, channels === 2 ? b.outR.address : 0, blockFrames), scratch);
  } finally {
    assert.equal(wasm.webrc_dsp_extended_destroy(handle), OK);
  }
  return { actual, expected, inputLatency, outputLatency };
}

async function runYin(fixture) {
  const { fixtureId: id, settings } = fixture;
  assert.equal(fixture.channels, 1);
  const input = await cachedPcm(fixture.inputPcm, `${id} input`, fixture.frames, 1);
  const handle = prepareHandle(fixture, KIND.yin, [settings.frameFrames,
    settings.minimumFrequencyHz, settings.maximumFrequencyHz, settings.threshold]);
  const windowInput = allocateF32(settings.frameFrames, `${id} YIN window`);
  const estimateOut = allocateF32(5, `${id} YIN estimate`);
  const actual = [];
  try {
    for (const window of fixture.analysisWindows) {
      const windowFrames = window.frameFrames ?? window.frames;
      assert.equal(windowFrames, settings.frameFrames, `${id}: analysis frame size`);
      assert.ok(window.startFrame >= 0 && window.startFrame + windowFrames <= fixture.frames);
      windowInput.view.set(input.subarray(window.startFrame, window.startFrame + windowFrames));
      assert.equal(wasm.webrc_dsp_extended_yin_analyze(handle, windowInput.address,
        windowFrames, estimateOut.address), OK, `${id}: analyze at ${window.startFrame}`);
      actual.push({
        frequencyHz: estimateOut.view[0],
        periodSamples: estimateOut.view[1],
        confidence: estimateOut.view[2],
        rms: estimateOut.view[3],
        voiced: new Uint32Array(memory.buffer, estimateOut.address + 16, 1)[0] !== 0,
      });
    }
  } finally {
    assert.equal(wasm.webrc_dsp_extended_destroy(handle), OK);
    releaseF32(windowInput);
    releaseF32(estimateOut);
  }
  assert.equal(actual.length, fixture.nativeAnalysis.length);
  const fields = fixture.tolerance.analysisFields;
  assert.ok(fields && typeof fields === 'object', `${id}: field tolerances required for analysis results`);
  let allFieldsPass = true;
  const fieldResults = {};
  for (const field of ['frequencyHz', 'periodSamples', 'confidence', 'rms']) {
    const tolerance = fields[field];
    const maximum = tolerance?.maxAbsError ?? tolerance?.maxAbs;
    const rmsMaximum = tolerance?.rmsError ?? maximum;
    assert.ok(tolerance && Number.isFinite(maximum) && Number.isFinite(rmsMaximum),
      `${id}: missing ${field} tolerance`);
    const values = [];
    const expected = [];
    for (let index = 0; index < actual.length; ++index) {
      values.push(actual[index][field]);
      expected.push(fixture.nativeAnalysis[index][field]);
    }
    const metrics = compareVectors(values, expected,
      { maxAbsError: maximum, rmsError: rmsMaximum, rejectNonFinite: true }, true);
    fieldResults[field] = metrics;
    allFieldsPass &&= metrics.pass;
  }
  const voicedMatch = actual.every((estimate, index) => estimate.voiced === fixture.nativeAnalysis[index].voiced);
  allFieldsPass &&= voicedMatch;
  return { analysis: actual, fieldResults, voicedMatch, pass: allFieldsPass };
}

async function runPsolaBuffer(fixture) {
  const { fixtureId: id, settings } = fixture;
  assert.equal(fixture.channels, 1);
  const maximumPitchPeriodSamples = settings.maximumPitchPeriodSamples ?? settings.maxPitchPeriodSamples;
  assert.ok(Number.isInteger(settings.maxBufferFrames) && settings.maxBufferFrames >= fixture.frames,
    `${id}: invalid offline buffer capacity`);
  assert.ok(Number.isInteger(maximumPitchPeriodSamples) && maximumPitchPeriodSamples >= 4,
    `${id}: maximum pitch period must be an explicit integer sample count`);
  const input = await cachedPcm(fixture.inputPcm, `${id} input`, fixture.frames, 1);
  const expected = await loadPcm(fixture.nativeOutputPcm, `${id} Native output`, fixture.frames,
    fixture.nativeOutputPcm.channels);
  // The whole-buffer renderer has a 15,360-frame capture capacity; its
  // ProcessSpec remains a valid realtime-sized setup spec because the single
  // offline call is separately checked against `maxBufferFrames`.
  const handle = prepareHandle({ ...fixture, maxBlockFrames: Math.min(fixture.maxBlockFrames, 512) }, KIND.psolaBuffer,
    [settings.maxBufferFrames, maximumPitchPeriodSamples]);
  const inputBuffer = allocateF32(fixture.frames, `${id} offline input`);
  const outputBuffer = allocateF32(fixture.frames, `${id} offline output`);
  let actual;
  try {
    inputBuffer.view.set(input);
    assert.equal(wasm.webrc_dsp_extended_process_pitch_buffer(handle,
      inputBuffer.address, outputBuffer.address, fixture.frames,
      settings.sourcePeriodSamples, settings.pitchRatio), OK, `${id}: buffer process`);
    actual = Float32Array.from(outputBuffer.view.subarray(0, fixture.frames));
  } finally {
    assert.equal(wasm.webrc_dsp_extended_destroy(handle), OK);
    releaseF32(inputBuffer);
    releaseF32(outputBuffer);
  }
  return { actual, expected, inputLatency: null, outputLatency: null };
}

async function runStreamingPsola(fixture, scratch) {
  const { fixtureId: id, settings } = fixture;
  assert.equal(fixture.channels, 1);
  const input = await cachedPcm(fixture.inputPcm, `${id} input`, fixture.frames, 1);
  const expected = await loadPcm(fixture.nativeOutputPcm, `${id} Native output`, fixture.frames,
    fixture.nativeOutputPcm.channels);
  const handle = prepareHandle(fixture, KIND.streamingPsola,
    [settings.maximumPitchPeriodSamples ?? settings.maxPitchPeriodSamples]);
  let actual;
  let inputLatency = null;
  let outputLatency = null;
  try {
    const pitchControl = settings.controls?.find(control => control.controlId === CONTROL.streamingPitch);
    configure(handle, CONTROL.streamingPitch,
      pitchControl?.values ?? [settings.sourcePeriodSamples, settings.pitchRatio, settings.voiced ? 1 : 0],
      fixtureSeed(fixture), `${id} pitch`);
    inputLatency = wasm.webrc_dsp_extended_input_latency_samples(handle);
    outputLatency = wasm.webrc_dsp_extended_output_latency_samples(handle);
    if (fixture.declaredLatencySamples && typeof fixture.declaredLatencySamples === 'object') {
      assert.deepEqual({ input: inputLatency, output: outputLatency }, fixture.declaredLatencySamples,
        `${id}: latency getters`);
    }
    actual = processPlanarFixture(fixture, input,
      ({ blockFrames, scratch: b }) => wasm.webrc_dsp_extended_process_mono(
        handle, b.inL.address, b.outL.address, blockFrames), scratch);
  } finally {
    assert.equal(wasm.webrc_dsp_extended_destroy(handle), OK);
  }
  return { actual, expected, inputLatency, outputLatency };
}

async function runPhaseVocoder(fixture) {
  const { fixtureId: id, settings } = fixture;
  const fftFrames = settings.fftFrames;
  assert.ok(Number.isInteger(fftFrames) && fftFrames > 0);
  const input = await loadComplex(fixture.inputComplex, `${id} complex input`, fftFrames);
  const expected = await loadComplex(fixture.nativeOutputComplex, `${id} Native complex output`, fftFrames);
  assert.equal(input.length, expected.length);
  const handle = prepareHandle(fixture, KIND.phaseVocoder,
    [fftFrames, settings.analysisHopFrames ?? settings.analysisHop,
      settings.synthesisHopFrames ?? settings.synthesisHop]);
  const frameInput = allocateF32(fftFrames * 2, `${id} spectrum input`);
  const frameOutput = allocateF32(fftFrames * 2, `${id} spectrum output`);
  const actual = new Float32Array(input.length);
  try {
    const stride = fftFrames * 2;
    for (let frame = 0; frame < fixture.inputComplex.frames; ++frame) {
      frameInput.view.set(input.subarray(frame * stride, (frame + 1) * stride));
      assert.equal(wasm.webrc_dsp_extended_process_spectrum(handle,
        frameInput.address, frameOutput.address, settings.pitchRatio), OK,
      `${id}: spectrum frame ${frame}`);
      actual.set(frameOutput.view.subarray(0, stride), frame * stride);
    }
  } finally {
    assert.equal(wasm.webrc_dsp_extended_destroy(handle), OK);
    releaseF32(frameInput);
    releaseF32(frameOutput);
  }
  return { actual, expected, inputLatency: null, outputLatency: null,
    encoding: 'float32-le-interleaved-complex', outputFrames: fixture.inputComplex.frames,
    outputChannels: fixture.inputComplex.channels, fftFrames };
}

async function runVocoder(fixture, scratch) {
  const { fixtureId: id, settings } = fixture;
  assert.equal(fixture.channels, 2);
  const modulator = await cachedPcm(fixture.inputPcm, `${id} modulator`, fixture.frames, 2);
  const carrierPayload = fixture.setupPayloads.find(payload => payload.role === 'carrier');
  assert.ok(carrierPayload?.pcm, `${id}: carrier setup PCM payload required`);
  const carrier = await cachedPcm(carrierPayload.pcm, `${id} carrier`, fixture.frames, 2);
  const expected = await loadPcm(fixture.nativeOutputPcm, `${id} Native output`, fixture.frames,
    fixture.nativeOutputPcm.channels);
  const handle = prepareHandle(fixture, KIND.multibandVocoder,
    [settings.bands, settings.minimumFrequencyHz, settings.maximumFrequencyHz,
      settings.bandQ ?? settings.q]);
  let actual;
  try {
    configure(handle, CONTROL.vocoderEnvelope, [settings.attackMs, settings.releaseMs], fixture.seed, `${id} envelope`);
    configure(handle, CONTROL.vocoderGain, [settings.outputGain], fixture.seed, `${id} output gain`);
    actual = processPlanarFixture(fixture, modulator,
      ({ blockFrames, scratch: b }) => wasm.webrc_dsp_extended_process_vocoder(handle,
        b.inL.address, b.inR.address, b.carrierL.address, b.carrierR.address,
        b.outL.address, b.outR.address, blockFrames), scratch, { carrier });
  } finally {
    assert.equal(wasm.webrc_dsp_extended_destroy(handle), OK);
  }
  return { actual, expected, inputLatency: null, outputLatency: null };
}

function validateCommonFixture(fixture) {
  assert.equal(typeof fixture.fixtureId, 'string');
  assert.ok(Number.isInteger(fixture.wasmKindId));
  assert.ok(Number.isFinite(fixture.sampleRateHz) && fixture.sampleRateHz >= 8000 && fixture.sampleRateHz <= 384000);
  assert.ok(Number.isInteger(fixture.channels) && (fixture.channels === 1 || fixture.channels === 2));
  assert.ok(Number.isInteger(fixture.maxBlockFrames) && fixture.maxBlockFrames > 0);
  assert.ok(Number.isInteger(fixture.frames) && fixture.frames > 0);
  assert.ok(fixture.settings && typeof fixture.settings === 'object');
  assert.ok(fixture.tolerance && typeof fixture.tolerance === 'object');
  assert.ok(fixture.seed !== undefined || fixture.seedState !== undefined || fixture.settings.seedState !== undefined ||
    fixture.inputRecipeSeed !== undefined,
    `${fixture.fixtureId}: explicit seed metadata required`);
  if (fixture.wasmKindId === KIND.pcg32) {
    const decimal64 = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) &&
      BigInt(value) <= 0xffffffffffffffffn;
    assert.ok(decimal64(fixture.seedState) && decimal64(fixture.settings.seedState) &&
      decimal64(fixture.seedSequence) && decimal64(fixture.settings.seedSequence),
    `${fixture.fixtureId}: PCG seeds must be decimal uint64 strings in both metadata locations`);
    assert.equal(fixture.settings.seedState, fixture.seedState,
      `${fixture.fixtureId}: top-level/settings PCG state seed must agree`);
    assert.equal(fixture.settings.seedSequence, fixture.seedSequence,
      `${fixture.fixtureId}: top-level/settings PCG sequence seed must agree`);
  }
}

const maxBlockFrames = Math.max(...manifest.fixtures.map(fixture => fixture.maxBlockFrames));
const scratch = {
  inL: allocateF32(maxBlockFrames, 'block input left'),
  inR: allocateF32(maxBlockFrames, 'block input right'),
  carrierL: allocateF32(maxBlockFrames, 'block carrier left'),
  carrierR: allocateF32(maxBlockFrames, 'block carrier right'),
  outL: allocateF32(maxBlockFrames, 'block output left'),
  outR: allocateF32(maxBlockFrames, 'block output right'),
  out2: allocateF32(maxBlockFrames, 'block output third channel'),
  delay: allocateF32(maxBlockFrames, 'block delay parameter'),
  delayStereo: allocateF32(maxBlockFrames * 2, 'block delay feedback stereo'),
};
const actualOutputDirectory = `${outputPath}.wasm-pcm`;
await fs.mkdir(actualOutputDirectory, { recursive: true });
const results = [];
let allPass = true;
try {
  for (const fixture of manifest.fixtures) {
    validateCommonFixture(fixture);
    const id = fixture.fixtureId;
    const operation = fixture.operation ?? (fixture.wasmKindId === KIND.signalsmith ? 'signalsmith-stretch' : null);
    assert.ok(operation, `${id}: explicit operation required`);
    assert.ok(fixture.maxBlockFrames <= maxBlockFrames);
    let run;
    if (operation === 'signalsmith-stretch') run = await runSignalsmith(fixture, scratch);
    else if (operation.startsWith('base-')) run = await runBaseStream(fixture, scratch);
    else if (operation === 'yin-analyze') run = await runYin(fixture);
    else if (operation === 'psola-buffer') run = await runPsolaBuffer(fixture);
    else if (operation === 'streaming-psola') run = await runStreamingPsola(fixture, scratch);
    else if (operation === 'phase-vocoder-frame-stream') run = await runPhaseVocoder(fixture);
    else if (operation === 'multiband-vocoder') run = await runVocoder(fixture, scratch);
    else throw new Error(`${id}: unsupported explicit operation '${operation}'`);

    if (operation === 'yin-analyze') {
      allPass &&= run.pass;
      results.push({
        id, operation, mode: fixture.mode ?? null, channels: fixture.channels,
        sampleRateHz: fixture.sampleRateHz, frames: fixture.frames,
        seed: String(fixtureSeed(fixture)), nativeDeclaredLatencySamples: fixture.declaredLatencySamples ?? null,
        wasmReportedLatency: null, analysisWindows: fixture.analysisWindows,
        nativeAnalysis: fixture.nativeAnalysis, wasmAnalysis: run.analysis,
        fieldErrors: run.fieldResults, voicedMatch: run.voicedMatch,
        result: run.pass ? 'PASS' : 'FAIL', tolerance: fixture.tolerance,
      });
      continue;
    }

    const expected = run.expected;
    const outputShape = validateAudioOutputShape(fixture, run);
    assert.equal(run.actual.length, expected.length, `${id}: Native/WASM output vector shape`);
    const tolerancePass = compareVectors(run.actual, expected, fixture.tolerance,
      fixture.tolerance.rejectNonFinite !== false);
    allPass &&= tolerancePass.pass;
    const pcmBytes = encodeF32(run.actual);
    const sidecarName = `${String(id).replace(/[^A-Za-z0-9._-]+/g, '_')}.f32le`;
    const sidecarPath = path.join(actualOutputDirectory, sidecarName);
    await fs.writeFile(sidecarPath, pcmBytes);
    results.push({
      id,
      operation,
      mode: fixture.mode ?? null,
      channels: fixture.channels,
      sampleRateHz: fixture.sampleRateHz,
      frames: fixture.frames,
      seed: String(fixtureSeed(fixture)),
      partitionProfile: fixture.partitions?.profileId ?? null,
      callbackFrames: fixture.partitions?.callbackFrames ?? null,
      transposeRatio: fixture.settings.transposeRatio ?? fixture.settings.pitchRatio ?? null,
      nativeDeclaredLatencySamples: fixture.declaredLatencySamples ?? null,
      wasmReportedLatency: { inputSamples: run.inputLatency, outputSamples: run.outputLatency },
      encoding: outputShape.encoding,
      wasmOutput: {
        path: path.relative(repoRoot, sidecarPath).replaceAll('\\', '/'),
        bytes: pcmBytes.byteLength,
        sha256: sha256(pcmBytes),
        frames: outputShape.frames,
        channels: outputShape.channels,
        ...(outputShape.fftFrames ? { fftFrames: outputShape.fftFrames } : {}),
        encoding: outputShape.encoding,
      },
      error: tolerancePass,
      tolerance: fixture.tolerance,
      result: tolerancePass.pass ? 'PASS' : 'FAIL',
    });
  }
} finally {
  for (const token of Array.from(transferTokens)) {
    wasm.webrc_dsp_free_transfer_token(token);
    transferTokens.delete(token);
  }
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify({
  schemaVersion: 1,
  suite: 'shared-dsp-wasm-native-multimodule-parity-v2',
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
console.log(JSON.stringify({ suite: 'shared-dsp-wasm-native-multimodule-parity-v2',
  result: 'PASS', fixtures: results.length, wasmSha256: wasmSha,
  sourceSetSha256: wasmBuild.sourceSetSha256, wasiCalls, output: outputPath }, null, 2));
