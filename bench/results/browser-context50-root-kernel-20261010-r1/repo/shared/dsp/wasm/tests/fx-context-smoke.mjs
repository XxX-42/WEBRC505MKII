import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = process.argv[2];
assert.ok(modulePath, 'usage: node fx-context-smoke.mjs <webrc-dsp.wasm> [webrc-dsp.build.json]');
const moduleBytes = await fs.readFile(modulePath);
const manifestPath = path.resolve(process.argv[3] ?? modulePath.replace(/\.wasm$/i, '.build.json'));
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.sourceFilesStableDuringBuild, true);
assert.equal(manifest.artifact.byteLength, moduleBytes.byteLength);
assert.equal(manifest.artifact.sha256, sha256(moduleBytes), 'module must match its immutable build manifest');
const canonicalSourceSet = Object.keys(manifest.sourceFiles ?? {}).sort()
  .map(relative => `${relative}=${manifest.sourceFiles[relative]}`).join('\n');
assert.equal(manifest.sourceSetSha256, sha256(Buffer.from(canonicalSourceSet, 'utf8')),
  'source-set digest must match the build manifest');
for (const [relative, expected] of Object.entries(manifest.sourceFiles ?? {})) {
  const current = sha256(await fs.readFile(path.resolve(repositoryRoot, relative)));
  assert.equal(current, expected, `current compiler input differs from the module: ${relative}`);
}
const { instance } = await WebAssembly.instantiate(moduleBytes, {
  wasi_snapshot_preview1: {
    fd_close() { return 8; },
    fd_write() { return 8; },
    fd_seek() { return 8; },
  },
});
const wasm = instance.exports;
wasm._initialize();
const memory = wasm.memory;
assert.equal(wasm.webrc_dsp_fx_context_api_version(), 1);

const frames = 128;
const tokens = [];
function allocateF32(count) {
  const token = wasm.webrc_dsp_alloc_f32_token(count);
  assert.notEqual(token, 0);
  tokens.push(token);
  const address = wasm.webrc_dsp_transfer_address(token);
  assert.ok(address > 0 && address % 4 === 0 && address + count * 4 <= memory.buffer.byteLength);
  return { token, address, samples: new Float32Array(memory.buffer, address, count) };
}
function release(buffer) {
  const index = tokens.indexOf(buffer.token);
  assert.notEqual(index, -1);
  assert.equal(wasm.webrc_dsp_free_transfer_token(buffer.token), 0);
  tokens.splice(index, 1);
}
function makeEventBuffer(events) {
  const backing = allocateF32(events.length * 2);
  const view = new DataView(memory.buffer, backing.address, events.length * 8);
  events.forEach((event, index) => {
    const offset = index * 8;
    view.setUint32(offset, event.frameOffset, true);
    view.setUint8(offset + 4, event.type);
    view.setUint8(offset + 5, event.channel ?? 0);
    view.setUint8(offset + 6, event.note ?? 60);
    view.setUint8(offset + 7, event.velocity ?? 100);
  });
  return backing;
}
function makeParameterBuffers(events) {
  const offsets = allocateF32(events.length);
  const ids = allocateF32(events.length);
  const values = allocateF32(events.length);
  const offsetsU32 = new Uint32Array(memory.buffer, offsets.address, events.length);
  const idsU32 = new Uint32Array(memory.buffer, ids.address, events.length);
  events.forEach((event, index) => {
    offsetsU32[index] = event.frameOffset;
    idsU32[index] = event.id;
    values.samples[index] = event.value;
  });
  return { offsets, ids, values };
}
function create(ordinal, parameters = []) {
  let handle;
  if (parameters.length === 0) {
    handle = wasm.webrc_dsp_fx_create(ordinal, 48000, frames, 2);
  } else {
    const ids = allocateF32(parameters.length);
    const values = allocateF32(parameters.length);
    const idsU32 = new Uint32Array(memory.buffer, ids.address, parameters.length);
    parameters.forEach(([id, value], index) => {
      idsU32[index] = id;
      values.samples[index] = value;
    });
    handle = wasm.webrc_dsp_fx_create_v2(ordinal, 48000, frames, 2,
      ids.address, values.address, parameters.length);
    release(values);
    release(ids);
  }
  assert.notEqual(handle, 0, `create ordinal ${ordinal} failed: ${wasm.webrc_dsp_fx_last_create_status()}`);
  return handle;
}
function runContext(handle, {
  inputLeft, inputRight, outputLeft, outputRight,
  carrierLeft = 0, carrierRight = 0, carrierFrames = 0, carrierChannels = 0,
  parameterOffsets = 0, parameterIds = 0, parameterValues = 0, parameterCount = 0,
  midi = null, midiCount = 0,
} = {}) {
  return wasm.webrc_dsp_fx_process_stereo_context_v1(
    handle, inputLeft, inputRight, outputLeft, outputRight, frames,
    parameterOffsets, parameterIds, parameterValues, parameterCount,
    carrierLeft, carrierRight, carrierFrames, carrierChannels,
    midi?.address ?? 0, midiCount,
  );
}
function expectRejectedWithoutOutput(handle, options, label) {
  outputLeft.samples.fill(0.3125);
  outputRight.samples.fill(-0.4375);
  const beforeLeft = Float32Array.from(outputLeft.samples);
  const beforeRight = Float32Array.from(outputRight.samples);
  assert.equal(runContext(handle, { ...input, ...options }), -2, label);
  assert.deepEqual(outputLeft.samples, beforeLeft, `${label}: left output was modified`);
  assert.deepEqual(outputRight.samples, beforeRight, `${label}: right output was modified`);
}

