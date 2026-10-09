import { describe, expect, it } from 'vitest';
import {
  createEmptyInstrumentGradeMetrics,
  evaluateInstrumentGrade,
  unknownScalar,
  validateInstrumentGradeReport,
  type Callback96kProfile,
  type DistributionMeasurement,
  type InstrumentGradeReport,
  type ScalarMeasurement,
  type XrunMeasurement,
} from '../../src/audio/instrumentGradeMetrics';

const measuredAt = '2026-10-07T12:00:00.000Z';

function measuredDistribution(
  name: string,
  values: Pick<DistributionMeasurement, 'p50' | 'p95' | 'p99' | 'max' | 'maxAbs'>,
  provenance: DistributionMeasurement['provenance'] = 'physical-loopback',
): DistributionMeasurement {
  return {
    ...values,
    unit: 'ms',
    provenance,
    sampleCount: 100,
    measuredAt,
    device: 'RC-505mkII USB MAIN/INST1',
    sampleRateHz: 48000,
    evidenceRef: `trace:${name}`,
    anchorRef: null,
  };
}

function measuredScalar(unit: ScalarMeasurement['unit'], value: number, name: string): ScalarMeasurement {
  return {
    ...unknownScalar(unit),
    value,
    unit,
    provenance: 'software-diagnostic',
    sampleCount: 100,
    measuredAt,
    device: 'Browser AudioWorklet',
    sampleRateHz: 48000,
    evidenceRef: `trace:${name}`,
  };
}

function measuredXrun(value = 0): XrunMeasurement {
  return {
    ...measuredScalar('count', value, 'xrun'),
    unit: 'count',
    coverageSeconds: 1800,
    coverageScope: 'browser-callbacks-and-physical-marker',
    callbackDeadlineMs: 2.667,
    physicalSampleMarkerContinuous: true,
    hardwareDropoutEvidenceRef: 'trace:physical-marker',
  };
}

