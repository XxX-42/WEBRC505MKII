import { describe, expect, it } from 'vitest';
import { Transport } from '../../src/core/Transport';
import type { NativeStatus } from '../../src/audio/NativeBridgeClient';
import {
  nativeCatalogEffectId,
  nativeCatalogFxOptions,
  nativeCatalogMacroParameters,
  nativeCatalogSlotConfig,
} from '../../src/audio/nativeFxCatalog';

describe('Native WARP catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['warp'],
      catalogEffectAvailability: [{ effectId: 'warp', sourceIndex: 42, input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('advertises the explicitly experimental clean-room processor on Native Input and Track A–D banks', () => {
    expect(nativeCatalogEffectId('WARP (EXPERIMENTAL)')).toBe('warp');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('WARP (EXPERIMENTAL)');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('WARP (EXPERIMENTAL)');
  });

  it('maps the generic mix control while retaining tempo, capture, smear, pitch and freeze controls', () => {
    const parameters = nativeCatalogMacroParameters('WARP (EXPERIMENTAL)', 75);
    expect(parameters).toMatchObject({
      bpm: expect.any(Number), capture_beats: 1, smear_percent: 30,
      pitch_semitones: 0, feedback_percent: 20, freeze: 0, mix_percent: 75,
    });
    expect(nativeCatalogSlotConfig('track', 3, {
      type: 'WARP (EXPERIMENTAL)', value: 50, active: true,
      parameters: { bpm: 140, capture_beats: 0.5, smear_percent: 65, pitch_semitones: -4, feedback_percent: 40, freeze: 1 },
    })).toMatchObject({
      path: 'track', slot: 'D', effectId: 'warp', bypassed: false,
      parameters: { bpm: 140, capture_beats: 0.5, smear_percent: 65, pitch_semitones: -4, feedback_percent: 40, freeze: 1 },
    });
  });
});

describe('Native TWIST catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['twist'],
      catalogEffectAvailability: [{ effectId: 'twist', sourceIndex: 43, input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('advertises the real processor on both Native Input and shared Track banks', () => {
    expect(nativeCatalogEffectId('TWIST')).toBe('twist');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('TWIST');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('TWIST');
  });

  it('maps the generic amount knob to signed macro endpoints and preserves named trajectory/mix controls', () => {
    expect(nativeCatalogMacroParameters('TWIST', 0)).toEqual({ amount_percent: -100 });
    expect(nativeCatalogMacroParameters('TWIST', 50)).toEqual({ amount_percent: 0 });
    expect(nativeCatalogMacroParameters('TWIST', 100)).toEqual({ amount_percent: 100 });
    expect(nativeCatalogSlotConfig('track', 3, {
      type: 'TWIST', value: 75, active: true,
      parameters: { amount_percent: 25, trajectory: 2, mix_percent: 80 },
    })).toEqual({
      path: 'track', slot: 'D', effectId: 'twist',
      parameters: { amount_percent: 25, trajectory: 2, mix_percent: 80 }, bypassed: false,
    });
  });
});

describe('Native TRANSPOSE catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['transpose'],
      catalogEffectAvailability: [{ effectId: 'transpose', sourceIndex: 14, input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes the real Signalsmith processor on Input and Track paths', () => {
    expect(nativeCatalogEffectId('TRANSPOSE')).toBe('transpose');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('TRANSPOSE');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('TRANSPOSE');
  });

  it('maps the generic panel amount to the full bipolar semitone range', () => {
    expect(nativeCatalogMacroParameters('TRANSPOSE', 0)).toEqual({ shift_semitones: -24, mix_percent: 100 });
    expect(nativeCatalogMacroParameters('TRANSPOSE', 50)).toEqual({ shift_semitones: 0, mix_percent: 100 });
    expect(nativeCatalogMacroParameters('TRANSPOSE', 100)).toEqual({ shift_semitones: 24, mix_percent: 100 });
    expect(nativeCatalogSlotConfig('input', 3, { type: 'TRANSPOSE', value: 50, active: true })).toEqual({
      path: 'input', slot: 'D', effectId: 'transpose',
      parameters: { shift_semitones: 0, mix_percent: 100 }, bypassed: false,
    });
  });
});

describe('Native PITCH BEND catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['pitch_bend'],
      catalogEffectAvailability: [{ effectId: 'pitch_bend', sourceIndex: 15, input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes the Native PITCH BEND processor on Input and Track A–D banks', () => {
    expect(nativeCatalogEffectId('PITCH BEND')).toBe('pitch_bend');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('PITCH BEND');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('PITCH BEND');
  });

  it('maps the range macro and preserves named sweep controls in a selected slot', () => {
    expect(nativeCatalogMacroParameters('PITCH BEND', 0)).toEqual({ range: 0, time_ms: 500, direction: 0, mix_percent: 100 });
    expect(nativeCatalogMacroParameters('PITCH BEND', 50)).toEqual({ range: 12, time_ms: 500, direction: 0, mix_percent: 100 });
    expect(nativeCatalogMacroParameters('PITCH BEND', 100)).toEqual({ range: 24, time_ms: 500, direction: 0, mix_percent: 100 });
    expect(nativeCatalogSlotConfig('track', 3, {
      type: 'PITCH BEND', value: 50, active: true,
      parameters: { range: 8, time_ms: 1200, direction: 1, mix_percent: 75 },
    })).toEqual({
      path: 'track', slot: 'D', effectId: 'pitch_bend',
      parameters: { range: 8, time_ms: 1200, direction: 1, mix_percent: 75 }, bypassed: false,
    });
  });
});

