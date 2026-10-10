import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const [modulePath, reportPath] = process.argv.slice(2);
assert.ok(modulePath && reportPath, 'usage: node root-hrm-factory-memory.mjs module.wasm report.json');
const bytes = await fs.readFile(modulePath);
let wasiCalls = 0;
const { instance } = await WebAssembly.instantiate(bytes, {
  wasi_snapshot_preview1: Object.fromEntries(['fd_close', 'fd_write', 'fd_seek'].map(
    name => [name, () => { wasiCalls++; return 8; }],
  )),
});
const w = instance.exports;
w._initialize();
const initialMemory = w.memory.buffer;
const initialLedger = w.webrc_dsp_managed_memory_bytes();
const managedCapacityBytes = w.webrc_dsp_managed_memory_capacity_bytes();
assert.equal(managedCapacityBytes, 48 * 1024 * 1024, 'The 48 MiB budget must remain unchanged');
const buffers = [];
const allocate = count => {
  const token = w.webrc_dsp_alloc_f32_token(count);
  assert.ok(token);
  const address = w.webrc_dsp_transfer_address(token);
  buffers.push(token);
  return address;
};
const ids = allocate(2), values = allocate(2), info = allocate(16);
new Uint32Array(w.memory.buffer, ids, 2).set([125, 48]);
const bufferLedger = w.webrc_dsp_managed_memory_bytes();
const cases = [];
for (const profile of [1, 2]) {
  new Float32Array(w.memory.buffer, values, 2).set([profile, 1]);
  assert.equal(w.webrc_dsp_fx_memory_info_for_parameters(
    18, 48000, 128, 2, ids, values, 2, info,
  ), 0);
  const view = new DataView(w.memory.buffer, info, 64);
  const fields = Object.fromEntries(['objectBytes', 'persistentPreparedBytes', 'prepareScratchBytes', 'peakBytes'].map(
    (name, index) => [name, Number(view.getBigUint64(index * 8, true))],
  ));
  assert.equal(view.getUint32(32, true), 1);
  const handle = w.webrc_dsp_fx_create_v2(18, 48000, 128, 2, ids, values, 2);
  const status = w.webrc_dsp_fx_last_create_status();
  const reservedLedgerDelta = w.webrc_dsp_managed_memory_bytes() - bufferLedger;
  if (handle) {
    assert.equal(status, 0);
    assert.equal(w.webrc_dsp_fx_destroy(handle), 0);
  } else {
    assert.equal(status, -7, 'Unexpected failure other than the diagnosed memory-budget rejection');
  }
  assert.equal(w.webrc_dsp_managed_memory_bytes(), bufferLedger);
  cases.push({ profile, ...fields, created: Boolean(handle), createStatus: status, reservedLedgerDelta });
}
for (const token of buffers) assert.equal(w.webrc_dsp_free_transfer_token(token), 0);
assert.equal(w.webrc_dsp_managed_memory_bytes(), initialLedger);
assert.equal(w.memory.buffer, initialMemory);
assert.equal(wasiCalls, 0);
const report = {
  scope: 'Actual configured WASM factory admission and conservative accounting; ledger values are not measured allocator payload or end-to-end latency',
  moduleSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  sampleRateHz: 48000, blockFrames: 128, channels: 2,
  managedCapacityBytes, fixedWasmMemoryBytes: initialMemory.byteLength,
  cases, bothProfilesAdmitted: cases.every(entry => entry.created),
  ledgerReturnedToBaseline: true, memoryGrowth: false, wasiCalls,
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