const mainLeft = allocateF32(frames);
const mainRight = allocateF32(frames);
const outputLeft = allocateF32(frames);
const outputRight = allocateF32(frames);
const carrierLeft = allocateF32(frames);
const carrierRight = allocateF32(frames);
for (let i = 0; i < frames; i += 1) {
  mainLeft.samples[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / 48000);
  mainRight.samples[i] = 0.22 * Math.sin(2 * Math.PI * 733 * i / 48000 + 0.4);
  carrierLeft.samples[i] = 0.45 * Math.sin(2 * Math.PI * 330 * i / 48000);
  carrierRight.samples[i] = 0.37 * Math.sin(2 * Math.PI * 997 * i / 48000 + 0.3);
}
const input = {
  inputLeft: mainLeft.address,
  inputRight: mainRight.address,
  outputLeft: outputLeft.address,
  outputRight: outputRight.address,
};

// VOCODER20 must have a real, frame-matched stereo carrier. Failed sidecar
// requests must not advance processor state; compare the subsequent valid PCM
// against a fresh reference handle.
const vocoder = create(20, [[48, 1]]);
const vocoderReference = create(20, [[48, 1]]);
assert.equal(wasm.webrc_dsp_fx_process_stereo(vocoder,
  mainLeft.address, mainRight.address, outputLeft.address, outputRight.address, frames), -2);
assert.equal(runContext(vocoder, input), -2);
assert.equal(runContext(vocoder, { ...input, carrierLeft: carrierLeft.address,
  carrierRight: carrierRight.address, carrierFrames: frames - 1, carrierChannels: 2 }), -2);
assert.equal(runContext(vocoder, { ...input, carrierLeft: carrierLeft.address,
  carrierRight: carrierRight.address, carrierFrames: frames, carrierChannels: 1 }), -2);
assert.equal(runContext(vocoder, { ...input, carrierLeft: memory.buffer.byteLength,
  carrierRight: carrierRight.address, carrierFrames: frames, carrierChannels: 2 }), -2);
const validCarrier = {
  ...input,
  carrierLeft: carrierLeft.address,
  carrierRight: carrierRight.address,
  carrierFrames: frames,
  carrierChannels: 2,
};
assert.equal(runContext(vocoder, validCarrier), 0);
const vocoderLeft = Float32Array.from(outputLeft.samples);
const vocoderRight = Float32Array.from(outputRight.samples);
assert.ok(vocoderLeft.some(value => Math.abs(value) > 1e-7));
assert.ok(vocoderRight.some(value => Math.abs(value) > 1e-7));
assert.notDeepEqual(vocoderLeft, vocoderRight, 'VOCODER must retain separate carrier channels');
outputLeft.samples.fill(0);
outputRight.samples.fill(0);
assert.equal(runContext(vocoderReference, validCarrier), 0);
assert.deepEqual(outputLeft.samples, vocoderLeft);
assert.deepEqual(outputRight.samples, vocoderRight);