describe('Native HRM MANUAL catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['hrm_manual'],
      catalogEffectAvailability: [{ effectId: 'hrm_manual', sourceIndex: 18, input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes the two-voice processor on Native Input and Track A–D banks', () => {
    expect(nativeCatalogEffectId('HRM MANUAL')).toBe('hrm_manual');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('HRM MANUAL');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('HRM MANUAL');
  });

  it('maps the generic macro to additive harmony mix and preserves all four named controls', () => {
    expect(nativeCatalogMacroParameters('HRM MANUAL', 35)).toEqual({
      voice_1_interval: 7, voice_2_interval: 12, pan_percent: 0, mix_percent: 35,
    });
    expect(nativeCatalogSlotConfig('input', 0, {
      type: 'HRM MANUAL', value: 70, active: true,
      parameters: { voice_1_interval: -7, voice_2_interval: 5, pan_percent: -40, mix_percent: 55 },
    })).toEqual({
      path: 'input', slot: 'A', effectId: 'hrm_manual',
      parameters: { voice_1_interval: -7, voice_2_interval: 5, pan_percent: -40, mix_percent: 55 },
      bypassed: false,
    });
  });
});

describe('Native OCTAVE catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['octave'],
      catalogEffectAvailability: [{ effectId: 'octave', sourceIndex: 28, input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes the three-voice processor on Native Input and Track A–D banks', () => {
    expect(nativeCatalogEffectId('OCTAVE')).toBe('octave');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('OCTAVE');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('OCTAVE');
  });

  it('maps the generic macro to harmony mix and preserves independent voice levels', () => {
    expect(nativeCatalogMacroParameters('OCTAVE', 35)).toEqual({
      minus_24_level: 0, minus_12_level: 40, plus_12_level: 0, mix_percent: 35,
    });
    expect(nativeCatalogSlotConfig('track', 1, {
      type: 'OCTAVE', value: 70, active: true,
      parameters: { minus_24_level: 20, minus_12_level: 40, plus_12_level: 65, mix_percent: 80 },
    })).toEqual({
      path: 'track', slot: 'B', effectId: 'octave',
      parameters: { minus_24_level: 20, minus_12_level: 40, plus_12_level: 65, mix_percent: 80 },
      bypassed: false,
    });
  });
});

