/**
 * Versioned report format and conservative acceptance gate for instrument-grade
 * audio measurements. A numeric value is never inferred from browser latency
 * hints or from a different provenance class.
 */

export const INSTRUMENT_GRADE_SCHEMA = 'webrc.instrument-grade-audio' as const;
export const INSTRUMENT_GRADE_SCHEMA_VERSION = 1 as const;
export const INSTRUMENT_GRADE_GATE_VERSION = 'instrument-grade-gate/1.0.0' as const;

export type MetricProvenance =
  | 'physical-loopback'
  | 'software-diagnostic'
  | 'driver-reported'
  | 'estimated'
  | 'unknown';

export type AcceptanceStatus = 'INSTRUMENT_GRADE_PASS' | 'FAIL' | 'NOT_VERIFIED';

export interface MeasurementEvidence {
  provenance: MetricProvenance;
  sampleCount: number;
  measuredAt: string | null;
  device: string | null;
  sampleRateHz: number | null;
  evidenceRef: string | null;
  /** Independent clock/edge anchor when that metric has one. */
  anchorRef: string | null;
}

export interface DistributionMeasurement extends MeasurementEvidence {
  unit: 'ms';
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  maxAbs: number | null;
}

export interface ScalarMeasurement extends MeasurementEvidence {
  unit: 'ms' | 'frames' | 'count';
  value: number | null;
}

export interface LoopDriftMeasurement extends MeasurementEvidence {
  unit: 'ms';
  maxAbs: number | null;
  slopeMsPerMinute: number | null;
  nonAccumulating: boolean | null;
}

export interface XrunMeasurement extends ScalarMeasurement {
  unit: 'count';
  coverageSeconds: number | null;
  coverageScope: 'browser-callbacks-and-physical-marker' | 'driver-only' | 'software-only' | 'unknown';
  callbackDeadlineMs: number | null;
  physicalSampleMarkerContinuous: boolean | null;
  hardwareDropoutEvidenceRef: string | null;
}

export interface FxLatencyMeasurement {
  effectId: string;
  effectName: string;
  firstArrival: ScalarMeasurement;
  peak: ScalarMeasurement;
  tail: ScalarMeasurement;
}

export interface BrowserRealtimeSnapshot {
  sampleRate: number;
  quantumFrames: number;
  renderedFrame: number;
  underruns: number;
  commandQueueDepth: number;
  loopFrames: number[];
  recordingFrames: number[];
  trackStates: number[];
  trackPositions: number[];
  outputMonitorEnabled: boolean;
  backendMode: 'sab-worklet';
  lastAckSequence: number;
  commandOverruns: number;
  processDeadlineMisses: number | null;
  deadlineMetricAvailable: boolean;
  inputDropoutBlocks: number;
  trackCapacityOverruns: number;
  maxTrackFrames: number;
  trackCapacityFrames: number[];
}

export interface InstrumentGradeDevice {
  id: string;
  label: string;
}

export interface InstrumentGradeReport {
  schema: typeof INSTRUMENT_GRADE_SCHEMA;
  schemaVersion: typeof INSTRUMENT_GRADE_SCHEMA_VERSION;
  reportId: string;
  run: {
    startedAt: string;
    endedAt: string;
    durationSeconds: number;
    gateVersion: string;
    systemUnderTest: 'webrc505-project-worklet' | 'web-audio-bypass-baseline' | 'native-project' | 'offline-fx-benchmark';
    assertionVersions: Record<string, string>;
  };
  hardware: {
    inputDevice: InstrumentGradeDevice;
    outputDevice: InstrumentGradeDevice;
    /** Physical interface clock. RC-505mkII commonly reports 44100 Hz. */
    hardwareSampleRateHz: number | null;
    /** Web Audio/DSP graph rate; kept distinct from the interface clock. */
    processingSampleRateHz: number | null;
    renderQuantumFrames: number | null;
  };
  pathEvidence: {
    physicalLoopbackConfirmed: boolean;
    loopbackDescription: string;
    loopbackEvidenceRef: string | null;
    independentInputAnchorRef: string | null;
    independentOutputAnchorRef: string | null;
    adcToBrowserEvidenceRef: string | null;
    browserToDspEvidenceRef: string | null;
    dspToDacEvidenceRef: string | null;
    dacToAdcEvidenceRef: string | null;
  };
  metrics: {
    hardwareRtl: DistributionMeasurement;
    input: DistributionMeasurement;
    output: DistributionMeasurement;
    /** Derived RTL P95 − P50 from exactly the same probe trace/sample set. */
    jitter: ScalarMeasurement;
    trigger: DistributionMeasurement;
    triggerByAction: Record<'REC' | 'PLAY' | 'STOP' | 'FX', DistributionMeasurement>;
    overdubAlignment: DistributionMeasurement;
    renderQuantum: ScalarMeasurement;
    fxLatency: FxLatencyMeasurement[];
    callback: DistributionMeasurement;
    xrun: XrunMeasurement;
    loopDrift: LoopDriftMeasurement;
  };
  software: {
    runtimeSnapshot: BrowserRealtimeSnapshot | null;
    callback96kProfile: Callback96kProfile | null;
  };
}

export interface GateCheck {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'unknown';
  detail: string;
}

export interface AcceptanceResult {
  status: AcceptanceStatus;
  checks: GateCheck[];
  missing: string[];
  callback96kStatus: AcceptanceStatus;
  callback96kChecks: GateCheck[];
}

