import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const sourcePath = new URL('../worklets/instrument-register-processor.js', import.meta.url);
const source = await readFile(fileURLToPath(sourcePath), 'utf8');
const posted = [];
let registeredProcessor = null;
const workletScope = vm.createContext({
  registerProcessor(name, constructor) {
    assert.equal(name, 'rc505-rhythm-processor');
    registeredProcessor = constructor;
  },
  sampleRate: 48_000,
  currentFrame: 0,
  performance: {
    // A constant clock deliberately makes CPU timing ineligible, so this test
    // exercises exception reporting without depending on Atomics.max support.
    now: () => 0,
  },
});

vm.runInContext(source, workletScope, { filename: 'instrument-register-processor.js' });

class ThrowingRhythmProcessor {
  constructor() {
    this.port = { postMessage: (message) => posted.push(message) };
  }

  process() {
    const error = new RangeError('synthetic rhythm callback failure');
    throw error;
  }
}

workletScope.registerProcessor('rc505-rhythm-processor', ThrowingRhythmProcessor);
assert.equal(typeof registeredProcessor, 'function', 'hook must register the wrapped processor');

const layout = {
  metaLength: 19,
  metaByteOffset: 0,
  blockBins: 2_049,
  blockByteOffset: 19 * Int32Array.BYTES_PER_ELEMENT,
  blockLength: 2_049,
  processDurationByteOffset: (19 * 4) + (2_049 * 4),
  durationLength: 65_536,
  wrapperDurationByteOffset: (19 * 4) + (2_049 * 4) + (65_536 * 4),
  startGapByteOffset: (19 * 4) + (2_049 * 4) + (2 * 65_536 * 4),
  durationBins: 65_536,
  maxBlockFrames: 2_048,
  maxDurationUs: 65_535,
  measurementActiveIndex: 18,
};
const byteLength = layout.startGapByteOffset + (layout.durationLength * Int32Array.BYTES_PER_ELEMENT);
const buffer = vm.runInContext(`new SharedArrayBuffer(${byteLength})`, workletScope);
const sharedMeta = new Int32Array(buffer, layout.metaByteOffset, layout.metaLength);
Atomics.store(sharedMeta, layout.measurementActiveIndex, 1);

const processor = new registeredProcessor({
  processorOptions: {
    __rc505BenchInstrumentation: {
      buffer,
      slot: 0,
      sampleRate: 48_000,
      layout,
    },
  },
});
assert.throws(
  () => processor.process([], [[new Float32Array(128)]], {}),
  /synthetic rhythm callback failure/,
  'instrumentation must preserve the production callback throw',
);

const detail = posted.find((message) => message.type === 'rc505-bench-callback-exception');
assert.ok(detail, 'the hook must post one bounded callback exception detail');
assert.equal(detail.processorName, 'rc505-rhythm-processor');
assert.equal(detail.slot, 0);
assert.equal(detail.name, 'RangeError');
assert.equal(detail.message, 'synthetic rhythm callback failure');
assert.match(detail.stack, /synthetic rhythm callback failure/);
assert.equal(Atomics.load(sharedMeta, 12), 1, 'the callback error counter must still increment');
console.log('instrument-register-processor exception detail check passed');