describe('Native VOCODER catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['vocoder'],
      catalogEffectAvailability: [{ effectId: 'vocoder', sourceIndex: 20, input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes the real filterbank processor on Native Input and Track A–D banks', () => {
    expect(nativeCatalogEffectId('VOCODER')).toBe('vocoder');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('VOCODER');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('VOCODER');
  });

  it('maps the generic amount to wet mix and preserves bands/carrier settings', () => {
    expect(nativeCatalogMacroParameters('VOCODER', 35)).toEqual({
      bands: 16, carrier: 1, mix_percent: 35,
    });
    expect(nativeCatalogSlotConfig('track', 1, {
      type: 'VOCODER', value: 70, active: true,
      parameters: { bands: 12, carrier: 2, mix_percent: 80 },
    })).toEqual({
      path: 'track', slot: 'B', effectId: 'vocoder',
      parameters: { bands: 12, carrier: 2, mix_percent: 80 }, bypassed: false,
    });
  });
});

describe('Native SLOW GEAR catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['slow_gear'],
      catalogEffectAvailability: [{ effectId: 'slow_gear', input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes the implemented effect on its real Input and Track paths', () => {
    expect(nativeCatalogEffectId('SLOW GEAR')).toBe('slow_gear');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('SLOW GEAR');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('SLOW GEAR');
  });

  it('maps the panel amount to the provisional controls and slot D', () => {
    expect(nativeCatalogMacroParameters('SLOW GEAR', 50)).toEqual({
      attack_ms: 100,
      sensitivity_percent: 50,
      mix_percent: 100,
    });
    expect(nativeCatalogSlotConfig('track', 3, { type: 'SLOW GEAR', value: 50, active: true })).toEqual({
      path: 'track',
      slot: 'D',
      effectId: 'slow_gear',
      parameters: { attack_ms: 100, sensitivity_percent: 50, mix_percent: 100 },
      bypassed: false,
    });
  });
});

describe('Native PATTERN SLICER catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['pattern_slicer'],
      catalogEffectAvailability: [{ effectId: 'pattern_slicer', sourceIndex: 34, input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes the clean-room processor on Native Input and Track paths', () => {
    expect(nativeCatalogEffectId('PATTERN SLICER')).toBe('pattern_slicer');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('PATTERN SLICER');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('PATTERN SLICER');
    expect(status.nativeFx?.catalogEffectAvailability?.[0]?.sourceIndex).toBe(34);
  });

  it('maps the panel amount to depth and supplies the current transport tempo', () => {
    expect(nativeCatalogMacroParameters('PATTERN SLICER', 65)).toEqual({
      bpm: 120,
      pattern: 0,
      rate: 0.25,
      depth: 65,
      edge_ms: 2,
    });
    expect(nativeCatalogSlotConfig('input', 2, { type: 'PATTERN SLICER', value: 65, active: true })).toEqual({
      path: 'input',
      slot: 'C',
      effectId: 'pattern_slicer',
      parameters: { bpm: 120, pattern: 0, rate: 0.25, depth: 65, edge_ms: 2 },
      bypassed: false,
    });
  });
});

describe('Native GATE REVERB catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['gate_reverb'],
      catalogEffectAvailability: [{ effectId: 'gate_reverb', input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes the effect only after the host reports an implementation and each supported path', () => {
    expect(nativeCatalogEffectId('GATE REVERB')).toBe('gate_reverb');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('GATE REVERB');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('GATE REVERB');
    expect(nativeCatalogFxOptions({ nativeFx: { catalogGraphAvailable: true, implementedCatalogEffects: [], catalogEffectAvailability: [{ effectId: 'gate_reverb', input: true, track: true }] } } as unknown as NativeStatus, 'track')).not.toContain('GATE REVERB');
  });

  it('maps the panel amount to the wet return and preserves the selected A-D host slot', () => {
    expect(nativeCatalogMacroParameters('GATE REVERB', 50)).toEqual({ wet_mix: 0.5 });
    expect(nativeCatalogSlotConfig('track', 3, { type: 'GATE REVERB', value: 50, active: true })).toEqual({
      path: 'track',
      slot: 'D',
      effectId: 'gate_reverb',
      parameters: { wet_mix: 0.5 },
      bypassed: false,
    });
  });
});

