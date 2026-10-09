<template>
  <section class="performance-dashboard" aria-label="Instrument grade audio performance">
    <header class="dashboard-heading">
      <div>
        <div class="eyebrow">AUDIO PERFORMANCE</div>
        <h2>Instrument-grade acceptance</h2>
      </div>
      <label class="import-button">
        IMPORT REPORT
        <input type="file" accept="application/json,.json" aria-label="Import instrument grade JSON report" @change="importReport" />
      </label>
    </header>

    <div class="acceptance-banner" :class="`status-${acceptance.status.toLowerCase().replace(/_/g, '-')}`" role="status" aria-live="polite">
      <strong>{{ acceptance.status }}</strong>
      <span>{{ acceptanceSummary }}</span>
    </div>

    <p v-if="importError" class="import-error" role="alert">{{ importError }}</p>

    <section class="panel-section" aria-labelledby="evidence-title">
      <div class="section-heading">
        <h3 id="evidence-title">Measured report</h3>
        <span v-if="report" class="report-meta">{{ report.reportId }} · {{ formatRate(report.hardware.hardwareSampleRateHz) }} / {{ report.hardware.processingSampleRateHz ?? 'UNKNOWN' }} Hz graph / {{ report.hardware.renderQuantumFrames ?? 'UNKNOWN' }} fr quantum</span>
        <span v-else class="report-meta">No imported evidence</span>
      </div>
      <details v-if="report" class="report-assertion-details">
        <summary>Measurement provenance</summary>
        <p class="report-assertions">{{ Object.entries(report.run.assertionVersions).map(([name, version]) => `${name}=${version}`).join(' · ') }}</p>
      </details>

      <div class="metric-list">
        <MetricDistributionRow label="Hardware RTL" :metric="report?.metrics.hardwareRtl ?? emptyMetrics.hardwareRtl" />
        <MetricDistributionRow label="Input" :metric="report?.metrics.input ?? emptyMetrics.input" />
        <MetricDistributionRow label="Output" :metric="report?.metrics.output ?? emptyMetrics.output" />
        <MetricScalarRow label="Jitter (RTL P95 − P50)" :metric="report?.metrics.jitter ?? emptyMetrics.jitter" />
        <MetricDistributionRow label="Trigger" :metric="report?.metrics.trigger ?? emptyMetrics.trigger" />
        <MetricDistributionRow v-for="action in triggerActions" :key="action" :label="`${action} trigger`" :metric="report?.metrics.triggerByAction[action] ?? emptyMetrics.triggerByAction[action]" />
        <MetricDistributionRow label="Overdub alignment" :metric="report?.metrics.overdubAlignment ?? emptyMetrics.overdubAlignment" />
        <MetricScalarRow label="Render quantum" :metric="report?.metrics.renderQuantum ?? emptyMetrics.renderQuantum" />
        <MetricDistributionRow label="Callback P50/P95/P99/Max" :metric="report?.metrics.callback ?? emptyMetrics.callback" />
        <MetricScalarRow label="XRUN" :metric="report?.metrics.xrun ?? emptyMetrics.xrun" />
        <MetricScalarRow label="Loop drift" :metric="report?.metrics.loopDrift ?? emptyMetrics.loopDrift" :suffix="driftStability" />
      </div>

      <div class="fx-heading">Per-effect latency</div>
      <div v-if="report?.metrics.fxLatency.length" class="fx-list">
        <div v-for="fx in report.metrics.fxLatency" :key="fx.effectId" class="fx-row">
          <strong>{{ fx.effectName }}</strong>
          <span>First {{ scalarDisplay(fx.firstArrival) }} · Peak {{ scalarDisplay(fx.peak) }} · Tail {{ scalarDisplay(fx.tail) }}</span>
          <small>{{ evidenceSummary(fx.firstArrival) }}</small>
        </div>
      </div>
      <div v-else class="empty-note">UNKNOWN · no per-effect measurements in this report</div>

      <p class="gate-note">Strict pass gate: project-chain physical RTL P50 &lt; 10 ms (target ≤ 10 ms), P95 ≤ 12 ms; same-trace jitter P95 − P50 &lt; 1 ms; REC/PLAY/STOP/FX analog trigger MAX &lt; 5 ms; overdub alignment MAXABS ≤ 1 ms; 30 min with 0 XRUNs plus continuous physical marker; loop drift MAXABS &lt; 1 ms and non-accumulating. Browser estimates and software benchmarks cannot satisfy physical checks.</p>
    </section>

    <section class="panel-section runtime-section" aria-labelledby="runtime-title">
      <div class="section-heading">
        <h3 id="runtime-title">Live software diagnostics</h3>
        <span class="source-badge">SOFTWARE DIAGNOSTIC</span>
      </div>
      <template v-if="runtime">
        <div class="runtime-grid">
          <div><span>Backend</span><strong>{{ runtime.backendMode }}</strong></div>
          <div><span>Graph rate</span><strong>{{ runtime.sampleRate }} Hz</strong></div>
          <div><span>Quantum</span><strong>{{ runtime.quantumFrames }} fr</strong></div>
          <div><span>Rendered frame</span><strong>{{ runtime.renderedFrame }}</strong></div>
          <div><span>Underruns</span><strong>{{ runtime.underruns }}</strong></div>
          <div><span>Command queue</span><strong>{{ runtime.commandQueueDepth }}</strong></div>
          <div><span>Monitor</span><strong>{{ runtime.outputMonitorEnabled ? 'ON' : 'OFF' }}</strong></div>
          <div><span>Last command ACK</span><strong>{{ runtime.lastAckSequence }}</strong></div>
          <div><span>Command overruns</span><strong>{{ runtime.commandOverruns }}</strong></div>
          <div><span>Process deadline misses</span><strong>{{ runtime.processDeadlineMisses ?? 'UNKNOWN' }}</strong></div>
          <div><span>Input dropout blocks</span><strong>{{ runtime.inputDropoutBlocks }}</strong></div>
          <div><span>Track capacity overruns</span><strong>{{ runtime.trackCapacityOverruns }}</strong></div>
        </div>
        <div class="track-counters">
          <span>Loop frames: {{ runtime.loopFrames.join(' / ') }}</span>
          <span>Recording frames: {{ runtime.recordingFrames.join(' / ') }}</span>
          <span>Track positions: {{ runtime.trackPositions.join(' / ') }}</span>
          <span>Track states: {{ runtime.trackStates.join(' / ') }}</span>
        </div>
      </template>
      <div v-else class="empty-note">UNKNOWN · realtime worklet counters are unavailable in the current backend</div>
      <div v-if="latencyInfo" class="estimate-note">
        Browser I/O hint: base {{ formatLatency(latencyInfo.baseLatencyMs) }}, output {{ formatLatency(latencyInfo.outputLatencyMs) }}, monitor estimate {{ formatLatency(latencyInfo.estimatedMonitoringLatencyMs) }}. Estimated only; not Hardware RTL.
      </div>
    </section>

    <section class="panel-section profile96-section" aria-labelledby="callback96k-title">
      <div class="section-heading">
        <h3 id="callback96k-title">96 kHz / 128-frame profile</h3>
        <span :class="`profile-status profile-${acceptance.callback96kStatus.toLowerCase().replace(/_/g, '-')}`">{{ acceptance.callback96kStatus }}</span>
      </div>
      <p>Separate fail-closed certification on the same I/O devices: 96 kHz / 128 frames, callback P99 &lt; 0.8 ms, and zero XRUNs for 30 minutes with physical sample-marker coverage.</p>
      <ul class="callback96-checks">
        <li v-for="check in acceptance.callback96kChecks" :key="check.id" :class="`check-${check.status}`">{{ check.status.toUpperCase() }} — {{ check.detail }}</li>
      </ul>
    </section>

    <details v-if="acceptance.checks.length" class="gate-details">
      <summary>Gate evidence and missing requirements</summary>
      <ul>
        <li v-for="check in acceptance.checks" :key="check.id" :class="`check-${check.status}`">
          <span>{{ check.status.toUpperCase() }}</span> {{ check.label }} — {{ check.detail }}
        </li>
      </ul>
      <p v-if="acceptance.missing.length" class="missing-note">Missing: {{ acceptance.missing.join('; ') }}</p>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onMounted, onUnmounted, ref, type PropType } from 'vue';
