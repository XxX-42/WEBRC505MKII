import { spawnSync } from 'node:child_process';
import { RHYTHM_PATTERN_CATALOG, createRhythmRuntimeEventTemplate } from '../src/audio/rhythm';
import { getRhythmEventFrame } from '../src/audio/rhythm/timing';
import type { RhythmSection, RhythmVariation } from '../src/audio/rhythm/catalog';

const nativePath = process.env.NATIVE_RHYTHM_EVENT_DUMP;
if (!nativePath) {
  throw new Error('Set NATIVE_RHYTHM_EVENT_DUMP to the built native_rhythm_event_dump executable; refusing to skip Native event comparison');
}
const nativeRun = spawnSync(nativePath, [], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (nativeRun.error) throw nativeRun.error;
if (nativeRun.status !== 0) throw new Error(`Native event dumper exited ${nativeRun.status}: ${nativeRun.stderr}`);

interface RuntimeCase {
  scenario: number;
  pattern: number;
  variation: number;
  section: number;
  kit: number;
  bpm: number;
  sampleRate: number;
  bars: number;
  blockSize: number;
  startFrame: number;
}
interface Event { frame: number; instrument: string; velocity: number; seed: number }
const actual = new Map<string, Event[]>();
const keyFor = (item: RuntimeCase): string => [
  item.scenario, item.pattern, item.variation, item.section, item.kit,
  item.bpm.toFixed(6), item.sampleRate, item.bars, item.blockSize, item.startFrame,
].join('/');
const compareEvents = (left: Event, right: Event): number =>
  left.frame - right.frame || left.instrument.localeCompare(right.instrument) ||
  left.velocity - right.velocity || left.seed - right.seed;

for (const line of nativeRun.stdout.split(/\r?\n/)) {
  if (!line) continue;
  const [scenario, pattern, variation, section, kit, bpm, sampleRate, bars, blockSize, startFrame,
    frame, instrument, velocity, seed] = line.split('\t');
  if ([scenario, pattern, variation, section, kit, bpm, sampleRate, bars, blockSize, startFrame,
    frame, instrument, velocity, seed].some((field) => field === undefined)) {
    throw new Error(`Malformed Native event record: ${line}`);
  }
  const runtimeCase: RuntimeCase = {
    scenario: Number(scenario), pattern: Number(pattern), variation: Number(variation),
    section: Number(section), kit: Number(kit), bpm: Number(bpm), sampleRate: Number(sampleRate),
    bars: Number(bars), blockSize: Number(blockSize), startFrame: Number(startFrame),
  };
  if (!Number.isFinite(runtimeCase.bpm) || !Number.isSafeInteger(runtimeCase.startFrame)) {
    throw new Error(`Invalid Native event case metadata: ${line}`);
  }
  const key = keyFor(runtimeCase);
  const events = actual.get(key) ?? [];
  events.push({ frame: Number(frame), instrument, velocity: Number(velocity), seed: Number(seed) >>> 0 });
  actual.set(key, events);
}

const cases: RuntimeCase[] = [];
const addedCases = new Set<string>();
const addCase = (runtimeCase: RuntimeCase): void => {
  const key = keyFor(runtimeCase);
  if (addedCases.has(key)) throw new Error(`Duplicate comparison case: ${key}`);
  addedCases.add(key);
  cases.push(runtimeCase);
};
const variations = ['A', 'B', 'C', 'D'] as const;
const sections = ['main', 'intro', 'ending', 'fill'] as const;

// Complete matrix: all 240 catalog IDs × A-D × all four clean-room sections.
// A kit is held constant because kit choice affects synthetic timbre, not the
// Browser event-plan contract.
for (let pattern = 1; pattern <= RHYTHM_PATTERN_CATALOG.length; pattern += 1) {
  for (let variation = 0; variation < variations.length; variation += 1) {
    for (let section = 0; section < sections.length; section += 1) {
      addCase({ scenario: 0, pattern, variation, section, kit: 6, bpm: 300, sampleRate: 8000,
        bars: 1, blockSize: 128, startFrame: 0 });
    }
  }
}

// Representative-kit event parity for a metal pattern: the selected kit must
// not alter event identity, timing, velocity, or deterministic seed.
for (let variation = 0; variation < variations.length; variation += 1) {
  for (let section = 0; section < sections.length; section += 1) {
    for (const kit of [1, 6, 16]) {
      addCase({ scenario: 1, pattern: 155, variation, section, kit, bpm: 300, sampleRate: 8000,
        bars: 1, blockSize: 128, startFrame: 0 });
    }
  }
}

// Fractional tempo, 3/4, 5/8, 6/8, repeated bars, intro/fill/ending and
// different callback sizes exercise event-frame rounding at section/bar edges.
const boundaryCases = [
  [155, 1, 1, 13], [155, 1, 1, 1024],
  [155, 3, 3, 127], [155, 3, 3, 1024],
  [210, 3, 3, 64], [210, 3, 3, 1024],
  [12, 1, 0, 13], [12, 1, 0, 1024],
  [229, 2, 2, 127], [229, 2, 2, 1024],
  [22, 3, 3, 64], [22, 3, 3, 1024],
] as const;
for (const [pattern, variation, section, blockSize] of boundaryCases) {
  addCase({ scenario: 2, pattern, variation, section, kit: 6, bpm: 127.3, sampleRate: 44100,
    bars: 2, blockSize, startFrame: 0 });
}

// Change both section and tempo exactly at a bar boundary. Each segment is
// compared against a fresh Browser worklet configuration at its absolute frame.
const transitionSampleRate = 44100;
const firstTempo = 127.3;
const transitionPattern = RHYTHM_PATTERN_CATALOG[154]!;
const transitionFrame = Math.floor(
  transitionSampleRate * 60 / firstTempo * transitionPattern.meter.numerator * 4 / transitionPattern.meter.denominator + 0.5,
);
for (const blockSize of [13, 1024]) {
  addCase({ scenario: 3, pattern: 155, variation: 1, section: 1, kit: 6, bpm: firstTempo,
    sampleRate: transitionSampleRate, bars: 1, blockSize, startFrame: 0 });
  addCase({ scenario: 3, pattern: 155, variation: 1, section: 3, kit: 6, bpm: 139.7,
    sampleRate: transitionSampleRate, bars: 1, blockSize, startFrame: transitionFrame });
}

function expectedEvents(runtimeCase: RuntimeCase): Event[] {
  const metadata = RHYTHM_PATTERN_CATALOG[runtimeCase.pattern - 1];
  if (!metadata) throw new Error(`Missing Browser rhythm metadata for ${runtimeCase.pattern}`);
  const stepsPerBar = metadata.meter.numerator * (16 / metadata.meter.denominator);
  const template = createRhythmRuntimeEventTemplate(metadata, {
    sampleRate: runtimeCase.sampleRate,
    bpm: runtimeCase.bpm,
    bars: 1,
    variation: variations[runtimeCase.variation] as RhythmVariation,
    section: sections[runtimeCase.section] as RhythmSection,
  });
  const expected: Event[] = [];
  for (let bar = 0; bar < runtimeCase.bars; bar += 1) {
    for (const event of template) {
      expected.push({
        frame: getRhythmEventFrame(runtimeCase.startFrame, bar, event.step, stepsPerBar,
          runtimeCase.sampleRate, runtimeCase.bpm, 50, '1/16'),
        instrument: event.instrument,
        velocity: event.velocity,
        seed: (event.seed ^ Math.imul(bar + 1, 0x9e3779b1)) >>> 0,
      });
    }
  }
  return expected.sort(compareEvents);
}

let compared = 0;
let mismatchedCases = 0;
let mismatchEvents = 0;
const mismatchSummaries: string[] = [];
for (const runtimeCase of cases) {
  const key = keyFor(runtimeCase);
  const expected = expectedEvents(runtimeCase);
  const observed = [...(actual.get(key) ?? [])].sort(compareEvents);
  compared += 1;
  if (JSON.stringify(observed) === JSON.stringify(expected)) continue;
  mismatchedCases += 1;
  const max = Math.max(observed.length, expected.length);
  let caseMismatches = 0;
  for (let index = 0; index < max; index += 1) {
    if (JSON.stringify(observed[index]) !== JSON.stringify(expected[index])) caseMismatches += 1;
  }
  mismatchEvents += caseMismatches;
  if (mismatchSummaries.length < 24) {
    const firstDifferences: Array<{ index: number; native?: Event; browser?: Event }> = [];
    for (let index = 0; index < max && firstDifferences.length < 3; index += 1) {
      if (JSON.stringify(observed[index]) !== JSON.stringify(expected[index])) {
        firstDifferences.push({ index, native: observed[index], browser: expected[index] });
      }
    }
    mismatchSummaries.push(`${key}: Native ${observed.length}, Browser ${expected.length}, differing records ${caseMismatches}; first differences=${JSON.stringify(firstDifferences)}`);
  }
}

const unexpectedCases = [...actual.keys()].filter((key) => !addedCases.has(key));
if (unexpectedCases.length > 0) {
  mismatchedCases += unexpectedCases.length;
  if (mismatchSummaries.length < 24) mismatchSummaries.push(`Unexpected Native cases: ${unexpectedCases.slice(0, 24).join(', ')}`);
}

function assertBlockSizePairs(scenario: number): string[] {
  const errors: string[] = [];
  const groups = new Map<string, RuntimeCase[]>();
  for (const runtimeCase of cases.filter((item) => item.scenario === scenario)) {
    const groupKey = [runtimeCase.pattern, runtimeCase.variation, runtimeCase.section, runtimeCase.kit,
      runtimeCase.bpm.toFixed(6), runtimeCase.sampleRate, runtimeCase.bars, runtimeCase.startFrame].join('/');
    const group = groups.get(groupKey) ?? [];
    group.push(runtimeCase);
    groups.set(groupKey, group);
  }
  for (const [groupKey, group] of groups) {
    if (group.length < 2) continue;
    const signatures = group.map((runtimeCase) => JSON.stringify([...(actual.get(keyFor(runtimeCase)) ?? [])].sort(compareEvents)));
    if (signatures.some((signature) => signature !== signatures[0])) errors.push(groupKey);
  }
  return errors;
}
const blockSizeMismatchGroups = [...assertBlockSizePairs(2), ...assertBlockSizePairs(3)];
if (blockSizeMismatchGroups.length > 0) {
  mismatchedCases += blockSizeMismatchGroups.length;
  if (mismatchSummaries.length < 24) mismatchSummaries.push(`Block-size-dependent event plans: ${blockSizeMismatchGroups.slice(0, 24).join(', ')}`);
}

const report = {
  purpose: 'clean-room event-plan conformance only; not factory MIDI fidelity, kit PCM/timbre parity, or sound-quality acceptance',
  comparedCases: compared,
  caseCounts: {
    full240ByVariationAndSection: cases.filter((item) => item.scenario === 0).length,
    representativeKitVariants: cases.filter((item) => item.scenario === 1).length,
    fractionalTempoMeterAndBlockBoundaries: cases.filter((item) => item.scenario === 2).length,
    sectionAndTempoTransitions: cases.filter((item) => item.scenario === 3).length,
  },
  fullCatalogIds: RHYTHM_PATTERN_CATALOG.length,
  eventRecords: [...actual.values()].reduce((total, events) => total + events.length, 0),
  mismatchedCases,
  differingRecords: mismatchEvents,
  blockSizeMismatchGroups: blockSizeMismatchGroups.length,
  result: mismatchedCases === 0 ? 'PASS' : 'FAIL',
  examples: mismatchSummaries,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (mismatchedCases > 0) process.exitCode = 1;