export interface Callback96kProfile {
  sampleRateHz: 96000;
  renderQuantumFrames: 128;
  durationSeconds: number;
  inputDeviceId: string;
  outputDeviceId: string;
  callback: DistributionMeasurement;
  xrun: XrunMeasurement;
}

export interface ValidationResult {
  valid: boolean;
  issues: string[];
  report?: InstrumentGradeReport;
}

const PROVENANCE_VALUES: readonly MetricProvenance[] = [
  'physical-loopback',
  'software-diagnostic',
  'driver-reported',
  'estimated',
  'unknown',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string, issues: string[]) {
  for (const key of keys) {
    if (!(key in value)) issues.push(`${path}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) issues.push(`${path}.${key} is not supported by schema v1`);
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function checkIsoTimestamp(value: unknown, path: string, issues: string[]) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    issues.push(`${path} must be an ISO-compatible timestamp`);
  }
}

function validateEvidence(value: unknown, path: string, issues: string[]): value is MeasurementEvidence {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return false;
  }

  hasExactKeys(value, [
    'provenance', 'sampleCount', 'measuredAt', 'device', 'sampleRateHz', 'evidenceRef', 'anchorRef',
  ], path, issues);

  const validProvenance = PROVENANCE_VALUES.includes(value.provenance as MetricProvenance);
  if (!validProvenance) issues.push(`${path}.provenance is unsupported`);
  if (!Number.isInteger(value.sampleCount) || (value.sampleCount as number) < 0) {
    issues.push(`${path}.sampleCount must be a non-negative integer`);
  }
  if (value.measuredAt !== null) checkIsoTimestamp(value.measuredAt, `${path}.measuredAt`, issues);
  if (!isNullableString(value.device)) issues.push(`${path}.device must be a non-empty string or null`);
  if (!isNullableFiniteNumber(value.sampleRateHz) || (typeof value.sampleRateHz === 'number' && value.sampleRateHz <= 0)) {
    issues.push(`${path}.sampleRateHz must be positive or null`);
  }
  if (!isNullableString(value.evidenceRef)) issues.push(`${path}.evidenceRef must be a non-empty string or null`);
  if (!isNullableString(value.anchorRef)) issues.push(`${path}.anchorRef must be a non-empty string or null`);

  if (validProvenance && value.provenance === 'unknown') {
    if (value.sampleCount !== 0) issues.push(`${path}: unknown measurements must have sampleCount 0`);
    if (value.measuredAt !== null || value.device !== null || value.sampleRateHz !== null || value.evidenceRef !== null || value.anchorRef !== null) {
      issues.push(`${path}: unknown measurements must not claim measurement metadata`);
    }
  } else if (validProvenance) {
    if ((value.sampleCount as number) <= 0) issues.push(`${path}: measured values require sampleCount > 0`);
    if (value.measuredAt === null) issues.push(`${path}: measured values require measuredAt`);
    if (value.device === null) issues.push(`${path}: measured values require a device or runtime label`);
    if (value.sampleRateHz === null) issues.push(`${path}: measured values require sampleRateHz`);
    if (value.evidenceRef === null) issues.push(`${path}: measured values require evidenceRef`);
  }

  return true;
}

function validateScalar(value: unknown, path: string, issues: string[], expectedUnit: ScalarMeasurement['unit']): value is ScalarMeasurement {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return false;
  }
  hasExactKeys(value, [
    'provenance', 'sampleCount', 'measuredAt', 'device', 'sampleRateHz', 'evidenceRef', 'anchorRef', 'unit', 'value',
  ], path, issues);
  const evidenceValid = validateEvidence({
    provenance: value.provenance,
    sampleCount: value.sampleCount,
    measuredAt: value.measuredAt,
    device: value.device,
    sampleRateHz: value.sampleRateHz,
    evidenceRef: value.evidenceRef,
    anchorRef: value.anchorRef,
  }, path, issues);
  if (value.unit !== expectedUnit) issues.push(`${path}.unit must be ${expectedUnit}`);
  if (!isNullableFiniteNumber(value.value)) issues.push(`${path}.value must be a finite number or null`);
  if (value.provenance === 'unknown' && value.value !== null) issues.push(`${path}: unknown values must be null`);
  if (value.provenance !== 'unknown' && value.value === null) issues.push(`${path}: measured values cannot be null`);
  if (expectedUnit === 'count' && typeof value.value === 'number' && (!Number.isInteger(value.value) || value.value < 0)) {
    issues.push(`${path}.value must be a non-negative integer count`);
  }
  return evidenceValid;
}

function validateXrun(value: unknown, path: string, issues: string[]): value is XrunMeasurement {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return false;
  }
  hasExactKeys(value, [
    'provenance', 'sampleCount', 'measuredAt', 'device', 'sampleRateHz', 'evidenceRef', 'anchorRef', 'unit', 'value',
    'coverageSeconds', 'coverageScope', 'callbackDeadlineMs', 'physicalSampleMarkerContinuous', 'hardwareDropoutEvidenceRef',
  ], path, issues);
  validateScalar({
    provenance: value.provenance,
    sampleCount: value.sampleCount,
    measuredAt: value.measuredAt,
    device: value.device,
    sampleRateHz: value.sampleRateHz,
    evidenceRef: value.evidenceRef,
    anchorRef: value.anchorRef,
    unit: value.unit,
    value: value.value,
  }, path, issues, 'count');
  if (!isNullableFiniteNumber(value.coverageSeconds) || (typeof value.coverageSeconds === 'number' && value.coverageSeconds < 0)) {
    issues.push(`${path}.coverageSeconds must be non-negative or null`);
  }
  if (!['browser-callbacks-and-physical-marker', 'driver-only', 'software-only', 'unknown'].includes(value.coverageScope as string)) {
    issues.push(`${path}.coverageScope is unsupported`);
  }
  if (!isNullableFiniteNumber(value.callbackDeadlineMs) || (typeof value.callbackDeadlineMs === 'number' && value.callbackDeadlineMs <= 0)) {
    issues.push(`${path}.callbackDeadlineMs must be positive or null`);
  }
  if (value.physicalSampleMarkerContinuous !== null && typeof value.physicalSampleMarkerContinuous !== 'boolean') {
    issues.push(`${path}.physicalSampleMarkerContinuous must be boolean or null`);
  }
  if (!isNullableString(value.hardwareDropoutEvidenceRef)) {
    issues.push(`${path}.hardwareDropoutEvidenceRef must be a non-empty string or null`);
  }
  if (value.provenance === 'unknown' && (value.coverageSeconds !== null || value.callbackDeadlineMs !== null || value.physicalSampleMarkerContinuous !== null || value.hardwareDropoutEvidenceRef !== null)) {
    issues.push(`${path}: unknown XRUN data must not claim coverage`);
  }
  return true;
}

function validateLoopDrift(value: unknown, path: string, issues: string[]): value is LoopDriftMeasurement {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return false;
  }
  hasExactKeys(value, [
    'provenance', 'sampleCount', 'measuredAt', 'device', 'sampleRateHz', 'evidenceRef', 'anchorRef', 'unit',
    'maxAbs', 'slopeMsPerMinute', 'nonAccumulating',
  ], path, issues);
  validateEvidence({
    provenance: value.provenance,
    sampleCount: value.sampleCount,
    measuredAt: value.measuredAt,
    device: value.device,
    sampleRateHz: value.sampleRateHz,
    evidenceRef: value.evidenceRef,
    anchorRef: value.anchorRef,
  }, path, issues);
  if (value.unit !== 'ms') issues.push(`${path}.unit must be ms`);
  for (const key of ['maxAbs', 'slopeMsPerMinute'] as const) {
    if (!isNullableFiniteNumber(value[key])) issues.push(`${path}.${key} must be a finite number or null`);
  }
  if (value.maxAbs !== null && typeof value.maxAbs === 'number' && value.maxAbs < 0) issues.push(`${path}.maxAbs cannot be negative`);
  if (value.nonAccumulating !== null && typeof value.nonAccumulating !== 'boolean') {
    issues.push(`${path}.nonAccumulating must be boolean or null`);
  }
  if (value.provenance === 'unknown' && (value.maxAbs !== null || value.slopeMsPerMinute !== null || value.nonAccumulating !== null)) {
    issues.push(`${path}: unknown drift must not claim values`);
  }
  if (value.provenance !== 'unknown' && (value.maxAbs === null || value.slopeMsPerMinute === null || value.nonAccumulating === null)) {
    issues.push(`${path}: measured drift requires maxAbs, slope, and stability result`);
  }
  return true;
}

function validateDistribution(value: unknown, path: string, issues: string[]): value is DistributionMeasurement {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return false;
  }
  hasExactKeys(value, [
    'provenance', 'sampleCount', 'measuredAt', 'device', 'sampleRateHz', 'evidenceRef', 'anchorRef',
    'unit', 'p50', 'p95', 'p99', 'max', 'maxAbs',
  ], path, issues);
  const evidenceValid = validateEvidence({
    provenance: value.provenance,
    sampleCount: value.sampleCount,
    measuredAt: value.measuredAt,
    device: value.device,
    sampleRateHz: value.sampleRateHz,
    evidenceRef: value.evidenceRef,
    anchorRef: value.anchorRef,
  }, path, issues);
  if (value.unit !== 'ms') issues.push(`${path}.unit must be ms`);
  for (const key of ['p50', 'p95', 'p99', 'max', 'maxAbs'] as const) {
    if (!isNullableFiniteNumber(value[key])) issues.push(`${path}.${key} must be a finite number or null`);
    if (value.provenance === 'unknown' && value[key] !== null) issues.push(`${path}: unknown percentile ${key} must be null`);
    if (value.provenance !== 'unknown' && value[key] === null) issues.push(`${path}: measured percentile ${key} cannot be null`);
  }
  return evidenceValid;
}

function validateDevice(value: unknown, path: string, issues: string[]) {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  hasExactKeys(value, ['id', 'label'], path, issues);
  if (!isNonEmptyString(value.id)) issues.push(`${path}.id must be a non-empty string`);
  if (!isNonEmptyString(value.label)) issues.push(`${path}.label must be a non-empty string`);
}

function validateRuntimeSnapshot(value: unknown, path: string, issues: string[]) {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object or null`);
    return;
  }
  hasExactKeys(value, [
    'sampleRate', 'quantumFrames', 'renderedFrame', 'underruns', 'commandQueueDepth', 'loopFrames', 'recordingFrames', 'trackStates',
    'trackPositions', 'outputMonitorEnabled', 'backendMode', 'lastAckSequence', 'commandOverruns', 'processDeadlineMisses',
    'deadlineMetricAvailable', 'inputDropoutBlocks', 'trackCapacityOverruns', 'maxTrackFrames', 'trackCapacityFrames',
  ], path, issues);
  for (const key of [
    'sampleRate', 'quantumFrames', 'renderedFrame', 'underruns', 'commandQueueDepth', 'lastAckSequence', 'commandOverruns',
    'inputDropoutBlocks', 'trackCapacityOverruns', 'maxTrackFrames',
  ]) {
    if (!isFiniteNumber(value[key]) || value[key] < 0) issues.push(`${path}.${key} must be a non-negative finite number`);
  }
  if (!isNullableFiniteNumber(value.processDeadlineMisses) || (typeof value.processDeadlineMisses === 'number' && value.processDeadlineMisses < 0)) {
    issues.push(`${path}.processDeadlineMisses must be non-negative or null`);
  }
  if (typeof value.deadlineMetricAvailable !== 'boolean') issues.push(`${path}.deadlineMetricAvailable must be boolean`);
  if (value.deadlineMetricAvailable === false && value.processDeadlineMisses !== null) {
    issues.push(`${path}.processDeadlineMisses must be null when deadlineMetricAvailable is false`);
  }
  for (const key of ['loopFrames', 'recordingFrames', 'trackStates', 'trackPositions', 'trackCapacityFrames']) {
    if (!Array.isArray(value[key]) || value[key].length !== 5 || value[key].some((item) => !isFiniteNumber(item) || item < 0)) {
      issues.push(`${path}.${key} must contain five non-negative numbers`);
    }
  }
  if (typeof value.outputMonitorEnabled !== 'boolean') issues.push(`${path}.outputMonitorEnabled must be boolean`);
  if (value.backendMode !== 'sab-worklet') {
    issues.push(`${path}.backendMode must be sab-worklet`);
  }
}