function passingReport(): InstrumentGradeReport {
  const metrics = createEmptyInstrumentGradeMetrics();
  metrics.hardwareRtl = measuredDistribution('rtl', { p50: 9.1, p95: 9.8, p99: 10.4, max: 11.0, maxAbs: 11.0 });
  // Input/output remain unknown: the total loopback measurement is not split in half.
  metrics.jitter = {
    ...measuredScalar('ms', 0.7, 'rtl'),
    provenance: 'physical-loopback',
    device: 'RC-505mkII USB MAIN/INST1',
    evidenceRef: 'trace:rtl',
  };
  metrics.trigger = measuredDistribution('trigger', { p50: 2.0, p95: 3.0, p99: 4.0, max: 4.9, maxAbs: 4.9 });
  metrics.triggerByAction = {
    REC: measuredDistribution('trigger-rec', { p50: 2.0, p95: 3.0, p99: 4.0, max: 4.8, maxAbs: 4.8 }),
    PLAY: measuredDistribution('trigger-play', { p50: 2.0, p95: 3.0, p99: 4.0, max: 4.8, maxAbs: 4.8 }),
    STOP: measuredDistribution('trigger-stop', { p50: 2.0, p95: 3.0, p99: 4.0, max: 4.8, maxAbs: 4.8 }),
    FX: measuredDistribution('trigger-fx', { p50: 2.0, p95: 3.0, p99: 4.0, max: 4.8, maxAbs: 4.8 }),
  };
  metrics.overdubAlignment = measuredDistribution('overdub', { p50: 0.1, p95: 0.5, p99: 0.8, max: 0.9, maxAbs: 0.9 });
  metrics.renderQuantum = measuredScalar('frames', 128, 'quantum');
  metrics.callback = measuredDistribution('callback', { p50: 0.22, p95: 0.38, p99: 0.51, max: 0.8, maxAbs: 0.8 }, 'software-diagnostic');
  metrics.xrun = measuredXrun();
  metrics.loopDrift = {
    provenance: 'physical-loopback',
    sampleCount: 1800,
    measuredAt,
    device: 'RC-505mkII analog loopback marker',
    sampleRateHz: 48000,
    evidenceRef: 'trace:drift-regression',
    anchorRef: null,
    unit: 'ms',
    maxAbs: 0.42,
    slopeMsPerMinute: 0.003,
    nonAccumulating: true,
  };

  return {
    schema: 'webrc.instrument-grade-audio',
    schemaVersion: 1,
    reportId: 'fixture-rtl',
    run: {
      startedAt: measuredAt,
      endedAt: '2026-10-07T12:30:00.000Z',
      durationSeconds: 1800,
      gateVersion: 'instrument-grade-gate/1.0.0',
      systemUnderTest: 'webrc505-project-worklet',
      assertionVersions: { browserWorklet: 'whole-worklet-v1', physicalProbe: 'coded-chirp-v1' },
    },
    hardware: {
      inputDevice: { id: 'rc-inst1', label: 'INST1 (RC-505mkII)' },
      outputDevice: { id: 'rc-main', label: 'MAIN (RC-505mkII)' },
      hardwareSampleRateHz: 44100,
      processingSampleRateHz: 48000,
      renderQuantumFrames: 128,
    },
    pathEvidence: {
      physicalLoopbackConfirmed: true,
      loopbackDescription: 'MAIN OUT L/MONO to INST1 L/MONO; USB LINE OUT routing; INST1 input thru to MAIN disabled',
      loopbackEvidenceRef: 'trace:loopback-correlation',
      independentInputAnchorRef: null,
      independentOutputAnchorRef: null,
      adcToBrowserEvidenceRef: 'trace:capture-device',
      browserToDspEvidenceRef: 'trace:project-worklet-profile',
      dspToDacEvidenceRef: 'trace:output-sink',
      dacToAdcEvidenceRef: 'trace:analog-loopback',
    },
    metrics: {
      ...metrics,
      fxLatency: [{
        effectId: 'compressor-1',
        effectName: 'Compressor',
        firstArrival: measuredScalar('ms', 1.4, 'compressor-first'),
        peak: measuredScalar('ms', 6.0, 'compressor-peak'),
        tail: measuredScalar('ms', 3.2, 'compressor-tail'),
      }],
    },
    software: { runtimeSnapshot: null, callback96kProfile: null },
  };
}