describe('Native MOD DELAY catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['mod_delay'],
      catalogEffectAvailability: [{ effectId: 'mod_delay', input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('resolves the Native label and exposes the implemented Input and Track paths', () => {
    expect(nativeCatalogEffectId('MOD DELAY')).toBe('mod_delay');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('MOD DELAY');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('MOD DELAY');
  });

  it('maps the panel amount to wet mix and preserves slot routing', () => {
    const parameters = { wet_mix: 0.5 };
    const mappedParameters = nativeCatalogMacroParameters('MOD DELAY', 50);
    expect(mappedParameters).toEqual(parameters);
    expect(nativeCatalogSlotConfig('input', 2, { type: 'MOD DELAY', value: 50, active: true })).toEqual({
      path: 'input',
      slot: 'C',
      effectId: 'mod_delay',
      parameters: mappedParameters,
      bypassed: false,
    });
  });
});

describe('Native REVERSE DELAY catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['reverse_delay'],
      catalogEffectAvailability: [{ effectId: 'reverse_delay', input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes the implemented effect on Native Input and Track paths', () => {
    expect(nativeCatalogEffectId('REVERSE DELAY')).toBe('reverse_delay');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('REVERSE DELAY');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('REVERSE DELAY');
  });

  it('maps the panel amount to bounded controls and uses the shared sample-clock tempo', () => {
    const transport = Transport.getInstance();
    const originalBpm = transport.bpm;
    try {
      transport.bpm = 150;
      const parameters = {
        bpm: 150,
        segment_beats: 1,
        feedback_percent: 20,
        crossfade_ms: 20,
        mix_percent: 65,
      };
      expect(nativeCatalogMacroParameters('REVERSE DELAY', 65)).toEqual(parameters);
      expect(nativeCatalogSlotConfig('input', 0, { type: 'REVERSE DELAY', value: 65, active: true })).toEqual({
        path: 'input',
        slot: 'A',
        effectId: 'reverse_delay',
        parameters,
        bypassed: false,
      });

      transport.bpm = 500;
      expect(nativeCatalogMacroParameters('REVERSE DELAY', 65).bpm).toBe(300);
      transport.bpm = Number.NaN;
      expect(nativeCatalogMacroParameters('REVERSE DELAY', 65).bpm).toBe(120);
    } finally {
      transport.bpm = originalBpm;
    }
  });
});

describe('Native BEAT SCATTER catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['beat_scatter'],
      catalogEffectAvailability: [{ effectId: 'beat_scatter', input: false, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes the clean-room effect only on the shared Track bank', () => {
    expect(nativeCatalogEffectId('BEAT SCATTER')).toBe('beat_scatter');
    expect(nativeCatalogFxOptions(status, 'input')).not.toContain('BEAT SCATTER');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('BEAT SCATTER');
  });

  it('maps the generic amount control to mix only and keeps the Browser-compatible control names', () => {
    expect(nativeCatalogMacroParameters('BEAT SCATTER', 50)).toEqual({ bpm: 120, mix_percent: 50 });
    expect(nativeCatalogSlotConfig('track', 2, { type: 'BEAT SCATTER', value: 50, active: true })).toEqual({
      path: 'track',
      slot: 'C',
      effectId: 'beat_scatter',
      parameters: { bpm: 120, mix_percent: 50 },
      bypassed: false,
    });
  });

  it('tracks the shared tempo within the Browser DSP BPM bounds', () => {
    const transport = Transport.getInstance();
    const originalBpm = transport.bpm;
    try {
      transport.bpm = 196;
      expect(nativeCatalogMacroParameters('BEAT SCATTER', 50).bpm).toBe(196);
      transport.bpm = 500;
      expect(nativeCatalogMacroParameters('BEAT SCATTER', 50).bpm).toBe(300);
      transport.bpm = Number.NaN;
      expect(nativeCatalogMacroParameters('BEAT SCATTER', 50).bpm).toBe(120);
    } finally {
      transport.bpm = originalBpm;
    }
  });
});