/** Validate imported JSON without filling defaults or coercing values. */
export function validateInstrumentGradeReport(input: unknown): ValidationResult {
  const issues: string[] = [];
  if (!isRecord(input)) return { valid: false, issues: ['report must be a JSON object'] };

  hasExactKeys(input, ['schema', 'schemaVersion', 'reportId', 'run', 'hardware', 'pathEvidence', 'metrics', 'software'], 'report', issues);
  if (input.schema !== INSTRUMENT_GRADE_SCHEMA) issues.push(`report.schema must be ${INSTRUMENT_GRADE_SCHEMA}`);
  if (input.schemaVersion !== INSTRUMENT_GRADE_SCHEMA_VERSION) issues.push(`report.schemaVersion must be ${INSTRUMENT_GRADE_SCHEMA_VERSION}`);
  if (!isNonEmptyString(input.reportId)) issues.push('report.reportId must be a non-empty string');

  if (!isRecord(input.run)) {
    issues.push('report.run must be an object');
  } else {
    hasExactKeys(input.run, ['startedAt', 'endedAt', 'durationSeconds', 'gateVersion', 'systemUnderTest', 'assertionVersions'], 'report.run', issues);
    checkIsoTimestamp(input.run.startedAt, 'report.run.startedAt', issues);
    checkIsoTimestamp(input.run.endedAt, 'report.run.endedAt', issues);
    if (!isFiniteNumber(input.run.durationSeconds) || input.run.durationSeconds < 0) issues.push('report.run.durationSeconds must be non-negative');
    if (!isNonEmptyString(input.run.gateVersion)) issues.push('report.run.gateVersion must be a non-empty string');
    if (!['webrc505-project-worklet', 'web-audio-bypass-baseline', 'native-project', 'offline-fx-benchmark'].includes(input.run.systemUnderTest as string)) {
      issues.push('report.run.systemUnderTest is unsupported');
    }
    if (!isRecord(input.run.assertionVersions) || Object.keys(input.run.assertionVersions).length === 0 || Object.values(input.run.assertionVersions).some((value) => !isNonEmptyString(value))) {
      issues.push('report.run.assertionVersions must be a non-empty object of version strings');
    }
  }

  if (!isRecord(input.hardware)) {
    issues.push('report.hardware must be an object');
  } else {
    hasExactKeys(input.hardware, ['inputDevice', 'outputDevice', 'hardwareSampleRateHz', 'processingSampleRateHz', 'renderQuantumFrames'], 'report.hardware', issues);
    validateDevice(input.hardware.inputDevice, 'report.hardware.inputDevice', issues);
    validateDevice(input.hardware.outputDevice, 'report.hardware.outputDevice', issues);
    if (!isNullableFiniteNumber(input.hardware.hardwareSampleRateHz) || (typeof input.hardware.hardwareSampleRateHz === 'number' && input.hardware.hardwareSampleRateHz <= 0)) {
      issues.push('report.hardware.hardwareSampleRateHz must be positive or null');
    }
    if (!isNullableFiniteNumber(input.hardware.processingSampleRateHz) || (typeof input.hardware.processingSampleRateHz === 'number' && input.hardware.processingSampleRateHz <= 0)) {
      issues.push('report.hardware.processingSampleRateHz must be positive or null');
    }
    if (!isNullableFiniteNumber(input.hardware.renderQuantumFrames) || (typeof input.hardware.renderQuantumFrames === 'number' && input.hardware.renderQuantumFrames <= 0)) {
      issues.push('report.hardware.renderQuantumFrames must be positive or null');
    }
  }

  if (!isRecord(input.pathEvidence)) {
    issues.push('report.pathEvidence must be an object');
  } else {
    hasExactKeys(input.pathEvidence, [
      'physicalLoopbackConfirmed', 'loopbackDescription', 'loopbackEvidenceRef', 'independentInputAnchorRef',
      'independentOutputAnchorRef', 'adcToBrowserEvidenceRef', 'browserToDspEvidenceRef', 'dspToDacEvidenceRef',
      'dacToAdcEvidenceRef',
    ], 'report.pathEvidence', issues);
    if (typeof input.pathEvidence.physicalLoopbackConfirmed !== 'boolean') issues.push('report.pathEvidence.physicalLoopbackConfirmed must be boolean');
    if (!isNonEmptyString(input.pathEvidence.loopbackDescription)) issues.push('report.pathEvidence.loopbackDescription must be a non-empty string');
    for (const key of [
      'loopbackEvidenceRef', 'independentInputAnchorRef', 'independentOutputAnchorRef', 'adcToBrowserEvidenceRef',
      'browserToDspEvidenceRef', 'dspToDacEvidenceRef', 'dacToAdcEvidenceRef',
    ]) {
      if (!isNullableString(input.pathEvidence[key])) issues.push(`report.pathEvidence.${key} must be a non-empty string or null`);
    }
  }

  if (!isRecord(input.metrics)) {
    issues.push('report.metrics must be an object');
  } else {
    hasExactKeys(input.metrics, [
      'hardwareRtl', 'input', 'output', 'jitter', 'trigger', 'triggerByAction', 'overdubAlignment', 'renderQuantum', 'fxLatency',
      'callback', 'xrun', 'loopDrift',
    ], 'report.metrics', issues);
    for (const key of ['hardwareRtl', 'input', 'output', 'trigger', 'overdubAlignment', 'callback']) {
      validateDistribution(input.metrics[key], `report.metrics.${key}`, issues);
    }
    validateScalar(input.metrics.jitter, 'report.metrics.jitter', issues, 'ms');
    const triggerByAction = input.metrics.triggerByAction;
    if (!isRecord(triggerByAction)) {
      issues.push('report.metrics.triggerByAction must be an object');
    } else {
      hasExactKeys(triggerByAction, ['REC', 'PLAY', 'STOP', 'FX'], 'report.metrics.triggerByAction', issues);
      for (const action of ['REC', 'PLAY', 'STOP', 'FX'] as const) {
        validateDistribution(triggerByAction[action], `report.metrics.triggerByAction.${action}`, issues);
      }
    }
    validateScalar(input.metrics.renderQuantum, 'report.metrics.renderQuantum', issues, 'frames');
    validateXrun(input.metrics.xrun, 'report.metrics.xrun', issues);
    validateLoopDrift(input.metrics.loopDrift, 'report.metrics.loopDrift', issues);

    if (!Array.isArray(input.metrics.fxLatency)) {
      issues.push('report.metrics.fxLatency must be an array');
    } else {
      const ids = new Set<string>();
      input.metrics.fxLatency.forEach((fx, index) => {
        const path = `report.metrics.fxLatency[${index}]`;
        if (!isRecord(fx)) {
          issues.push(`${path} must be an object`);
          return;
        }
        hasExactKeys(fx, ['effectId', 'effectName', 'firstArrival', 'peak', 'tail'], path, issues);
        if (!isNonEmptyString(fx.effectId)) issues.push(`${path}.effectId must be a non-empty string`);
        if (!isNonEmptyString(fx.effectName)) issues.push(`${path}.effectName must be a non-empty string`);
        if (typeof fx.effectId === 'string') {
          if (ids.has(fx.effectId)) issues.push(`${path}.effectId must be unique`);
          ids.add(fx.effectId);
        }
        validateScalar(fx.firstArrival, `${path}.firstArrival`, issues, 'ms');
        validateScalar(fx.peak, `${path}.peak`, issues, 'ms');
        validateScalar(fx.tail, `${path}.tail`, issues, 'ms');
      });
    }
  }

  if (!isRecord(input.software)) {
    issues.push('report.software must be an object');
  } else {
    hasExactKeys(input.software, ['runtimeSnapshot', 'callback96kProfile'], 'report.software', issues);
    if (input.software.runtimeSnapshot !== null) validateRuntimeSnapshot(input.software.runtimeSnapshot, 'report.software.runtimeSnapshot', issues);
    if (input.software.callback96kProfile !== null) {
      const profile = input.software.callback96kProfile;
      if (!isRecord(profile)) {
        issues.push('report.software.callback96kProfile must be an object or null');
      } else {
        hasExactKeys(profile, ['sampleRateHz', 'renderQuantumFrames', 'durationSeconds', 'callback', 'xrun', 'inputDeviceId', 'outputDeviceId'], 'report.software.callback96kProfile', issues);
        if (profile.sampleRateHz !== 96000) issues.push('report.software.callback96kProfile.sampleRateHz must be 96000');
        if (profile.renderQuantumFrames !== 128) issues.push('report.software.callback96kProfile.renderQuantumFrames must be 128');
        if (!isFiniteNumber(profile.durationSeconds) || profile.durationSeconds < 0) issues.push('report.software.callback96kProfile.durationSeconds must be non-negative');
        if (!isNonEmptyString(profile.inputDeviceId)) issues.push('report.software.callback96kProfile.inputDeviceId must be a non-empty string');
        if (!isNonEmptyString(profile.outputDeviceId)) issues.push('report.software.callback96kProfile.outputDeviceId must be a non-empty string');
        if (isRecord(input.hardware) && isRecord(input.hardware.inputDevice) && profile.inputDeviceId !== input.hardware.inputDevice.id) {
          issues.push('report.software.callback96kProfile.inputDeviceId must match the report hardware input device');
        }
        if (isRecord(input.hardware) && isRecord(input.hardware.outputDevice) && profile.outputDeviceId !== input.hardware.outputDevice.id) {
          issues.push('report.software.callback96kProfile.outputDeviceId must match the report hardware output device');
        }
        validateDistribution(profile.callback, 'report.software.callback96kProfile.callback', issues);
        validateXrun(profile.xrun, 'report.software.callback96kProfile.xrun', issues);
      }
    }
  }

  if (issues.length > 0) return { valid: false, issues };
  return { valid: true, issues, report: input as unknown as InstrumentGradeReport };
}

