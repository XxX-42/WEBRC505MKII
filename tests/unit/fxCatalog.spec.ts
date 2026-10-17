import { describe, expect, it } from 'vitest';
import { FX_CATALOG, FX_CATALOG_AUDIT } from '../../src/audio/fx/catalog';

describe('53-effect catalog metadata', () => {
  it('contains 53 distinct effects with 49 Input and 53 Track assignments', () => {
    expect(FX_CATALOG).toHaveLength(53);
    expect(new Set(FX_CATALOG.map((effect) => effect.id)).size).toBe(53);
    expect(FX_CATALOG_AUDIT).toMatchObject({
      effectCount: 53,
      inputAvailableCount: 49,
      trackAvailableCount: 53,
    });
    expect(FX_CATALOG.every((effect) => effect.availability.track)).toBe(true);
  });

  it('marks exactly the four Track-only effects', () => {
    expect(FX_CATALOG_AUDIT.trackOnlyIds).toEqual([
      'beat-scatter',
      'beat-repeat',
      'beat-shift',
      'vinyl-flick',
    ]);

    const inputOnlyOrNeither = FX_CATALOG.filter((effect) => !effect.availability.input);
    expect(inputOnlyOrNeither.map((effect) => effect.displayName)).toEqual([
      'BEAT SCATTER',
      'BEAT REPEAT',
      'BEAT SHIFT',
      'VINYL FLICK',
    ]);
  });

  it('provides unique parameters and an honest wired-versus-catalogued implementation matrix', () => {
    const parameters = FX_CATALOG.flatMap((effect) => effect.parameters);
    const parameterIds = parameters.map((parameter) => parameter.id);

    expect(parameters.length).toBeGreaterThan(0);
    expect(new Set(parameterIds).size).toBe(parameterIds.length);
    expect(FX_CATALOG.every((effect) => effect.parameters.length > 0)).toBe(true);

    for (const effect of FX_CATALOG) {
      expect(effect.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(effect.family.length).toBeGreaterThan(0);
      expect(effect.algorithm.formulaIds.length).toBeGreaterThan(0);
      expect(effect.evidence.source).toBe('data/fx_algorithm_matrix.csv');
      expect(effect.evidence.methodology).toBe('clean-room-reconstruction');
      expect(effect.latencyNote.length).toBeGreaterThan(0);
      if (effect.implementationStatus === 'implemented') {
        expect(effect.runtimeSupport).toBe('wired');
        expect(effect.runtimeImplementations?.length).toBeGreaterThan(0);
      } else if (effect.implementationStatus === 'experimental') {
        expect(effect.runtimeSupport).toBe('experimental');
        expect(effect.runtimeImplementations?.length).toBeGreaterThan(0);
      } else {
        expect(effect.runtimeSupport).toBe('not-wired');
        expect(effect.runtimeImplementations).toBeUndefined();
      }

      for (const parameter of effect.parameters) {
        expect(parameter.id).toBe(`${effect.id}.${parameter.key}`);
        expect(parameter.range.min).toBeLessThan(parameter.range.max);
        expect(parameter.defaultValue).toBeGreaterThanOrEqual(parameter.range.min);
        expect(parameter.defaultValue).toBeLessThanOrEqual(parameter.range.max);
        expect(parameter.rangeBasis).toBe('provisional-clean-room-default');
        if (parameter.options) {
          expect(parameter.options.length).toBeGreaterThan(1);
          for (const option of parameter.options) {
            expect(option.value).toBeGreaterThanOrEqual(parameter.range.min);
            expect(option.value).toBeLessThanOrEqual(parameter.range.max);
          }
        }
      }
    }

    expect(FX_CATALOG_AUDIT.parameterCount).toBe(parameters.length);
    expect(FX_CATALOG.filter((effect) => effect.implementationStatus === 'implemented').map((effect) => effect.id).sort())
      .toEqual(['auto-pan', 'beat-repeat', 'beat-scatter', 'bpf', 'chorus', 'delay', 'dist', 'dynamics', 'electric', 'eq', 'flanger', 'freeze', 'g2b', 'gate-reverb', 'granular-delay', 'hpf', 'hrm-manual', 'isolator', 'lo-fi', 'lpf', 'manual-pan', 'mod-delay', 'octave', 'osc-bot', 'osc-voc-m', 'panning-delay', 'pattern-slicer', 'phaser', 'pitch-bend', 'preamp', 'radio', 'reverb', 'reverse-delay', 'ring-mod', 'roll', 'slow-gear', 'step-slicer', 'stereo-enhance', 'sustainer', 'synth', 'tape-echo', 'transpose', 'tremolo', 'twist', 'vibrato', 'vocoder']);
    expect(FX_CATALOG_AUDIT.implementationStatusCounts).toEqual({ catalogued: 0, implemented: 46, experimental: 7 });
    expect(FX_CATALOG_AUDIT.runtimeImplementationCounts).toEqual({
      browser: 46,
      native: 46,
      browserInput: 44,
      browserTrack: 46,
      nativeInput: 43,
      nativeTrack: 46,
    });
    expect(FX_CATALOG_AUDIT.experimentalRuntimeImplementationCounts).toEqual({
      browser: 7,
      native: 6,
      browserInput: 5,
      browserTrack: 7,
      nativeInput: 5,
      nativeTrack: 6,
    });
    expect(FX_CATALOG.filter((effect) => effect.runtimeImplementations?.some((item) => item.runtime === 'native'))
      .map((effect) => effect.id).sort())
      .toEqual([
        'auto-pan', 'auto-riff', 'beat-repeat', 'beat-scatter', 'bpf', 'chorus', 'delay', 'dist', 'dynamics', 'electric', 'eq', 'flanger',
        'freeze', 'g2b', 'gate-reverb', 'granular-delay', 'hpf', 'hrm-auto-m', 'hrm-manual', 'isolator', 'lo-fi', 'lpf', 'manual-pan', 'mod-delay', 'octave',
        'osc-bot', 'osc-voc-m', 'panning-delay', 'pattern-slicer', 'phaser', 'pitch-bend', 'preamp', 'radio', 'reverb', 'reverse-delay', 'reverse-reverb', 'ring-mod',
        'robot', 'roll', 'slow-gear', 'step-slicer', 'stereo-enhance', 'sustainer', 'synth', 'tape-echo',
        'transpose', 'tremolo', 'twist', 'vibrato', 'vinyl-flick', 'vocoder', 'warp',
      ]);

    const warp = FX_CATALOG.find((effect) => effect.id === 'warp');
    expect(warp).toMatchObject({
      sourceIndex: 42,
      availability: { input: true, track: true },
      implementationStatus: 'experimental',
      runtimeSupport: 'experimental',
      algorithm: {
        nativeBalancedChoice: 'Granular freeze + FDN8 feedback; spectral mode high tier only',
        browserBalancedChoice: 'Spectral/granular freeze + FDN-like feedback macro',
        formulaIds: ['F12', 'F15', 'F17', 'F19', 'F20'],
      },
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(warp?.evidence.classification).toBe('explicit-perceptual-inference');
    expect(warp?.implementationNote).toContain('spectral mode is unsupported');
    expect(warp?.implementationNote).toContain('sound-quality acceptance claim');
    expect(warp?.parameters.map(({ key }) => key)).toEqual(['capture', 'smear', 'pitch', 'feedback', 'freeze', 'mix']);

    for (const effect of FX_CATALOG) {
      const implementations = effect.runtimeImplementations ?? [];
      const routeKeys = implementations.map(({ runtime, target }) => `${runtime}:${target}`);
      expect(new Set(routeKeys).size).toBe(routeKeys.length);
      for (const { runtime, target } of implementations) {
        if (target === 'input-bank-slot') expect(effect.availability.input).toBe(true);
        if (target === 'track-bank-slot') expect(effect.availability.track).toBe(true);
        expect(runtime).toMatch(/^(browser|native)$/);
      }
    }

    const twist = FX_CATALOG.find((effect) => effect.id === 'twist');
    expect(twist).toMatchObject({
      sourceIndex: 43,
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(twist?.parameters.map((parameter) => parameter.id)).toEqual([
      'twist.amount', 'twist.trajectory', 'twist.mix',
    ]);

    const beatRepeat = FX_CATALOG.find((effect) => effect.id === 'beat-repeat');
    expect(beatRepeat).toMatchObject({
      availability: { input: false, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(beatRepeat?.parameters.map((parameter) => parameter.id)).toEqual([
      'beat-repeat.division', 'beat-repeat.decay', 'beat-repeat.direction', 'beat-repeat.mix',
    ]);
    expect(beatRepeat?.parameters.map(({ key, range, defaultValue }) => ({ key, range, defaultValue }))).toEqual([
      { key: 'division', range: { min: 0.25, max: 4 }, defaultValue: 0.5 },
      { key: 'decay', range: { min: 0, max: 100 }, defaultValue: 15 },
      { key: 'direction', range: { min: 0, max: 2 }, defaultValue: 0 },
      { key: 'mix', range: { min: 0, max: 100 }, defaultValue: 50 },
    ]);

    const vinylFlick = FX_CATALOG.find((effect) => effect.id === 'vinyl-flick');
    expect(vinylFlick).toMatchObject({
      sourceIndex: 53,
      availability: { input: false, track: true },
      implementationStatus: 'experimental',
      runtimeSupport: 'experimental',
      runtimeImplementations: [
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(vinylFlick?.implementationNote).toContain('not quality-accepted');
    expect(vinylFlick?.implementationNote).toContain('source-aware per-loop read-head access');
    expect(vinylFlick?.latencyNote).toContain('Native 3 frames; Browser 2 frames');
    expect(vinylFlick?.parameters.map(({ key }) => key)).toEqual(['speed', 'return-time', 'brake', 'mix']);

    const robot = FX_CATALOG.find((effect) => effect.id === 'robot');
    expect(robot).toMatchObject({
      sourceIndex: 16,
      availability: { input: true, track: true },
      implementationStatus: 'experimental',
      runtimeSupport: 'experimental',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(robot?.implementationNote).toContain('Fixed-period PSOLA');
    expect(robot?.implementationNote).toContain('not implemented');
    expect(robot?.implementationNote).toContain('no summed end-to-end latency');

    const reverseDelay = FX_CATALOG.find((effect) => effect.id === 'reverse-delay');
    expect(reverseDelay).toMatchObject({
      sourceIndex: 38,
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(reverseDelay?.latencyNote).toContain('fixed 100 ms wet lookahead');
    expect(reverseDelay?.implementationNote).toContain('does not imply per-loop-track targeting');
    expect(reverseDelay?.parameters.map(({ key }) => key)).toEqual(['time', 'feedback', 'crossfade', 'mix']);

    const patternSlicer = FX_CATALOG.find((effect) => effect.id === 'pattern-slicer');
    expect(patternSlicer).toMatchObject({
      sourceIndex: 34,
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(patternSlicer?.implementationNote).toContain('Native Input/Track A–D');

    const stepSlicer = FX_CATALOG.find((effect) => effect.id === 'step-slicer');
    expect(stepSlicer).toMatchObject({
      sourceIndex: 35,
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(stepSlicer?.implementationNote).toContain('sound-quality acceptance are not claimed');

    const beatShift = FX_CATALOG.find((effect) => effect.id === 'beat-shift');
    expect(beatShift).toMatchObject({
      availability: { input: false, track: true },
      implementationStatus: 'experimental',
      runtimeSupport: 'experimental',
      runtimeImplementations: [{ runtime: 'browser', target: 'track-bank-slot' }],
    });
    expect(beatShift?.implementationNote).toContain('not quality-accepted');
    expect(beatShift?.implementationNote).toContain('Loop-playback read-head integration');
    expect(beatShift?.parameters.map((parameter) => parameter.id)).toEqual([
      'beat-shift.offset', 'beat-shift.crossfade',
    ]);

    const gateReverb = FX_CATALOG.find((effect) => effect.id === 'gate-reverb');
    expect(gateReverb).toMatchObject({
      sourceIndex: 48,
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
      latencyNote: 'As reverb',
    });

    const reverseReverb = FX_CATALOG.find((effect) => effect.id === 'reverse-reverb');
    expect(reverseReverb).toMatchObject({
      sourceIndex: 49,
      availability: { input: true, track: true },
      implementationStatus: 'experimental',
      runtimeSupport: 'experimental',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(reverseReverb?.implementationNote).toContain('not sound-quality acceptance');

    const freeze = FX_CATALOG.find((effect) => effect.id === 'freeze');
    expect(freeze).toMatchObject({
      sourceIndex: 45,
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(freeze?.implementationNote).toContain('Only clean-room micro-loop mode is implemented');
    expect(freeze?.implementationNote).toContain('spectral/STFT mode is explicitly rejected');
    expect(freeze?.implementationNote).toContain('sound-quality admission are not yet accepted or measured');

    const beatScatter = FX_CATALOG.find((effect) => effect.id === 'beat-scatter');
    expect(beatScatter).toMatchObject({
      sourceIndex: 50,
      availability: { input: false, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });

    const isolator = FX_CATALOG.find((effect) => effect.id === 'isolator');
    expect(isolator).toMatchObject({
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(beatScatter?.parameters.map(({ key, range, defaultValue }) => ({ key, range, defaultValue }))).toEqual([
      { key: 'slice', range: { min: 0.25, max: 4 }, defaultValue: 0.25 },
      { key: 'scatter', range: { min: 0, max: 100 }, defaultValue: 50 },
      { key: 'pitch', range: { min: -24, max: 24 }, defaultValue: 0 },
      { key: 'repeats', range: { min: 1, max: 16 }, defaultValue: 4 },
      { key: 'mix', range: { min: 0, max: 100 }, defaultValue: 50 },
    ]);
    expect(isolator?.parameters.map((parameter) => parameter.key)).toEqual([
      'low', 'mid', 'high', 'gate-rate', 'gate-depth',
    ]);

    const stereoEnhance = FX_CATALOG.find((effect) => effect.id === 'stereo-enhance');
    expect(stereoEnhance).toMatchObject({
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(stereoEnhance?.parameters.map((parameter) => parameter.key)).toEqual([
      'width', 'low-mono-cutoff', 'decorrelation', 'mix',
    ]);

    const loFi = FX_CATALOG.find((effect) => effect.id === 'lo-fi');
    expect(loFi).toMatchObject({
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(loFi?.parameters.map((parameter) => parameter.key)).toEqual(['bit-depth', 'sample-rate', 'filter', 'mix']);

    const eq = FX_CATALOG.find((effect) => effect.id === 'eq');
    expect(eq).toMatchObject({
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(eq?.parameters.map((parameter) => parameter.key)).toEqual([
      'low-frequency', 'low-gain', 'mid-1-frequency', 'mid-1-q', 'mid-1-gain',
      'mid-2-frequency', 'mid-2-q', 'mid-2-gain', 'high-frequency', 'high-gain',
    ]);

    const manualPan = FX_CATALOG.find((effect) => effect.id === 'manual-pan');
    expect(manualPan).toMatchObject({
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(manualPan?.parameters.map((parameter) => parameter.key)).toEqual(['position']);

    const tapeEcho = FX_CATALOG.find((effect) => effect.id === 'tape-echo');
    expect(tapeEcho).toMatchObject({
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(tapeEcho?.parameters.map((parameter) => parameter.key)).toEqual([
      'time', 'feedback', 'wow', 'saturation', 'tone', 'mix',
    ]);

    const granularDelay = FX_CATALOG.find((effect) => effect.id === 'granular-delay');
    expect(granularDelay).toMatchObject({
      sourceIndex: 41,
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(granularDelay?.parameters.map((parameter) => parameter.key)).toEqual([
      'grain-size', 'density', 'pitch', 'jitter', 'feedback', 'mix',
    ]);

    const radio = FX_CATALOG.find((effect) => effect.id === 'radio');
    expect(radio).toMatchObject({
      sourceIndex: 8,
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(radio?.parameters.map((parameter) => parameter.key)).toEqual(['band', 'drive', 'noise', 'mix']);

    const vibrato = FX_CATALOG.find((effect) => effect.id === 'vibrato');
    expect(vibrato).toMatchObject({
      sourceIndex: 33,
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(vibrato?.parameters.map((parameter) => parameter.key)).toEqual(['rate', 'depth', 'delay', 'mix']);

    const slowGear = FX_CATALOG.find((effect) => effect.id === 'slow-gear');
    expect(slowGear).toMatchObject({
      sourceIndex: 13,
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      latencyNote: '0 samples; attack is intentional',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(slowGear?.parameters.map(({ key, range, defaultValue, curve }) => ({ key, range, defaultValue, curve }))).toEqual([
      { key: 'attack', range: { min: 5, max: 2000 }, defaultValue: 250, curve: 'logarithmic' },
      { key: 'sensitivity', range: { min: 0, max: 100 }, defaultValue: 50, curve: 'linear' },
      { key: 'mix', range: { min: 0, max: 100 }, defaultValue: 100, curve: 'linear' },
    ]);

    const sustainer = FX_CATALOG.find((effect) => effect.id === 'sustainer');
    expect(sustainer).toMatchObject({
      sourceIndex: 11,
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(sustainer?.parameters.map(({ key, range, defaultValue }) => ({ key, range, defaultValue }))).toEqual([
      { key: 'threshold', range: { min: -60, max: 0 }, defaultValue: -24 },
      { key: 'ratio', range: { min: 1, max: 20 }, defaultValue: 4 },
      { key: 'release', range: { min: 10, max: 1000 }, defaultValue: 180 },
      { key: 'output', range: { min: -24, max: 12 }, defaultValue: 0 },
    ]);

    const panningDelay = FX_CATALOG.find((effect) => effect.id === 'panning-delay');
    expect(panningDelay).toMatchObject({
      sourceIndex: 37,
      availability: { input: true, track: true },
      implementationStatus: 'implemented',
      runtimeSupport: 'wired',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });

    const autoRiff = FX_CATALOG.find((effect) => effect.id === 'auto-riff');
    expect(autoRiff).toMatchObject({
      sourceIndex: 12,
      availability: { input: true, track: true },
      implementationStatus: 'experimental',
      runtimeSupport: 'experimental',
      runtimeImplementations: [
        { runtime: 'browser', target: 'input-bank-slot' },
        { runtime: 'browser', target: 'track-bank-slot' },
        { runtime: 'native', target: 'input-bank-slot' },
        { runtime: 'native', target: 'track-bank-slot' },
      ],
    });
    expect(autoRiff?.parameters.map(({ key, defaultValue }) => ({ key, defaultValue }))).toEqual([
      { key: 'scale', defaultValue: 0 },
      { key: 'rate', defaultValue: 0.5 },
      { key: 'sensitivity', defaultValue: 55 },
      { key: 'mix', defaultValue: 65 },
    ]);
    expect(autoRiff?.implementationNote).toContain('remain unvalidated for acceptance');
  });
});