describe('Native ROLL catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['roll'],
      catalogEffectAvailability: [{ effectId: 'roll', input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes ROLL on both Native Input and Track banks', () => {
    expect(nativeCatalogEffectId('ROLL')).toBe('roll');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('ROLL');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('ROLL');
  });

  it('maps the macro and shared tempo, while named per-slot controls override defaults', () => {
    const transport = Transport.getInstance();
    const originalBpm = transport.bpm;
    try {
      transport.bpm = 90;
      const parameters = {
        bpm: 90, slice_beats: 0.5, decay_percent: 20, pitch_semitones: 0, direction: 0, mix_percent: 65,
      };
      expect(nativeCatalogMacroParameters('ROLL', 65)).toEqual(parameters);
      expect(nativeCatalogSlotConfig('track', 3, {
        type: 'ROLL', value: 65, active: true,
        parameters: { slice_beats: 1, decay_percent: 42, pitch_semitones: -12, direction: 2 },
      })).toEqual({
        path: 'track', slot: 'D', effectId: 'roll',
        parameters: { ...parameters, slice_beats: 1, decay_percent: 42, pitch_semitones: -12, direction: 2 },
        bypassed: false,
      });
      transport.bpm = 500;
      expect(nativeCatalogMacroParameters('ROLL', 65).bpm).toBe(300);
      transport.bpm = Number.NaN;
      expect(nativeCatalogMacroParameters('ROLL', 65).bpm).toBe(120);
    } finally {
      transport.bpm = originalBpm;
    }
  });
});

describe('Native VINYL FLICK catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['vinyl_flick'],
      catalogEffectAvailability: [{ effectId: 'vinyl_flick', sourceIndex: 53, input: false, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes the processor only on Native Track A–D', () => {
    expect(nativeCatalogEffectId('VINYL FLICK (EXPERIMENTAL)')).toBe('vinyl_flick');
    expect(nativeCatalogEffectId('VINYL FLICK')).toBe('vinyl_flick');
    expect(nativeCatalogFxOptions(status, 'input')).not.toContain('VINYL FLICK (EXPERIMENTAL)');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('VINYL FLICK (EXPERIMENTAL)');
    expect(status.nativeFx?.catalogEffectAvailability?.[0]?.sourceIndex).toBe(53);
  });

  it('maps the generic amount to centered speed, motor recovery, friction, and mix', () => {
    const parameters = {
      speed_percent: 0,
      motor_return_seconds: 1.5,
      brake_percent: 35,
      mix_percent: 50,
    };
    expect(nativeCatalogMacroParameters('VINYL FLICK (EXPERIMENTAL)', 50)).toEqual(parameters);
    expect(nativeCatalogSlotConfig('track', 3, { type: 'VINYL FLICK (EXPERIMENTAL)', value: 50, active: true })).toEqual({
      path: 'track',
      slot: 'D',
      effectId: 'vinyl_flick',
      parameters,
      bypassed: false,
    });
    expect(nativeCatalogMacroParameters('VINYL FLICK (EXPERIMENTAL)', 0)).toEqual({
      speed_percent: -100,
      motor_return_seconds: 1.5,
      brake_percent: 35,
      mix_percent: 0,
    });
  });
});