describe('instrument-grade measurement schema and gate', () => {
  it('allows an evidenced project path to pass without inventing separate input/output latency', () => {
    const report = passingReport();
    const validation = validateInstrumentGradeReport(report);
    expect(validation.valid).toBe(true);
    expect(report.metrics.input.provenance).toBe('unknown');
    expect(report.metrics.output.provenance).toBe('unknown');
    expect(evaluateInstrumentGrade(report).status).toBe('INSTRUMENT_GRADE_PASS');
  });

  it('keeps a bypass-only measurement diagnostic even when its measured RTL is fast', () => {
    const report = passingReport();
    report.run.systemUnderTest = 'web-audio-bypass-baseline';
    const result = evaluateInstrumentGrade(report);
    expect(result.status).toBe('NOT_VERIFIED');
    expect(result.missing).toContain('project DSP physical loopback chain, 48 kHz processing graph, observed render quantum, and path evidence');
  });

  it('uses the stricter P50 < 10 ms gate and the requested jitter/trigger/alignment statistics', () => {
    const report = passingReport();
    report.metrics.hardwareRtl.p50 = 10;
    report.metrics.hardwareRtl.p95 = 11.2;
    report.metrics.jitter.value = 1.2;
    report.metrics.triggerByAction.REC.max = 5;
    report.metrics.overdubAlignment.maxAbs = 1.01;
    const result = evaluateInstrumentGrade(report);
    expect(result.status).toBe('FAIL');
    expect(result.checks.filter((check) => check.status === 'fail').map((check) => check.id)).toEqual(
      expect.arrayContaining(['rtl-p50', 'jitter', 'trigger-rec', 'overdub-alignment']),
    );
  });

  it('does not accept a software XRUN counter without continuous physical-marker coverage', () => {
    const report = passingReport();
    report.metrics.xrun.physicalSampleMarkerContinuous = false;
    expect(evaluateInstrumentGrade(report).status).toBe('NOT_VERIFIED');
  });

  it('rejects unknown metrics encoded as zero and rejects unrecognized JSON keys', () => {
    const report = passingReport();
    const raw = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    const metrics = raw.metrics as Record<string, Record<string, unknown>>;
    const input = metrics.input;
    input.p50 = 0;
    const invalidZero = validateInstrumentGradeReport(raw);
    expect(invalidZero.valid).toBe(false);
    expect(invalidZero.issues.join(' ')).toContain('unknown percentile p50 must be null');

    const extra = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    (extra as Record<string, unknown>).legacyRoundTripHalf = 0;
    expect(validateInstrumentGradeReport(extra).issues.join(' ')).toContain('not supported by schema v1');
  });

  it('validates an all-unknown report without encoding missing metrics as zero', () => {
    const report = passingReport();
    report.metrics = { ...createEmptyInstrumentGradeMetrics(), fxLatency: [] };
    expect(validateInstrumentGradeReport(report).valid).toBe(true);
    expect(report.metrics.hardwareRtl.p50).toBeNull();
    expect(report.metrics.renderQuantum.value).toBeNull();
    expect('value' in report.metrics.loopDrift).toBe(false);
    expect(evaluateInstrumentGrade(report).status).toBe('NOT_VERIFIED');
  });

  it('fails closed for the separate 96 kHz / 128-frame profile until its own evidence is supplied', () => {
    const result = evaluateInstrumentGrade(passingReport());
    expect(result.status).toBe('INSTRUMENT_GRADE_PASS');
    expect(result.callback96kStatus).toBe('NOT_VERIFIED');
    expect(result.callback96kChecks[0]?.status).toBe('unknown');
  });

  it('accepts an observed non-default render quantum and rejects invalid sizes or mismatched sample rate', () => {
    const report = passingReport();
    const callback: DistributionMeasurement = {
      ...measuredDistribution('callback96k', { p50: 0.25, p95: 0.4, p99: 0.5, max: 0.6, maxAbs: 0.6 }, 'software-diagnostic'),
      sampleRateHz: 96000,
    };
    const profile: Callback96kProfile = {
      sampleRateHz: 96000,
      renderQuantumFrames: 128,
      durationSeconds: 1800,
      inputDeviceId: report.hardware.inputDevice.id,
      outputDeviceId: report.hardware.outputDevice.id,
      callback,
      xrun: { ...measuredXrun(), sampleRateHz: 96000 },
    };
    report.software.callback96kProfile = profile;

    const wrongRate = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    ((wrongRate.software as Record<string, unknown>).callback96kProfile as Record<string, unknown>).sampleRateHz = 48000;
    expect(validateInstrumentGradeReport(wrongRate).issues.join(' ')).toContain('sampleRateHz must be 96000');

    const wrongQuantum = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    ((wrongQuantum.software as Record<string, unknown>).callback96kProfile as Record<string, unknown>).renderQuantumFrames = 0;
    expect(validateInstrumentGradeReport(wrongQuantum).issues.join(' ')).toContain('renderQuantumFrames must be a positive integer');

    const observedDifferentQuantum = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    ((observedDifferentQuantum.software as Record<string, unknown>).callback96kProfile as Record<string, unknown>).renderQuantumFrames = 96;
    expect(validateInstrumentGradeReport(observedDifferentQuantum).valid).toBe(true);
    expect(evaluateInstrumentGrade(observedDifferentQuantum as unknown as InstrumentGradeReport).callback96kChecks[0]?.status).toBe('pass');
  });

  it('rejects incomplete REC/PLAY/STOP/FX trigger coverage', () => {
    const report = passingReport();
    const raw = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    const metrics = raw.metrics as Record<string, unknown>;
    delete (metrics.triggerByAction as Record<string, unknown>).FX;
    expect(validateInstrumentGradeReport(raw).issues.join(' ')).toContain('report.metrics.triggerByAction.FX is required');
  });
});