// OSC VOC(M)21 accepts timed MIDI. A note at sample 17 must leave the earlier
// output identical to a no-MIDI render and change audio only from that sample.
const osc = create(21, [[48, 1]]);
const oscNoMidi = create(21, [[48, 1]]);
const midiOn = makeEventBuffer([{ frameOffset: 17, type: 0, channel: 0, note: 64, velocity: 110 }]);
outputLeft.samples.fill(0);
outputRight.samples.fill(0);
assert.equal(runContext(osc, { ...input, midi: midiOn, midiCount: 1 }), 0);
const oscOutputLeft = Float32Array.from(outputLeft.samples);
const oscOutputRight = Float32Array.from(outputRight.samples);
outputLeft.samples.fill(0);
outputRight.samples.fill(0);
assert.equal(runContext(oscNoMidi, input), 0);
const noMidiOutputLeft = Float32Array.from(outputLeft.samples);
const noMidiOutputRight = Float32Array.from(outputRight.samples);
assert.deepEqual(oscOutputLeft.slice(0, 17), noMidiOutputLeft.slice(0, 17),
  'MIDI note-on changed left PCM before frameOffset 17');
assert.deepEqual(oscOutputRight.slice(0, 17), noMidiOutputRight.slice(0, 17),
  'MIDI note-on changed right PCM before frameOffset 17');
assert.ok(oscOutputLeft.slice(17).some((value, index) => value !== noMidiOutputLeft[index + 17]),
  'MIDI note-on caused no left-channel change at/after frameOffset 17');
assert.ok(oscOutputRight.slice(17).some((value, index) => value !== noMidiOutputRight[index + 17]),
  'MIDI note-on caused no right-channel change at/after frameOffset 17');

// Equal-offset parameters are dispatched before MIDI. Setting Square at the
// note's frame must match a handle prepared with Square before the same note.
const sameOffset = create(21, [[48, 1]]);
const preselectedWaveform = create(21, [[48, 1], [60, 3]]); // Waveform=Square.
const waveformEvent = makeParameterBuffers([{ frameOffset: 17, id: 60, value: 3 }]);
outputLeft.samples.fill(0);
outputRight.samples.fill(0);
assert.equal(runContext(sameOffset, { ...input,
  parameterOffsets: waveformEvent.offsets.address,
  parameterIds: waveformEvent.ids.address,
  parameterValues: waveformEvent.values.address,
  parameterCount: 1, midi: midiOn, midiCount: 1 }), 0);
const sameOffsetLeft = Float32Array.from(outputLeft.samples);
const sameOffsetRight = Float32Array.from(outputRight.samples);
outputLeft.samples.fill(0);
outputRight.samples.fill(0);
assert.equal(runContext(preselectedWaveform, { ...input, midi: midiOn, midiCount: 1 }), 0);
assert.deepEqual(outputLeft.samples, sameOffsetLeft,
  'same-offset parameter must apply before MIDI note-on');
assert.deepEqual(outputRight.samples, sameOffsetRight,
  'same-offset parameter order must preserve right-channel PCM');

const badType = makeEventBuffer([{ frameOffset: 9, type: 3, channel: 0, note: 64, velocity: 110 }]);
const badOffset = makeEventBuffer([{ frameOffset: frames, type: 0, channel: 0, note: 64, velocity: 110 }]);
const badChannel = makeEventBuffer([{ frameOffset: 9, type: 0, channel: 1, note: 64, velocity: 110 }]);
const unorderedMidi = makeEventBuffer([
  { frameOffset: 20, type: 1, channel: 0, note: 64, velocity: 0 },
  { frameOffset: 19, type: 1, channel: 0, note: 64, velocity: 0 },
]);
const transactionalProbe = create(21, [[48, 1]]);
const transactionalReference = create(21, [[48, 1]]);
expectRejectedWithoutOutput(transactionalProbe, { midi: badType, midiCount: 1 }, 'bad MIDI type');
expectRejectedWithoutOutput(transactionalProbe, { midi: badOffset, midiCount: 1 }, 'bad MIDI offset');
expectRejectedWithoutOutput(transactionalProbe, { midi: badChannel, midiCount: 1 }, 'bad MIDI channel');
expectRejectedWithoutOutput(transactionalProbe, { midi: unorderedMidi, midiCount: 2 }, 'unordered MIDI stream');
expectRejectedWithoutOutput(transactionalProbe, { midi: { address: midiOn.address + 1 }, midiCount: 1 },
  'unaligned 8-byte MIDI event span');
expectRejectedWithoutOutput(transactionalProbe, { carrierLeft: carrierLeft.address,
  carrierRight: carrierRight.address, carrierFrames: frames, carrierChannels: 2 },
  'non-vocoder carrier sidecar');