describe('Native MANUAL PAN catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['manual_pan'],
      catalogEffectAvailability: [{ effectId: 'manual_pan', input: false, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes MANUAL PAN only on the Native Track bank', () => {
    expect(nativeCatalogEffectId('MANUAL PAN')).toBe('manual_pan');
    expect(nativeCatalogFxOptions(status, 'input')).not.toContain('MANUAL PAN');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('MANUAL PAN');
  });

  it('maps the generic amount control across the full pan-position range', () => {
    expect(nativeCatalogMacroParameters('MANUAL PAN', 0)).toEqual({ position: -100 });
    expect(nativeCatalogMacroParameters('MANUAL PAN', 50)).toEqual({ position: 0 });
    expect(nativeCatalogMacroParameters('MANUAL PAN', 100)).toEqual({ position: 100 });
    expect(nativeCatalogMacroParameters('MANUAL PAN', 150)).toEqual({ position: 100 });
    expect(nativeCatalogSlotConfig('track', 2, { type: 'MANUAL PAN', value: 50, active: true })).toEqual({
      path: 'track',
      slot: 'C',
      effectId: 'manual_pan',
      parameters: { position: 0 },
      bypassed: false,
    });
  });
});

describe('Native OSC VOC (M) catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['osc_voc_m'],
      catalogEffectAvailability: [{ effectId: 'osc_voc_m', sourceIndex: 21, input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes the MIDI vocoder on both Native Input and shared Track chains', () => {
    expect(nativeCatalogEffectId('OSC VOC (M)')).toBe('osc_voc_m');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('OSC VOC (M)');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('OSC VOC (M)');
  });

  it('maps the macro and keeps canonical OSC VOC controls when selecting a slot', () => {
    expect(nativeCatalogMacroParameters('OSC VOC (M)', 35)).toEqual({
      waveform: 0, 'midi-channel': 1, octave: 0, mix: 35,
    });
    expect(nativeCatalogSlotConfig('track', 2, {
      type: 'OSC VOC (M)', value: 70, active: true,
      parameters: { waveform: 2, 'midi-channel': 3, octave: 7, mix: 82 },
    })).toEqual({
      path: 'track', slot: 'C', effectId: 'osc_voc_m',
      parameters: { waveform: 2, 'midi-channel': 3, octave: 7, mix: 82 },
      bypassed: false,
    });
  });
});

