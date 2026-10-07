#!/usr/bin/env node
// Convert a saved Node/VM Worklet process benchmark into the strict dashboard
// schema. The imported evidence remains explicitly software-only.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

function getArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const inputArg = getArg('--input');
const outputArg = getArg('--out');
if (!inputArg || !outputArg) {
  process.stderr.write('Usage: node scripts/audio-benchmark-import-worklet.mjs --input <worklet-benchmark raw-results.json> --out <dashboard-report.json>\n');
  process.exit(2);
}

const inputPath = resolve(inputArg);
const outputPath = resolve(outputArg);
const input = JSON.parse(await readFile(inputPath, 'utf8'));
const phase = input.diagnostics?.find((item) => item.name === 'accelerated_vm_playback_phase');
if (!phase || phase.requestedMinutes < 30 || phase.sampleTimelineSeconds < 1800) {
  throw new Error('Input must contain the completed 30-minute accelerated VM phase; shorter runs are not mixed into this report.');
}
if (!phase.processMs || !Number.isFinite(phase.processMs.p50Ms) || !Number.isFinite(phase.processMs.p95Ms)
  || !Number.isFinite(phase.processMs.p99Ms) || !Number.isFinite(phase.processMs.maxMs)
  || !Number.isFinite(phase.processMs.samples)) {
  throw new Error('The phase process() distribution is incomplete.');
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(repoRoot, 'package.json'));
const ts = require('typescript');
const metricsPath = resolve(repoRoot, 'src/audio/instrumentGradeMetrics.ts');
const metricsSource = await readFile(metricsPath, 'utf8');
const compiled = ts.transpileModule(metricsSource, {
  fileName: metricsPath,
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const schemaModule = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const { createEmptyInstrumentGradeMetrics, validateInstrumentGradeReport, evaluateInstrumentGrade } = schemaModule;
if (typeof createEmptyInstrumentGradeMetrics !== 'function' || typeof validateInstrumentGradeReport !== 'function') {
  throw new Error('The project schema source did not export its factory and validator.');
}

const startMs = Date.parse(input.startedAt);
const endMs = Date.parse(input.completedAt);
if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
  throw new Error('Input benchmark timestamps are invalid.');
}
const measuredAt = new Date(endMs).toISOString();
const wallSeconds = Math.max(0, (endMs - startMs) / 1000);
const evidenceRef = formatEvidenceRef(inputPath);
const device = `Node ${process.version} VM; actual Worklet process() source with synthetic buffers`;
const sampleCount = Math.floor(phase.processMs.samples);
const callbackDeadlineMs = Number(input.blockBudgetMs);
const deadlineMisses = Number(phase.finalRuntimeMetrics?.processDeadlineMisses);
const driftFrames = Math.max(0, Number(phase.maxAbsolutePhaseDriftFrames));
const driftMs = driftFrames / Number(input.sampleRate) * 1000;
const finalMetrics = phase.finalRuntimeMetrics;
if (!finalMetrics || !Number.isFinite(deadlineMisses) || !Array.isArray(finalMetrics.trackCapacityFrames)
  || finalMetrics.trackCapacityFrames.length !== 5) {
  throw new Error('The phase final runtime snapshot is incomplete.');
}

const metrics = createEmptyInstrumentGradeMetrics();
metrics.renderQuantum = measuredScalar(Number(input.quantumFrames), 'frames', sampleCount);
metrics.callback = {
  p50: Number(phase.processMs.p50Ms),
  p95: Number(phase.processMs.p95Ms),
  p99: Number(phase.processMs.p99Ms),
  max: Number(phase.processMs.maxMs),
  maxAbs: Number(phase.processMs.maxMs),
  unit: 'ms',
  provenance: 'software-diagnostic',
  sampleCount,
  measuredAt,
  device,
  sampleRateHz: Number(input.sampleRate),
  evidenceRef,
  anchorRef: null,
};
metrics.loopDrift = {
  unit: 'ms',
  maxAbs: driftMs,
  slopeMsPerMinute: 0,
  nonAccumulating: phase.assertionErrors === 0 && driftFrames === 0,
  provenance: 'software-diagnostic',
  sampleCount: Math.floor(Number(phase.phaseAssertions)),
  measuredAt,
  device: `Node VM phase simulation at ${input.sampleRate} Hz; loop frame lengths ${phase.loopFrames.join(', ')}`,
  sampleRateHz: Number(input.sampleRate),
  evidenceRef,
  anchorRef: null,
};
const runtimeSnapshot = {
  sampleRate: finalMetrics.sampleRate,
  quantumFrames: finalMetrics.quantumFrames,
  renderedFrame: finalMetrics.renderedFrame,
  underruns: finalMetrics.underruns,
  commandQueueDepth: finalMetrics.commandQueueDepth,
  loopFrames: finalMetrics.loopFrames,
  recordingFrames: finalMetrics.recordingFrames,
  trackStates: finalMetrics.trackStates,
  trackPositions: finalMetrics.trackPositions,
  outputMonitorEnabled: false,
  backendMode: 'sab-worklet',
  lastAckSequence: 0,
  commandOverruns: finalMetrics.commandOverruns,
  processDeadlineMisses: finalMetrics.processDeadlineMisses,
  deadlineMetricAvailable: finalMetrics.deadlineMetricAvailable,
  inputDropoutBlocks: finalMetrics.inputDropoutBlocks,
  trackCapacityOverruns: finalMetrics.trackCapacityOverruns,
  maxTrackFrames: Math.max(...finalMetrics.trackCapacityFrames),
  trackCapacityFrames: finalMetrics.trackCapacityFrames,
};

const report = {
  schema: 'webrc.instrument-grade-audio',
  schemaVersion: 1,
  reportId: `node-worklet-phase-${endMs}`,
  run: {
    startedAt: new Date(startMs).toISOString(),
    endedAt: measuredAt,
    durationSeconds: wallSeconds,
    gateVersion: 'instrument-grade-gate/1.0.0',
    systemUnderTest: 'webrc505-project-worklet',
    assertionVersions: {
      importer: 'audio-benchmark-import-worklet/1.0.0',
      source: 'public/worklets/looper-processor.js process() via Node VM; synthetic preallocated buffers',
      phase: 'accelerated-30-minute-sample-timeline/1.0.0',
      coverage: `sample timeline ${phase.sampleTimelineSeconds} s; wall time ${wallSeconds.toFixed(3)} s; ${sampleCount} process() samples`,
      loopPhase: `${phase.phaseAssertions} phase assertions across loop lengths ${phase.loopFrames.join(', ')} frames; max error ${driftFrames} frames; low-word wraps ${phase.lowWordWrapCount}`,
      nodeProcessP99Ms: String(phase.processMs.p99Ms),
      nodeProcessMaxMs: String(phase.processMs.maxMs),
      nodeDeadlineBudgetMs: String(callbackDeadlineMs),
      nodeProcessDeadlineMissesSynthetic: String(deadlineMisses),
      xrunInterpretation: 'Node VM processDeadlineMisses are retained as an assertion only, not mapped to the report XRUN metric. Hardware XRUN remains unknown; this is not a browser, driver, device XRUN count, or physical dropout measurement.',
      evidenceRetention: `${evidenceRef} points to a raw trace in system TEMP. The raw file is not copied with this report; missing trace means the diagnostic cannot be independently rechecked and never upgrades an unknown physical gate.`,
    },
  },
  hardware: {
    inputDevice: { id: 'software:none', label: 'No physical input opened (Node VM)' },
    outputDevice: { id: 'software:none', label: 'No physical output opened (Node VM)' },
    hardwareSampleRateHz: null,
    processingSampleRateHz: Number(input.sampleRate),
    renderQuantumFrames: null,
  },
  pathEvidence: {
    physicalLoopbackConfirmed: false,
    loopbackDescription: 'Accelerated Node VM benchmark of the actual project Worklet processor source with synthetic buffers. No Chromium callback, live input, render device, DAC, analog loop, or physical sample marker was used.',
    loopbackEvidenceRef: null,
    independentInputAnchorRef: null,
    independentOutputAnchorRef: null,
    adcToBrowserEvidenceRef: null,
    browserToDspEvidenceRef: null,
    dspToDacEvidenceRef: null,
    dacToAdcEvidenceRef: null,
  },
  metrics,
  software: { runtimeSnapshot, callback96kProfile: null },
};

const validation = validateInstrumentGradeReport(report);
if (!validation.valid) throw new Error(`Generated report failed strict schema validation: ${validation.issues.join('; ')}`);
const acceptance = evaluateInstrumentGrade(report);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
  reportPath: outputPath,
  rawInput: inputPath,
  valid: validation.valid,
  status: acceptance.status,
  callbackP99Ms: metrics.callback.p99,
  callbackMaxMs: metrics.callback.max,
  nodeProcessDeadlineMissesSynthetic: deadlineMisses,
  hardwareXrun: metrics.xrun.value,
  simulatedAudioSeconds: phase.sampleTimelineSeconds,
  wallSeconds,
  loopDriftMaxMs: metrics.loopDrift.maxAbs,
  physicalHardwareRtl: metrics.hardwareRtl.provenance,
}, null, 2)}\n`);

function measuredScalar(value, unit, count) {
  return {
    value,
    unit,
    provenance: 'software-diagnostic',
    sampleCount: count,
    measuredAt,
    device,
    sampleRateHz: Number(input.sampleRate),
    evidenceRef,
    anchorRef: null,
  };
}

function formatEvidenceRef(filePath) {
  const relativePath = relative(resolve(tmpdir()), filePath);
  if (relativePath && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)) {
    return `TEMP/${relativePath.split(sep).join('/')}`;
  }
  return `file:${basename(filePath)}`;
}
