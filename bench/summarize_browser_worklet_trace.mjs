#!/usr/bin/env node
/** Summarize Chrome tracing output from profile_browser_audio_worklet_graph.mjs. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) throw new Error('Usage: node bench/summarize_browser_worklet_trace.mjs TRACE.json SUMMARY.json');
const bytes = await readFile(resolve(inputPath));
const inputSha256 = createHash('sha256').update(bytes).digest('hex');
const trace = JSON.parse(bytes.toString('utf8'));
const events = Array.isArray(trace.traceEvents) ? trace.traceEvents : [];
const threadNames = new Map();
for (const event of events) {
  if (event.ph === 'M' && event.name === 'thread_name') {
    threadNames.set(`${event.pid}:${event.tid}`, event.args?.name ?? 'unnamed');
  }
}
const processEvents = events.filter((event) => event.name === 'AudioWorkletProcessor::Process');
function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}
const processStats = {
  count: processEvents.length,
  threadName: threadNames.get(`${processEvents[0]?.pid}:${processEvents[0]?.tid}`) ?? null,
  wallDurationUs: processEvents.map((event) => event.dur ?? 0),
  threadCpuDurationUs: processEvents.map((event) => event.tdur ?? null).filter(Number.isFinite),
};
for (const key of ['wallDurationUs', 'threadCpuDurationUs']) {
  const values = processStats[key];
  processStats[key] = values.length ? {
    count: values.length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    max: Math.max(...values),
    total: values.reduce((sum, value) => sum + value, 0),
    units: 'microseconds, as emitted by Chrome trace; intrusive diagnostic only',
  } : null;
}

const profileGroups = new Map();
const profileChunks = events.filter((event) => event.name === 'ProfileChunk').sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
for (const event of profileChunks) {
  const key = `${event.pid}:${event.tid}`;
  let group = profileGroups.get(key);
  if (!group) {
    group = { pid: event.pid, tid: event.tid, threadName: threadNames.get(key) ?? 'unnamed', chunks: 0, sampleCount: 0, missingSampleNode: 0, nodes: new Map(), counts: new Map() };
    profileGroups.set(key, group);
  }
  group.chunks += 1;
  const profile = event.args?.data?.cpuProfile;
  if (!profile) continue;
  for (const node of profile.nodes ?? []) group.nodes.set(node.id, node);
  for (const id of profile.samples ?? []) {
    const node = group.nodes.get(id);
    if (!node) { group.missingSampleNode += 1; continue; }
    group.sampleCount += 1;
    const frame = node.callFrame ?? {};
    const keyName = `${frame.functionName ?? ''}\t${frame.url ?? ''}\t${frame.lineNumber ?? ''}`;
    group.counts.set(keyName, (group.counts.get(keyName) ?? 0) + 1);
  }
}
const profiles = [...profileGroups.values()].map((group) => {
  const all = [...group.counts].map(([key, samples]) => {
    const [functionName, url, line] = key.split('\t');
    return { functionName, url, line: line === '' ? null : Number(line), samples };
  }).sort((a, b) => b.samples - a.samples);
  const nonIdle = all.filter((entry) => !['(idle)', '(root)', '(program)'].includes(entry.functionName));
  const workletBundle = nonIdle.filter((entry) => entry.url?.includes('/worklets/fx-processor.js'));
  const wasm = nonIdle.filter((entry) => entry.url?.startsWith('wasm://'));
  const activeDenominator = nonIdle.reduce((sum, entry) => sum + entry.samples, 0);
  const compact = (items) => items.slice(0, 40).map((entry) => ({
    ...entry,
    percentOfNonIdleSamples: activeDenominator > 0 ? Number((100 * entry.samples / activeDenominator).toFixed(3)) : null,
  }));
  return {
    pid: group.pid,
    tid: group.tid,
    threadName: group.threadName,
    chunks: group.chunks,
    samples: group.sampleCount,
    missingSampleNode: group.missingSampleNode,
    idleSamples: all.filter((entry) => entry.functionName === '(idle)').reduce((sum, entry) => sum + entry.samples, 0),
    nonIdleSamples: activeDenominator,
    topNonIdleFrames: compact(nonIdle),
    topFxWorkletFrames: compact(workletBundle),
    topWasmFrames: compact(wasm),
  };
});

const summary = {
  schemaVersion: 1,
  benchmark: 'rc505_chrome_audio_worklet_trace_summary',
  generatedAtUtc: new Date().toISOString(),
  inputPath: resolve(inputPath),
  inputBytes: bytes.length,
  inputSha256,
  browserBinaryVersion: trace.browserBinaryVersion ?? null,
  repoHead: trace.repoHead ?? null,
  graph: trace.graph ?? null,
  pageHarnessError: trace.pageHarnessError ?? null,
  pageProgression: trace.pageResultProgression ?? null,
  pageCallbackCounts: trace.pageResultCallbackCounts ?? null,
  traceStats: {
    eventCount: events.length,
    processEventCount: processEvents.length,
    profileChunkCount: profileChunks.length,
    dataLossOccurred: trace.traceStats?.dataLossOccurred ?? null,
  },
  processEventStats: processStats,
  profiles,
  cautions: [
    'Chrome tracing and CPU sampling are intrusive; this does not substitute for an untraced real-time acceptance run.',
    'V8 profile frames identify function names and source lines, but this trace does not identify the individual AudioWorkletNode instance for shared functions.',
    'Signalsmith WASM function indices are unsymbolized here and are not assigned semantic names.',
    'No physical device, hardware XRUN, or acoustic evidence is produced.',
  ],
};
const target = resolve(outputPath);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`Saved trace summary: ${target}\n`);
process.stdout.write(`Input: ${bytes.length} bytes SHA256=${inputSha256}; process events=${processEvents.length}; profile chunks=${profileChunks.length}\n`);