describe('Native OSC BOT clean-room catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['osc_bot'],
      catalogEffectAvailability: [{ effectId: 'osc_bot', sourceIndex: 22, input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('labels the clean-room reconstruction and exposes the Native Input and shared Track routes', () => {
    expect(nativeCatalogEffectId('OSC BOT (CLEAN-ROOM)')).toBe('osc_bot');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('OSC BOT (CLEAN-ROOM)');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('OSC BOT (CLEAN-ROOM)');
  });

  it('maps the generic macro to bounded controls and preserves the current transport tempo', () => {
    const previousTempo = Transport.getInstance().bpm;
    Transport.getInstance().bpm = 137;
    expect(nativeCatalogMacroParameters('OSC BOT (CLEAN-ROOM)', 35)).toEqual({
      bands: 16, waveform: 1, pattern: 0, tone: 3000, tempo: 137, mix: 35,
    });
    expect(nativeCatalogMacroParameters('OSC BOT (CLEAN-ROOM)', 150)).toEqual({
      bands: 16, waveform: 1, pattern: 0, tone: 3000, tempo: 137, mix: 100,
    });
    expect(nativeCatalogSlotConfig('track', 3, {
      type: 'OSC BOT (CLEAN-ROOM)', value: 70, active: true,
      parameters: { bands: 24, waveform: 2, pattern: 7, tone: 9000, tempo: 95, mix: 82 },
    })).toEqual({
      path: 'track', slot: 'D', effectId: 'osc_bot',
      parameters: { bands: 24, waveform: 2, pattern: 7, tone: 9000, tempo: 95, mix: 82 },
      bypassed: false,
    });
    Transport.getInstance().bpm = previousTempo;
  });
});

describe('Native experimental REVERSE REVERB catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['reverse_reverb'],
      catalogEffectAvailability: [{ effectId: 'reverse_reverb', sourceIndex: 49, input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('shows the experimental marker on both Native bank paths and reads saved legacy labels', () => {
    expect(nativeCatalogEffectId('REVERSE REVERB (EXPERIMENTAL)')).toBe('reverse_reverb');
    expect(nativeCatalogEffectId('REVERSE REVERB')).toBe('reverse_reverb');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('REVERSE REVERB (EXPERIMENTAL)');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('REVERSE REVERB (EXPERIMENTAL)');
  });

  it('routes the Native generic macro into bounded tempo-synchronized runtime parameters', () => {
    const parameters = nativeCatalogMacroParameters('REVERSE REVERB (EXPERIMENTAL)', 65);
    expect(parameters).toMatchObject({
      segment_beats: 0.5,
      feedback_percent: 0,
      crossfade_ms: 20,
      decay_seconds: 2,
      damping_cutoff_hz: 8000,
      mix_percent: 65,
    });
    expect(parameters.bpm).toBe(Transport.getInstance().bpm);
    expect(nativeCatalogSlotConfig('input', 0, {
      type: 'REVERSE REVERB (EXPERIMENTAL)', value: 65, active: true,
    })).toMatchObject({ path: 'input', slot: 'A', effectId: 'reverse_reverb', bypassed: false });
  });
});

describe('Native experimental AUTO RIFF catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['auto_riff'],
      catalogEffectAvailability: [{ effectId: 'auto_riff', sourceIndex: 12, input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('shows the experimental marker on both Native bank paths', () => {
    expect(nativeCatalogEffectId('AUTO RIFF (EXPERIMENTAL)')).toBe('auto_riff');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('AUTO RIFF (EXPERIMENTAL)');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('AUTO RIFF (EXPERIMENTAL)');
  });

  it('maps the generic macro to bounded controls and preserves per-slot parameters', () => {
    const previousTempo = Transport.getInstance().bpm;
    try {
      Transport.getInstance().bpm = 196;
      expect(nativeCatalogMacroParameters('AUTO RIFF (EXPERIMENTAL)', 65)).toEqual({
        bpm: 196, scale: 0, rate_beats: 0.5, sensitivity_percent: 55, mix_percent: 65,
      });
      expect(nativeCatalogSlotConfig('input', 0, {
        type: 'AUTO RIFF (EXPERIMENTAL)', value: 65, active: true,
        parameters: { scale: 2, rate_beats: 0.25, sensitivity_percent: 82, mix_percent: 73 },
      })).toMatchObject({
        path: 'input', slot: 'A', effectId: 'auto_riff', bypassed: false,
        parameters: { scale: 2, rate_beats: 0.25, sensitivity_percent: 82, mix_percent: 73 },
      });
      expect(nativeCatalogSlotConfig('track', 3, {
        type: 'AUTO RIFF (EXPERIMENTAL)', value: 65, active: true,
      })).toMatchObject({ path: 'track', slot: 'D', effectId: 'auto_riff', bypassed: false });
    } finally {
      Transport.getInstance().bpm = previousTempo;
    }
  });
});

describe('Native experimental ROBOT catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['robot'],
      catalogEffectAvailability: [{ effectId: 'robot', sourceIndex: 16, input: true, track: false }],
    },
  } as unknown as NativeStatus;

  it('labels supported Native routes as experimental and preserves the old saved label', () => {
    expect(nativeCatalogEffectId('ROBOT (EXPERIMENTAL)')).toBe('robot');
    expect(nativeCatalogEffectId('ROBOT')).toBe('robot');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('ROBOT (EXPERIMENTAL)');
    expect(nativeCatalogFxOptions(status, 'track')).not.toContain('ROBOT (EXPERIMENTAL)');
    expect(nativeCatalogFxOptions({
      nativeFx: { catalogGraphAvailable: true, implementedCatalogEffects: [], catalogEffectAvailability: [
        { effectId: 'robot', sourceIndex: 16, input: true, track: true },
      ] },
    } as unknown as NativeStatus, 'input')).not.toContain('ROBOT (EXPERIMENTAL)');
  });

  it('resolves either label to the named pitch/mix payload in the selected A–D slot', () => {
    expect(nativeCatalogSlotConfig('input', 2, {
      type: 'ROBOT (EXPERIMENTAL)', value: 63, active: true,
      parameters: { pitch_semitones: -7.5, formant_semitones: 4.5, mix_percent: 63 },
    })).toEqual({
      path: 'input', slot: 'C', effectId: 'robot',
      parameters: { pitch_semitones: -7.5, formant_semitones: 4.5, mix_percent: 63 }, bypassed: false,
    });
    expect(nativeCatalogSlotConfig('track', 0, {
      type: 'ROBOT', value: 100, active: false,
    })).toMatchObject({ path: 'track', slot: 'A', effectId: 'robot', bypassed: true });
  });
});