import { AudioEngine, type LatencyInfo } from '../audio/AudioEngine';
import {
  createEmptyInstrumentGradeMetrics,
  evaluateInstrumentGrade,
  validateInstrumentGradeReport,
  type AcceptanceResult,
  type BrowserRealtimeSnapshot,
  type DistributionMeasurement,
  type InstrumentGradeReport,
  type LoopDriftMeasurement,
  type ScalarMeasurement,
  type MeasurementEvidence,
} from '../audio/instrumentGradeMetrics';

const emptyMetrics = createEmptyInstrumentGradeMetrics();
const triggerActions = ['REC', 'PLAY', 'STOP', 'FX'] as const;
const report = ref<InstrumentGradeReport | null>(null);
const importError = ref('');
const runtime = ref<BrowserRealtimeSnapshot | null>(null);
const latencyInfo = ref<LatencyInfo | null>(null);
let runtimeTimer: ReturnType<typeof setInterval> | null = null;

const noReportAcceptance: AcceptanceResult = {
  status: 'NOT_VERIFIED',
  checks: [],
  missing: ['import a versioned physical measurement report'],
  callback96kStatus: 'NOT_VERIFIED',
  callback96kChecks: [{ id: 'callback96k-profile', label: '96 kHz callback profile', status: 'unknown', detail: 'No report imported' }],
};