/** Create a visible unknown placeholder; unknown is never represented as zero. */
export function unknownScalar(unit: ScalarMeasurement['unit']): ScalarMeasurement {
  return {
    value: null,
    unit,
    provenance: 'unknown',
    sampleCount: 0,
    measuredAt: null,
    device: null,
    sampleRateHz: null,
    evidenceRef: null,
    anchorRef: null,
  };
}

function unknownDistribution(): DistributionMeasurement {
  return {
    p50: null,
    p95: null,
    p99: null,
    max: null,
    maxAbs: null,
    unit: 'ms',
    provenance: 'unknown',
    sampleCount: 0,
    measuredAt: null,
    device: null,
    sampleRateHz: null,
    evidenceRef: null,
    anchorRef: null,
  };
}

function addNumericCheck(
  checks: GateCheck[],
  missing: string[],
  id: string,
  label: string,
  metric: DistributionMeasurement,
  percentile: 'p50' | 'p95' | 'p99' | 'max',
  predicate: (value: number) => boolean,
  thresholdText: string,
) {
  const value = metric[percentile];
  if (metric.provenance !== 'physical-loopback' || value === null || metric.sampleCount === 0 || !hasEvidence(metric.evidenceRef)) {
    missing.push(`${label} ${percentile.toUpperCase()} physical-loopback measurement`);
    checks.push({ id, label, status: 'unknown', detail: `${percentile.toUpperCase()} lacks physical-loopback samples` });
    return;
  }
  const passed = predicate(value);
  checks.push({
    id,
    label,
    status: passed ? 'pass' : 'fail',
    detail: `${percentile.toUpperCase()} ${value.toFixed(3)} ms; gate ${thresholdText}`,
  });
}