const unorderedParameters = makeParameterBuffers([
  { frameOffset: 64, id: 91, value: -2 },
  { frameOffset: 63, id: 91, value: -2 },
]);
expectRejectedWithoutOutput(transactionalProbe, {
  parameterOffsets: unorderedParameters.offsets.address,
  parameterIds: unorderedParameters.ids.address,
  parameterValues: unorderedParameters.values.address,
  parameterCount: 2,
}, 'unordered parameter stream');
expectRejectedWithoutOutput(transactionalProbe, {
  parameterOffsets: unorderedParameters.offsets.address + 1,
  parameterIds: unorderedParameters.ids.address,
  parameterValues: unorderedParameters.values.address,
  parameterCount: 2,
}, 'unaligned parameter offset span');

// Exactly 64 merged events are accepted; a 65th entry must fail before PCM is
// written or DSP state advances.
const sixtyFourProbe = create(21);
const sixtyFourParams = makeParameterBuffers(Array.from({ length: 32 }, (_, index) => ({
  frameOffset: index * 2, id: 91, value: -2,
})));
const thirtyTwoMidiOff = makeEventBuffer(Array.from({ length: 32 }, (_, index) => ({
  frameOffset: index * 2, type: 1, channel: 0, note: 60 + (index % 12), velocity: 0,
})));
outputLeft.samples.fill(0);
outputRight.samples.fill(0);
assert.equal(runContext(sixtyFourProbe, { ...input,
  parameterOffsets: sixtyFourParams.offsets.address,
  parameterIds: sixtyFourParams.ids.address,
  parameterValues: sixtyFourParams.values.address,
  parameterCount: 32, midi: thirtyTwoMidiOff, midiCount: 32 }), 0,
  'exactly 64 merged events must be accepted');

const overflowProbe = create(21);
const overflowReference = create(21);
const manyParameters = makeParameterBuffers(Array.from({ length: 33 }, (_, index) => ({
  frameOffset: index * 2, id: 91, value: -2,
})));
expectRejectedWithoutOutput(overflowProbe, {
  parameterOffsets: manyParameters.offsets.address,
  parameterIds: manyParameters.ids.address,
  parameterValues: manyParameters.values.address,
  parameterCount: 33, midi: thirtyTwoMidiOff, midiCount: 32,
}, '65 merged events');
outputLeft.samples.fill(0);
outputRight.samples.fill(0);
assert.equal(runContext(overflowProbe, { ...input, midi: midiOn, midiCount: 1 }), 0);
const afterRejectedLeft = Float32Array.from(outputLeft.samples);
const afterRejectedRight = Float32Array.from(outputRight.samples);
outputLeft.samples.fill(0);
outputRight.samples.fill(0);
assert.equal(runContext(overflowReference, { ...input, midi: midiOn, midiCount: 1 }), 0);
assert.deepEqual(outputLeft.samples, afterRejectedLeft);
assert.deepEqual(outputRight.samples, afterRejectedRight);

// Unrelated processors reject a MIDI sidecar while ordinary context calls
// remain usable. This also protects the base registry path from accidental
// silent dropping of unknown context fields.
const filter = create(1);
const filterReference = create(1);
assert.equal(runContext(filter, { ...input, midi: midiOn, midiCount: 1 }), -2);
outputLeft.samples.fill(0);
outputRight.samples.fill(0);
assert.equal(runContext(filter, input), 0);
const filterAfterReject = Float32Array.from(outputLeft.samples);
outputLeft.samples.fill(0);
assert.equal(runContext(filterReference, input), 0);
assert.deepEqual(outputLeft.samples, filterAfterReject);

for (const handle of [vocoder, vocoderReference, osc, oscNoMidi, sameOffset,
  preselectedWaveform, transactionalProbe, transactionalReference, sixtyFourProbe,
  overflowProbe, overflowReference, filter, filterReference]) {
  assert.equal(wasm.webrc_dsp_fx_destroy(handle), 0);
}
for (const token of [...tokens]) assert.equal(wasm.webrc_dsp_free_transfer_token(token), 0);
console.log(JSON.stringify({
  result: 'PASS',
  scope: 'typed FX C ABI context validation and musical PCM smoke',
  wasmSha256: sha256(moduleBytes),
  assertions: ['vocoder-required-stereo-carrier', 'carrier-frame/channel/span-validation',
    'carrier-output-stereo-separation', 'sample-offset-17-pre-and-post-pcm',
    'same-offset-parameter-before-midi-order', 'midi-value/offset/channel/alignment/order-validation',
    'parameter-offset/alignment/order-validation', 'exact-64-event-boundary',
    '65-event-rejection-sentinel-and-state-transactionality',
    'nonmusical-sidecar-rejection', 'context-api-version'],
}, null, 2));