const acceptance = computed(() => report.value ? evaluateInstrumentGrade(report.value) : noReportAcceptance);
const acceptanceSummary = computed(() => {
  if (!report.value) return 'Import a benchmark report with physical-path evidence.';
  if (acceptance.value.status === 'INSTRUMENT_GRADE_PASS') return `Strict 48 kHz / 128-frame physical and stability gates passed. Separate 96 kHz profile: ${acceptance.value.callback96kStatus}.`;
  if (acceptance.value.status === 'FAIL') return 'One or more measured values exceed the acceptance gate.';
  return 'Physical evidence is incomplete; this report is not verified.';
});
const driftStability = computed(() => {
  const stability = report.value?.metrics.loopDrift.nonAccumulating;
  return stability === null || stability === undefined ? ' · stability UNKNOWN' : ` · ${stability ? 'non-accumulating' : 'accumulating'}`;
});

function formatMetricValue(value: number | null, unit: string) {
  return value === null ? 'UNKNOWN' : `${formatNumber(value)} ${unit}`;
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function formatLatency(value: number | null) {
  return value === null ? 'UNKNOWN' : `${value.toFixed(2)} ms`;
}

function formatRate(value: number | null) {
  return value === null ? 'UNKNOWN interface rate' : `${value} Hz interface rate`;
}

function evidenceSummary(metric: MeasurementEvidence) {
  const metadata = [metric.provenance, `n=${metric.sampleCount}`];
  if (metric.sampleRateHz !== null) metadata.push(`${metric.sampleRateHz} Hz`);
  if (metric.device !== null) metadata.push(metric.device);
  if (metric.measuredAt !== null) metadata.push(new Date(metric.measuredAt).toLocaleString());
  if (metric.evidenceRef !== null) metadata.push(`evidence=${metric.evidenceRef}`);
  return metadata.join(' · ');
}

function scalarDisplay(metric: ScalarMeasurement) {
  return formatMetricValue(metric.value, metric.unit);
}

const MetricDistributionRow = defineComponent({
  name: 'MetricDistributionRow',
  props: {
    label: { type: String, required: true },
    metric: { type: Object as PropType<DistributionMeasurement>, required: true },
  },
  setup(props) {
    return () => h('div', { class: 'metric-row' }, [
      h('div', { class: 'metric-name' }, props.label),
      h('div', { class: 'metric-values' }, [
        h('span', `P50 ${formatMetricValue(props.metric.p50, props.metric.unit)}`),
        h('span', `P95 ${formatMetricValue(props.metric.p95, props.metric.unit)}`),
        h('span', `P99 ${formatMetricValue(props.metric.p99, props.metric.unit)}`),
        h('span', `MAX ${formatMetricValue(props.metric.max, props.metric.unit)}`),
        h('span', `MAXABS ${formatMetricValue(props.metric.maxAbs, props.metric.unit)}`),
      ]),
      h('div', { class: 'metric-provenance' }, evidenceSummary(props.metric)),
    ]);
  },
});

const MetricScalarRow = defineComponent({
  name: 'MetricScalarRow',
  props: {
    label: { type: String, required: true },
    metric: { type: Object as PropType<ScalarMeasurement | LoopDriftMeasurement>, required: true },
    suffix: { type: String, default: '' },
  },
  setup(props) {
    return () => h('div', { class: 'metric-row scalar-row' }, [
      h('div', { class: 'metric-name' }, props.label),
      h('div', { class: 'metric-values' }, [h('span', `${formatMetricValue('value' in props.metric ? props.metric.value : props.metric.maxAbs, props.metric.unit)}${props.suffix}`)]),
      h('div', { class: 'metric-provenance' }, evidenceSummary(props.metric)),
    ]);
  },
});

async function importReport(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importError.value = '';
  report.value = null;
  try {
    const payload: unknown = JSON.parse(await file.text());
    const validation = validateInstrumentGradeReport(payload);
    if (!validation.valid || !validation.report) {
      importError.value = `Report rejected: ${validation.issues.slice(0, 8).join('; ')}`;
      return;
    }
    report.value = validation.report;
  } catch (error) {
    importError.value = `Could not read report JSON: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    input.value = '';
  }
}

function readLiveDiagnostics() {
  const engine = AudioEngine.getInstance();
  try {
    latencyInfo.value = engine.getLatencyInfo();
    if (engine.getMode() !== 'browser') {
      runtime.value = null;
      return;
    }
    runtime.value = engine.getRealtimeMetrics() ?? null;
  } catch {
    runtime.value = null;
  }
}

onMounted(() => {
  readLiveDiagnostics();
  runtimeTimer = setInterval(readLiveDiagnostics, 1000);
});

onUnmounted(() => {
  if (runtimeTimer) clearInterval(runtimeTimer);
});
</script>

<style scoped>
.performance-dashboard {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  box-sizing: border-box;
  padding: 10px;
  border: 1px solid #343a40;
  border-radius: 8px;
  background: #171b20;
  min-width: 0;
  color: #eceff2;
  font-family: var(--font-hardware, sans-serif);
}

.dashboard-heading,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.eyebrow,
.dashboard-heading h2,
.section-heading h3,
.fx-heading {
  margin: 0;
  letter-spacing: 1px;
  text-transform: uppercase;
}

.eyebrow,
.report-meta,
.source-badge {
  color: #9097a0;
  font-size: 9px;
}

.dashboard-heading h2 {
  margin-top: 3px;
  font-size: 12px;
}

.import-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 0 9px;
  border: 1px solid #465563;
  border-radius: 5px;
  color: #c4d7e5;
  font-size: 9px;
  cursor: pointer;
  white-space: nowrap;
}

.import-button input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.acceptance-banner {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 10px;
  border: 1px solid #464646;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.025);
}

.acceptance-banner strong {
  font-size: 11px;
  letter-spacing: 1px;
}

.acceptance-banner span,
.import-error,
.gate-note,
.empty-note,
.estimate-note,
.missing-note {
  color: #9ca3aa;
  font-size: 10px;
  line-height: 1.4;
}

.status-instrument-grade-pass {
  border-color: rgba(91, 210, 138, 0.55);
  color: #7de5a3;
}

.status-fail {
  border-color: rgba(255, 97, 97, 0.6);
  color: #ff8585;
}

.status-not-verified {
  border-color: rgba(244, 184, 76, 0.45);
  color: #f2c36e;
}

.import-error {
  margin: 0;
  color: #ff9292;
  overflow-wrap: anywhere;
}

.panel-section {
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 7px;
  background: rgba(0, 0, 0, 0.16);
}

.section-heading {
  align-items: flex-start;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.section-heading h3 {
  font-size: 10px;
}

.report-meta {
  text-align: right;
  overflow-wrap: anywhere;
}

.report-assertion-details {
  margin: -2px 0 8px;
  color: #858d94;
  font-size: 8px;
}

.report-assertion-details summary {
  cursor: pointer;
}

.report-assertions {
  margin: 5px 0 0;
  overflow-wrap: anywhere;
}

.metric-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

:deep(.metric-row) {
  padding: 6px 7px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.025);
  min-width: 0;
}

:deep(.metric-name) {
  margin-bottom: 3px;
  color: #c6cbd0;
  font-size: 10px;
}

:deep(.metric-values) {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 9px;
  color: #f1f1f1;
  font-family: var(--font-mono, monospace);
  font-size: 9px;
}

:deep(.metric-provenance) {
  margin-top: 3px;
  color: #8c9299;
  font-size: 8px;
  overflow-wrap: anywhere;
}

.fx-heading {
  margin: 10px 0 5px;
  font-size: 9px;
  color: #c6cbd0;
}

.fx-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.fx-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 7px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.025);
  font-size: 9px;
}

.fx-row span,
.fx-row small {
  color: #aeb4ba;
}

.fx-row small {
  color: #858d94;
  overflow-wrap: anywhere;
}

.gate-note {
  margin: 9px 0 0;
}

.runtime-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.runtime-grid div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.025);
  min-width: 0;
}

.runtime-grid span,
.track-counters,
.estimate-note {
  color: #8f969d;
  font-size: 8px;
}

.runtime-grid strong {
  color: #dde4e9;
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  overflow-wrap: anywhere;
}

.track-counters {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 7px;
  overflow-wrap: anywhere;
}

.estimate-note {
  margin-top: 8px;
  line-height: 1.4;
}

.gate-details {
  color: #adb4ba;
  font-size: 9px;
}

.gate-details summary {
  cursor: pointer;
}

.gate-details ul {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-left: 15px;
}

.check-pass span { color: #7de5a3; }
.check-fail span { color: #ff8585; }
.check-unknown span { color: #f2c36e; }
.profile-status { font-size: 8px; }
.profile-instrument-grade-pass { color: #7de5a3; }
.profile-fail { color: #ff8585; }
.profile-not-verified { color: #f2c36e; }
.profile96-section p,
.callback96-checks { color: #9ca3aa; font-size: 9px; line-height: 1.4; }
.profile96-section p { margin: 0; }
.callback96-checks { display: flex; flex-direction: column; gap: 4px; padding-left: 14px; margin: 6px 0 0; }

.missing-note {
  overflow-wrap: anywhere;
}
</style>