function hasEvidence(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Apply the explicit strict gate. RTL P50 < 10 ms is the acceptance threshold;
 * P95 <= 12 ms is an additional tail guard. The separate <= 10 ms target is
 * intentionally not sufficient for a pass.
 */
export function evaluateInstrumentGrade(report: InstrumentGradeReport): AcceptanceResult {
  const checks: GateCheck[] = [];
  const missing: string[] = [];
  const path = report.pathEvidence;
  const projectPath = report.run.systemUnderTest === 'webrc505-project-worklet' || report.run.systemUnderTest === 'native-project';
  const evidenceReady = report.hardware.processingSampleRateHz === 48000
    && report.hardware.hardwareSampleRateHz !== null
    && report.hardware.renderQuantumFrames === 128
    && projectPath
    && path.physicalLoopbackConfirmed
    && hasEvidence(path.loopbackEvidenceRef)
    && hasEvidence(path.adcToBrowserEvidenceRef)
    && hasEvidence(path.browserToDspEvidenceRef)
    && hasEvidence(path.dspToDacEvidenceRef)
    && hasEvidence(path.dacToAdcEvidenceRef);

  checks.push({
    id: 'physical-path',
    label: 'Physical ADC → browser → DSP → DAC → analog loopback',
    status: evidenceReady ? 'pass' : 'unknown',
    detail: evidenceReady
      ? `${report.hardware.inputDevice.label} / ${report.hardware.outputDevice.label}, ${report.hardware.hardwareSampleRateHz} Hz interface, 48 kHz graph, 128-frame quantum`
      : projectPath
        ? 'Physical project path, DSP graph, or timing evidence is incomplete'
        : report.run.systemUnderTest === 'web-audio-bypass-baseline'
          ? 'Simple Web Audio bypass baseline is diagnostic only; the project DSP has not been measured'
          : 'Offline FX benchmark is software-only and has no physical I/O or project runtime evidence',
  });
  if (!evidenceReady) missing.push('project DSP physical loopback chain, 48 kHz processing graph, 128-frame quantum, and path evidence');

  const durationPass = report.run.durationSeconds >= 1800;
  checks.push({
    id: 'duration',
    label: 'Continuous stability run',
    status: durationPass ? 'pass' : 'unknown',
    detail: durationPass ? `${(report.run.durationSeconds / 60).toFixed(1)} min (required ≥ 30 min)` : `${(report.run.durationSeconds / 60).toFixed(1)} min; 30 min of evidence required`,
  });
  if (!durationPass) missing.push('at least 30 minutes of continuous evidence');

  addNumericCheck(checks, missing, 'rtl-p50', 'Hardware RTL', report.metrics.hardwareRtl, 'p50', (value) => value < 10, '< 10 ms (strict acceptance; target ≤ 10 ms)');
  addNumericCheck(checks, missing, 'rtl-p95', 'Hardware RTL', report.metrics.hardwareRtl, 'p95', (value) => value <= 12, '≤ 12 ms');
  const jitter = report.metrics.jitter;
  const rtl = report.metrics.hardwareRtl;
  const jitterSharesRtlTrace = jitter.provenance === 'physical-loopback'
    && jitter.value !== null
    && rtl.p50 !== null
    && rtl.p95 !== null
    && jitter.sampleCount === rtl.sampleCount
    && jitter.evidenceRef === rtl.evidenceRef
    && jitter.measuredAt === rtl.measuredAt
    && jitter.device === rtl.device
    && jitter.sampleRateHz === rtl.sampleRateHz
    && jitter.anchorRef === rtl.anchorRef
    && Math.abs(jitter.value - (rtl.p95 - rtl.p50)) < 0.001;
  if (!jitterSharesRtlTrace) {
    missing.push('jitter derived from the same Hardware RTL samples and trace');
    checks.push({ id: 'jitter', label: 'Jitter', status: 'unknown', detail: 'Must equal Hardware RTL P95 − P50 from the same samples/evidence' });
  } else {
    const passed = jitter.value! < 1;
    checks.push({ id: 'jitter', label: 'Jitter', status: passed ? 'pass' : 'fail', detail: `Hardware RTL P95 − P50 = ${jitter.value!.toFixed(3)} ms; gate < 1 ms` });
  }
  // The aggregate row is descriptive; all four intent classes below are the
  // actual acceptance gates so an unclassified aggregate cannot block them.
  for (const action of ['REC', 'PLAY', 'STOP', 'FX'] as const) {
    addNumericCheck(
      checks,
      missing,
      `trigger-${action.toLowerCase()}`,
      `${action} intent → analog capture`,
      report.metrics.triggerByAction[action],
      'max',
      (value) => value < 5,
      'MAX < 5 ms',
    );
  }
  const alignment = report.metrics.overdubAlignment;
  if (alignment.provenance !== 'physical-loopback' || alignment.maxAbs === null || alignment.sampleCount === 0 || !hasEvidence(alignment.evidenceRef)) {
    missing.push('physical overdub alignment absolute maximum');
    checks.push({ id: 'overdub-alignment', label: 'Overdub alignment', status: 'unknown', detail: 'Absolute error maximum is missing' });
  } else {
    const passed = alignment.maxAbs <= 1;
    checks.push({ id: 'overdub-alignment', label: 'Overdub alignment', status: passed ? 'pass' : 'fail', detail: `MAXABS ${alignment.maxAbs.toFixed(3)} ms; gate ≤ 1 ms` });
  }

  const xrun = report.metrics.xrun;
  const xrunCoverageComplete = (xrun.provenance === 'software-diagnostic' || xrun.provenance === 'driver-reported')
    && xrun.value !== null
    && xrun.sampleCount > 0
    && hasEvidence(xrun.evidenceRef)
    && xrun.coverageScope === 'browser-callbacks-and-physical-marker'
    && xrun.coverageSeconds !== null
    && xrun.coverageSeconds >= 1800
    && xrun.callbackDeadlineMs !== null
    && xrun.physicalSampleMarkerContinuous === true
    && hasEvidence(xrun.hardwareDropoutEvidenceRef);
  if (!xrunCoverageComplete) {
    missing.push('30-minute XRUN coverage with callback deadline and continuous physical sample-marker dropout evidence');
    checks.push({ id: 'xrun', label: 'XRUNs', status: 'unknown', detail: 'Software/driver frame counters alone cannot exclude hardware dropouts' });
  } else if (xrun.value !== 0) {
    checks.push({ id: 'xrun', label: 'XRUNs', status: 'fail', detail: `${xrun.value} (required 0)` });
  } else {
    checks.push({ id: 'xrun', label: 'XRUNs', status: 'pass', detail: `0 across ${(xrun.coverageSeconds! / 60).toFixed(1)} min; callback deadline ${xrun.callbackDeadlineMs!.toFixed(3)} ms and hardware marker covered` });
  }

  const drift = report.metrics.loopDrift;
  if (drift.provenance !== 'physical-loopback' || drift.maxAbs === null || drift.slopeMsPerMinute === null || drift.sampleCount === 0 || drift.nonAccumulating === null || !hasEvidence(drift.evidenceRef)) {
    missing.push('physical loop drift absolute maximum and regression slope');
    checks.push({ id: 'loop-drift', label: 'Loop drift', status: 'unknown', detail: 'Physical drift/stability evidence is incomplete' });
  } else {
    const passed = drift.maxAbs < 1 && drift.nonAccumulating;
    checks.push({
      id: 'loop-drift',
      label: 'Loop drift',
      status: passed ? 'pass' : 'fail',
      detail: `MAXABS ${drift.maxAbs.toFixed(3)} ms, slope ${drift.slopeMsPerMinute.toFixed(4)} ms/min; ${drift.nonAccumulating ? 'non-accumulating' : 'accumulating'} (gate < 1 ms and non-accumulating)`,
    });
  }

  const callback = report.metrics.callback;
  if (callback.provenance !== 'software-diagnostic' || callback.p99 === null || callback.sampleCount === 0 || !hasEvidence(callback.evidenceRef) || xrun.callbackDeadlineMs === null) {
    missing.push('callback P99 and measured callback deadline');
    checks.push({ id: 'callback-budget', label: 'Callback deadline', status: 'unknown', detail: 'Callback timing or deadline is not measured' });
  } else {
    const passed = callback.p99 < xrun.callbackDeadlineMs;
    checks.push({ id: 'callback-budget', label: 'Callback deadline', status: passed ? 'pass' : 'fail', detail: `P99 ${callback.p99.toFixed(3)} ms vs ${xrun.callbackDeadlineMs.toFixed(3)} ms deadline` });
  }

  const callback96kChecks = evaluateCallback96kProfile(report.software.callback96kProfile, {
    inputDeviceId: report.hardware.inputDevice.id,
    outputDeviceId: report.hardware.outputDevice.id,
  });
  const callback96kStatus = callback96kChecks.some((check) => check.status === 'fail')
    ? 'FAIL'
    : callback96kChecks.every((check) => check.status === 'pass')
      ? 'INSTRUMENT_GRADE_PASS'
      : 'NOT_VERIFIED';

  if (!evidenceReady) {
    return { status: 'NOT_VERIFIED', checks, missing: [...new Set(missing)], callback96kStatus, callback96kChecks };
  }
  if (checks.some((check) => check.status === 'fail')) {
    return { status: 'FAIL', checks, missing: [...new Set(missing)], callback96kStatus, callback96kChecks };
  }
  if (missing.length > 0 || checks.some((check) => check.status === 'unknown')) {
    return { status: 'NOT_VERIFIED', checks, missing: [...new Set(missing)], callback96kStatus, callback96kChecks };
  }
  return { status: 'INSTRUMENT_GRADE_PASS', checks, missing: [], callback96kStatus, callback96kChecks };
}

export function evaluateCallback96kProfile(
  profile: Callback96kProfile | null,
  selectedDevices?: { inputDeviceId: string; outputDeviceId: string },
): GateCheck[] {
  if (!profile) return [{ id: 'callback96k-profile', label: '96 kHz callback profile', status: 'unknown', detail: 'No dedicated 96 kHz / 128-frame evidence' }];
  const checks: GateCheck[] = [];
  const devicesMatch = selectedDevices === undefined
    || (profile.inputDeviceId === selectedDevices.inputDeviceId && profile.outputDeviceId === selectedDevices.outputDeviceId);
  const callbackReady = profile.sampleRateHz === 96000
    && profile.renderQuantumFrames === 128
    && profile.durationSeconds >= 1800
    && devicesMatch
    && profile.callback.provenance === 'software-diagnostic'
    && profile.callback.sampleRateHz === 96000
    && profile.callback.p99 !== null
    && profile.callback.sampleCount > 0
    && hasEvidence(profile.callback.evidenceRef);
  checks.push({
    id: 'callback96k-p99',
    label: '96 kHz / 128-frame callback P99',
    status: !callbackReady ? 'unknown' : profile.callback.p99! < 0.8 ? 'pass' : 'fail',
    detail: !callbackReady ? 'Needs an independent 30-minute 96 kHz / 128-frame run on the same selected I/O devices' : `P99 ${profile.callback.p99!.toFixed(3)} ms; gate < 0.8 ms`,
  });
  const xrun = profile.xrun;
  const xrunReady = xrun.value !== null
    && xrun.value >= 0
    && xrun.sampleCount > 0
    && hasEvidence(xrun.evidenceRef)
    && xrun.coverageScope === 'browser-callbacks-and-physical-marker'
    && xrun.coverageSeconds !== null
    && xrun.coverageSeconds >= 1800
    && xrun.sampleRateHz === 96000
    && xrun.callbackDeadlineMs !== null
    && xrun.physicalSampleMarkerContinuous === true
    && hasEvidence(xrun.hardwareDropoutEvidenceRef);
  checks.push({
    id: 'callback96k-xrun',
    label: '96 kHz XRUN coverage',
    status: !xrunReady ? 'unknown' : xrun.value === 0 ? 'pass' : 'fail',
    detail: !xrunReady ? 'Needs callback deadline and continuous physical sample-marker evidence' : `${xrun.value} XRUNs over ${(xrun.coverageSeconds! / 60).toFixed(1)} min; required 0`,
  });
  return checks;
}

export function createEmptyInstrumentGradeMetrics() {
  const scalar = (unit: ScalarMeasurement['unit']) => unknownScalar(unit);
  const unknownXrun: XrunMeasurement = {
    ...scalar('count'),
    unit: 'count',
    coverageSeconds: null,
    coverageScope: 'unknown',
    callbackDeadlineMs: null,
    physicalSampleMarkerContinuous: null,
    hardwareDropoutEvidenceRef: null,
  };
  const unknownDrift: LoopDriftMeasurement = {
    unit: 'ms',
    maxAbs: null,
    slopeMsPerMinute: null,
    nonAccumulating: null,
    provenance: 'unknown',
    sampleCount: 0,
    measuredAt: null,
    device: null,
    sampleRateHz: null,
    evidenceRef: null,
    anchorRef: null,
  };
  return {
    hardwareRtl: unknownDistribution(),
    input: unknownDistribution(),
    output: unknownDistribution(),
    jitter: unknownScalar('ms'),
    trigger: unknownDistribution(),
    triggerByAction: {
      REC: unknownDistribution(),
      PLAY: unknownDistribution(),
      STOP: unknownDistribution(),
      FX: unknownDistribution(),
    },
    overdubAlignment: unknownDistribution(),
    renderQuantum: scalar('frames'),
    fxLatency: [] as FxLatencyMeasurement[],
    callback: unknownDistribution(),
    xrun: unknownXrun,
    loopDrift: unknownDrift,
  };
}