describe('Native ELECTRIC catalog adapter', () => {
  const status = {
    nativeFx: {
      catalogGraphAvailable: true,
      implementedCatalogEffects: ['electric'],
      catalogEffectAvailability: [{ effectId: 'electric', sourceIndex: 17, input: true, track: true }],
    },
  } as unknown as NativeStatus;

  it('exposes the Native processor on Input and Track and resolves its selector label', () => {
    expect(nativeCatalogEffectId('ELECTRIC')).toBe('electric');
    expect(nativeCatalogFxOptions(status, 'input')).toContain('ELECTRIC');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('ELECTRIC');
  });

  it('maps the generic macro to the authored defaults and mix while retaining editable controls', () => {
    expect(nativeCatalogMacroParameters('ELECTRIC', 0)).toEqual({
      character: 0, 'pitch-snap': 50, tone: 5000, mix: 0,
    });
    expect(nativeCatalogMacroParameters('ELECTRIC', 100)).toEqual({
      character: 0, 'pitch-snap': 50, tone: 5000, mix: 100,
    });
    expect(nativeCatalogSlotConfig('input', 1, {
      type: 'ELECTRIC', value: 62, active: true,
      parameters: { character: 3, 'pitch-snap': 82, tone: 7400, mix: 43 },
    })).toEqual({
      path: 'input', slot: 'B', effectId: 'electric',
      parameters: { character: 3, 'pitch-snap': 82, tone: 7400, mix: 43 }, bypassed: false,
    });
  });
});

describe('Native source-aware BEAT SHIFT catalog adapter', () => {
  it('offers only the advertised Track source route and preserves official controls without a fake macro', () => {
    const status = { nativeFx: { catalogGraphAvailable: true, implementedCatalogEffects: ['beat_shift'],
      catalogEffectAvailability: [{ effectId: 'beat_shift', sourceIndex: 52, input: false, track: true }] } } as unknown as NativeStatus;
    expect(nativeCatalogEffectId('BEAT SHIFT')).toBe('beat_shift');
    expect(nativeCatalogFxOptions(status, 'input')).not.toContain('BEAT SHIFT');
    expect(nativeCatalogFxOptions(status, 'track')).toContain('BEAT SHIFT');
    expect(nativeCatalogMacroParameters('BEAT SHIFT', 50)).toEqual({});
    expect(nativeCatalogSlotConfig('track', 0, { type: 'BEAT SHIFT', value: 50, active: true,
      parameters: { official_shift: -1, official_type: 0 } })).toMatchObject({ effectId: 'beat_shift',
        parameters: { official_shift: -1, official_type: 0 }, bypassed: false });
  });
});
