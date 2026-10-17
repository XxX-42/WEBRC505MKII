/**
 * Clean-room metadata catalog for the 53 RC-505mkII effect types.
 * Source algorithm/evidence notes come from the supplied fx_algorithm_matrix.csv.
 * Parameter names, ranges, defaults and curves below are provisional catalog
 * descriptors, not verified Roland parameter limits, and do not imply DSP support.
 */
export type FxImplementationStatus = 'catalogued' | 'implemented' | 'experimental';
export type FxRuntimeSupport = 'not-wired' | 'wired' | 'experimental';
export type FxRuntimeName = 'browser' | 'native';
export type FxRuntimeTarget = 'input-bank-slot' | 'track-bank-slot' | 'output-master';
export type FxParameterCurve = 'linear' | 'logarithmic' | 'exponential' | 'bipolar' | 'stepped';
export type FxParameterUnit = '%' | 'dB' | 'Hz' | 'ms' | 'seconds' | 'semitones' | 'beats' | 'steps' | 'bits' | 'bands' | 'ratio' | 'channel' | 'choice';
export type FxEvidenceClassification = 'documented-function-inferred-implementation' | 'explicit-perceptual-inference' | 'published-behavior-reconstruction' | 'functional-reconstruction';

export interface FxParameterOption {
  value: number;
  label: string;
}

export interface FxParameterDescriptor {
  /** Stable, globally unique catalog ID in the form `<fx-id>.<parameter-key>`. */
  id: string;
  /** Stable key scoped to this effect. */
  key: string;
  label: string;
  unit: FxParameterUnit;
  range: { min: number; max: number };
  defaultValue: number;
  curve: FxParameterCurve;
  /** All ranges here are authored clean-room defaults, not manufacturer claims. */
  rangeBasis: 'provisional-clean-room-default';
  options?: readonly FxParameterOption[];
}

export interface FxCatalogEntry {
  /** Stable kebab-case ID derived from the matrix effect name. */
  id: string;
  displayName: string;
  sourceIndex: number;
  availability: { input: boolean; track: boolean };
  family: string;
  algorithm: {
    functionalDescription: string;
    nativeBalancedChoice: string;
    browserBalancedChoice: string;
    formulaIds: readonly string[];
  };
  evidence: {
    source: 'data/fx_algorithm_matrix.csv';
    classification: FxEvidenceClassification;
    statusNote: string;
    methodology: 'clean-room-reconstruction';
  };
  /** Exact latency note from the supplied matrix; not a device measurement. */
  latencyNote: string;
  implementationStatus: FxImplementationStatus;
  runtimeSupport: FxRuntimeSupport;
  /** Present only for algorithms actually connected to a real runtime path. */
  runtimeImplementations?: readonly {
    runtime: FxRuntimeName;
    target: FxRuntimeTarget;
    algorithm: string;
  }[];
  implementationNote: string;
  parameters: readonly FxParameterDescriptor[];
}

export const FX_CATALOG: readonly FxCatalogEntry[] = [
  {
    "id": "lpf",
    "displayName": "LPF",
    "sourceIndex": 1,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Filter",
    "algorithm": {
      "functionalDescription": "TPT state-variable low-pass; parameter-smoothed cutoff/Q",
      "nativeBalancedChoice": "TPT-SVF, scalar/SIMD stereo; optional 2x control-rate coefficient update",
      "browserBalancedChoice": "WASM TPT-SVF inside one AudioWorklet; update coefficients per 8–16 samples",
      "formulaIds": [
        "F01",
        "F03"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "documented-function-inferred-implementation",
      "statusNote": "Official function; implementation topology is a reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Signalsmith-contract TPT-SVF LPF AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Signalsmith-contract TPT-SVF LPF AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native TPT state-variable low-pass processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native TPT state-variable low-pass processor" }
    ],
    "implementationNote": "Clean-room LPF is wired to Browser input-bank and shared track-bank A-D slots. Native A–D catalog routing is listed separately; per-loop-track processing is not claimed.",
    "parameters": [
      {
        "id": "lpf.cutoff",
        "key": "cutoff",
        "label": "Cutoff",
        "unit": "Hz",
        "range": {
          "min": 20,
          "max": 20000
        },
        "defaultValue": 10000,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "lpf.resonance",
        "key": "resonance",
        "label": "Resonance",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 15,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "lpf.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "bpf",
    "displayName": "BPF",
    "sourceIndex": 2,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Filter",
    "algorithm": {
      "functionalDescription": "TPT state-variable band-pass",
      "nativeBalancedChoice": "TPT-SVF BP output",
      "browserBalancedChoice": "Same WASM TPT-SVF BP output",
      "formulaIds": [
        "F01",
        "F03"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "documented-function-inferred-implementation",
      "statusNote": "Official function; reconstructed topology",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Signalsmith-contract TPT-SVF BPF AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Signalsmith-contract TPT-SVF BPF AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native TPT state-variable band-pass processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native TPT state-variable band-pass processor" }
    ],
    "implementationNote": "Clean-room BPF is wired to Browser input-bank and shared track-bank A-D slots. Native A–D catalog routing is listed separately; per-loop-track processing is not claimed.",
    "parameters": [
      {
        "id": "bpf.center",
        "key": "center",
        "label": "Center frequency",
        "unit": "Hz",
        "range": {
          "min": 20,
          "max": 20000
        },
        "defaultValue": 1000,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "bpf.q",
        "key": "q",
        "label": "Resonance Q",
        "unit": "ratio",
        "range": {
          "min": 0.1,
          "max": 12
        },
        "defaultValue": 1,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "bpf.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "hpf",
    "displayName": "HPF",
    "sourceIndex": 3,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Filter",
    "algorithm": {
      "functionalDescription": "TPT state-variable high-pass",
      "nativeBalancedChoice": "TPT-SVF HP output",
      "browserBalancedChoice": "Same WASM TPT-SVF HP output",
      "formulaIds": [
        "F01",
        "F03"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "documented-function-inferred-implementation",
      "statusNote": "Official function; reconstructed topology",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Signalsmith-contract TPT-SVF HPF AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Signalsmith-contract TPT-SVF HPF AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native TPT state-variable high-pass processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native TPT state-variable high-pass processor" }
    ],
    "implementationNote": "Clean-room HPF is wired to Browser input-bank and shared track-bank A-D slots. Native A–D catalog routing is listed separately; per-loop-track processing is not claimed.",
    "parameters": [
      {
        "id": "hpf.cutoff",
        "key": "cutoff",
        "label": "Cutoff",
        "unit": "Hz",
        "range": {
          "min": 20,
          "max": 20000
        },
        "defaultValue": 20,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "hpf.resonance",
        "key": "resonance",
        "label": "Resonance",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 15,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "hpf.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "phaser",
    "displayName": "PHASER",
    "sourceIndex": 4,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Modulation",
    "algorithm": {
      "functionalDescription": "4/8/12 cascaded first-order all-pass sections; dual opposing sweeps for BI-PHASE",
      "nativeBalancedChoice": "8–12 all-pass stages, oversampled coefficient modulation, feedback saturation",
      "browserBalancedChoice": "4–8 stages default; 12 stages only after runtime admission test",
      "formulaIds": [
        "F01",
        "F04",
        "F06"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "documented-function-inferred-implementation",
      "statusNote": "Stage choices follow official parameters; coefficients/topology reconstructed",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room 4/8-stage all-pass PHASER AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room 4/8-stage all-pass PHASER AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native all-pass phaser catalog processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native all-pass phaser catalog processor" }
    ],
    "implementationNote": "Clean-room 4/8-stage PHASER is wired to Browser input-bank and shared track-bank A-D slots. It is not BI-PHASE. Native A–D catalog routing is listed separately; per-loop-track processing is not claimed.",
    "parameters": [
      {
        "id": "phaser.rate",
        "key": "rate",
        "label": "Rate",
        "unit": "Hz",
        "range": {
          "min": 0.05,
          "max": 20
        },
        "defaultValue": 0.5,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "phaser.depth",
        "key": "depth",
        "label": "Depth",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 65,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "phaser.feedback",
        "key": "feedback",
        "label": "Feedback",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 95
        },
        "defaultValue": 20,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "phaser.stages",
        "key": "stages",
        "label": "All-pass stages",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 2
        },
        "defaultValue": 1,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "4"
          },
          {
            "value": 1,
            "label": "8"
          },
          {
            "value": 2,
            "label": "12"
          }
        ]
      },
      {
        "id": "phaser.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 50,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "flanger",
    "displayName": "FLANGER",
    "sourceIndex": 5,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Modulated delay",
    "algorithm": {
      "functionalDescription": "0.2–10 ms fractional delay with LFO, feedback and optional through-zero offset",
      "nativeBalancedChoice": "4-point Lagrange fractional delay; filtered/saturated feedback",
      "browserBalancedChoice": "4-point Lagrange in WASM; cap feedback and voices under load",
      "formulaIds": [
        "F01",
        "F05",
        "F06",
        "F14"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "<1 sample interpolation; audible delay is intentional",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room stereo 4-point Lagrange flanger AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room stereo 4-point Lagrange flanger AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native fractional-delay flanger catalog processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native fractional-delay flanger catalog processor" }
    ],
    "implementationNote": "Clean-room flanger is wired to Browser input-bank and shared post-mix track-bank A-D slots. Native A–D catalog routing is listed separately; per-loop-track processing is not claimed.",
    "parameters": [
      {
        "id": "flanger.delay",
        "key": "delay",
        "label": "Delay time",
        "unit": "ms",
        "range": {
          "min": 0.2,
          "max": 10
        },
        "defaultValue": 3,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "flanger.rate",
        "key": "rate",
        "label": "Rate",
        "unit": "Hz",
        "range": {
          "min": 0.05,
          "max": 20
        },
        "defaultValue": 0.3,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "flanger.depth",
        "key": "depth",
        "label": "Depth",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 60,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "flanger.feedback",
        "key": "feedback",
        "label": "Feedback",
        "unit": "%",
        "range": {
          "min": -95,
          "max": 95
        },
        "defaultValue": 25,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "flanger.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 50,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "synth",
    "displayName": "SYNTH",
    "sourceIndex": 6,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Pitch/synthesis",
    "algorithm": {
      "functionalDescription": "Onset/envelope follower + monophonic F0 tracker + polyBLEP oscillator/sub oscillator + resonant filter",
      "nativeBalancedChoice": "YIN/pYIN tracker; polyBLEP oscillators; TPT ladder/SVF",
      "browserBalancedChoice": "Decimated YIN-style tracker + polyBLEP/TPT-SVF in the Browser AudioWorklet",
      "formulaIds": [
        "F03",
        "F06",
        "F10",
        "F27"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "documented-function-inferred-implementation",
      "statusNote": "Official macro parameters known; synth topology inferred",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Browser: about 60 ms at 48 kHz for 55 Hz pitch acquisition; Native: about 64 ms first detection. Tracker/search settings remain provisional.",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Decimated YIN-style F0 tracker + polyBLEP waveform/sub oscillator + TPT-SVF in AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Decimated YIN-style F0 tracker + polyBLEP waveform/sub oscillator + TPT-SVF in AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Prepared YIN-style tracker + polyBLEP resynthesis + bounded filter" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Prepared YIN-style tracker + polyBLEP resynthesis + bounded filter" }
    ],
    "implementationNote": "Clean-room monophonic pitch tracking and synthesis is connected to Browser and Native Input A–D and shared post-mix Track A–D. Browser uses a decimated YIN-style tracker with roughly 60 ms low-note acquisition latency; Native uses its bounded YIN-style analysis window. Tracker and voice topology are inferred, unprofiled, and not sound-quality accepted. No Roland source, factory code, or hardware-fidelity claim.",
    "parameters": [
      {
        "id": "synth.sensitivity",
        "key": "sensitivity",
        "label": "Tracking sensitivity",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 60,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "synth.waveform",
        "key": "waveform",
        "label": "Oscillator waveform",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 2
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Saw"
          },
          {
            "value": 1,
            "label": "Square"
          },
          {
            "value": 2,
            "label": "Triangle"
          }
        ]
      },
      {
        "id": "synth.octave",
        "key": "octave",
        "label": "Oscillator octave",
        "unit": "semitones",
        "range": {
          "min": -24,
          "max": 24
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "synth.tone",
        "key": "tone",
        "label": "Tone cutoff",
        "unit": "Hz",
        "range": {
          "min": 100,
          "max": 16000
        },
        "defaultValue": 4000,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "synth.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 50,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "lo-fi",
    "displayName": "LO-FI",
    "sourceIndex": 7,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Lo-fi",
    "algorithm": {
      "functionalDescription": "Sample-rate hold, bit-depth quantization, optional post low-pass",
      "nativeBalancedChoice": "Integer/fractional sample hold + TPDF dithered quantizer",
      "browserBalancedChoice": "Same; extremely cheap in WASM",
      "formulaIds": [
        "F28"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room sample-rate hold with TPDF-dithered quantization and post-lowpass AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room sample-rate hold with TPDF-dithered quantization and post-lowpass AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room sample-rate hold with TPDF-dithered quantization and post-lowpass catalog processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room sample-rate hold with TPDF-dithered quantization and post-lowpass catalog processor" }
    ],
    "implementationNote": "Clean-room functional reconstruction; provisional control ranges, not Roland hardware fidelity.",
    "parameters": [
      {
        "id": "lo-fi.bit-depth",
        "key": "bit-depth",
        "label": "Bit depth",
        "unit": "bits",
        "range": {
          "min": 4,
          "max": 24
        },
        "defaultValue": 12,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "lo-fi.sample-rate",
        "key": "sample-rate",
        "label": "Sample rate",
        "unit": "Hz",
        "range": {
          "min": 500,
          "max": 48000
        },
        "defaultValue": 12000,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "lo-fi.filter",
        "key": "filter",
        "label": "Post-filter cutoff",
        "unit": "Hz",
        "range": {
          "min": 20,
          "max": 20000
        },
        "defaultValue": 12000,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "lo-fi.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 70,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "radio",
    "displayName": "RADIO",
    "sourceIndex": 8,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Lo-fi",
    "algorithm": {
      "functionalDescription": "Band-limit + static/nonlinear saturation + noise/dropout",
      "nativeBalancedChoice": "HPF/LPF biquads + 2x ADAA waveshaper + colored noise",
      "browserBalancedChoice": "TPT/biquad + ADAA at 1x or 2x depending device tier",
      "formulaIds": [
        "F02",
        "F07",
        "F28"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples added algorithmic latency (midpoint 2x ADAA; authored Browser implementation)",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room RADIO AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room RADIO AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native band-limited radio-tone/noise processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native band-limited radio-tone/noise processor" }
    ],
    "implementationNote": "Clean-room RADIO is wired to Browser input-bank and shared track-bank A-D slots. Its three band presets, saturation, noise, and dropout controls are provisional authored choices, not verified Roland controls or an official-device emulation. Native also uses a separate clean-room catalog processor; controls remain provisional.",
    "parameters": [
      {
        "id": "radio.band",
        "key": "band",
        "label": "Radio band",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 2
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "AM narrow"
          },
          {
            "value": 1,
            "label": "AM wide"
          },
          {
            "value": 2,
            "label": "FM"
          }
        ]
      },
      {
        "id": "radio.drive",
        "key": "drive",
        "label": "Saturation drive",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 35,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "radio.noise",
        "key": "noise",
        "label": "Noise/dropout",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 8,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "radio.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 70,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "ring-mod",
    "displayName": "RING.MOD",
    "sourceIndex": 9,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Modulation",
    "algorithm": {
      "functionalDescription": "Four-quadrant multiplication by sine/triangle carrier",
      "nativeBalancedChoice": "Quadrature recursive oscillator; optional DC blocking",
      "browserBalancedChoice": "Same in WASM; AudioParam only supplies smoothed control values",
      "formulaIds": [
        "F01",
        "F06",
        "F29"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Standard ring-mod reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room sine ring modulation AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room sine ring modulation AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native quadrature-oscillator ring modulator" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native quadrature-oscillator ring modulator" }
    ],
    "implementationNote": "Clean-room ring modulation is wired to Browser input-bank and shared track-bank A-D slots. Native A–D catalog routing is listed separately; per-loop-track processing is not claimed.",
    "parameters": [
      {
        "id": "ring-mod.carrier-frequency",
        "key": "carrier-frequency",
        "label": "Carrier frequency",
        "unit": "Hz",
        "range": {
          "min": 20,
          "max": 8000
        },
        "defaultValue": 440,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "ring-mod.waveform",
        "key": "waveform",
        "label": "Carrier waveform",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 1
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Sine"
          },
          {
            "value": 1,
            "label": "Triangle"
          }
        ]
      },
      {
        "id": "ring-mod.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 50,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "g2b",
    "displayName": "G2B",
    "sourceIndex": 10,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Pitch",
    "algorithm": {
      "functionalDescription": "Monophonic tracking + octave-down resynthesis/divider blend + formant/body filtering",
      "nativeBalancedChoice": "YIN + TD-PSOLA at -12 semitones, blended with square-wave divider and body EQ",
      "browserBalancedChoice": "YIN decimated + WSOLA/PSOLA-lite; quality tier can disable divider blend",
      "formulaIds": [
        "F09",
        "F10",
        "F11"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "documented-function-inferred-implementation",
      "statusNote": "Guitar-to-bass function official; exact topology inferred",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Browser: about 60 ms at 48 kHz for a 55 Hz input before smoothing. Native: 50.65 ms measured first-wet onset at 48 kHz on a 220 Hz sine; declared window+hop bound 50.67 ms.",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Decimated YIN F0 tracker, fixed -12 semitone square/polyBLEP voice, body TPT-SVF, and independent blend in the Browser AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Decimated YIN F0 tracker, fixed -12 semitone square/polyBLEP voice, body TPT-SVF, and independent blend in the Browser AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Preallocated decimated YIN/CMND tracker, fixed -12 semitone band-limited square resynthesis, body TPT-SVF, and independent blend" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Preallocated decimated YIN/CMND tracker, fixed -12 semitone band-limited square resynthesis, body TPT-SVF, and independent blend" }
    ],
    "implementationNote": "Browser and Native Input A–D plus shared post-mix Track A–D routes connect to clean-room decimated-YIN/CMND octave-down square resynthesizers with tracking, blend, and body controls. Browser uses about 60 ms to acquire a 55 Hz source. Native first-wet onset measured 50.65 ms on a 220 Hz sine at 48 kHz against a declared 50.67 ms window+hop bound. Both processors use polyBLEP-style resynthesis rather than TD-PSOLA/WSOLA, remain provisional and are not sound-quality accepted. No Roland source, factory code, or hardware-fidelity claim.",
    "parameters": [
      {
        "id": "g2b.tracking",
        "key": "tracking",
        "label": "Tracking sensitivity",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 65,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "g2b.blend",
        "key": "blend",
        "label": "Sub octave blend",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 65,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "g2b.body",
        "key": "body",
        "label": "Body filter",
        "unit": "Hz",
        "range": {
          "min": 60,
          "max": 1200
        },
        "defaultValue": 180,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "sustainer",
    "displayName": "SUSTAINER",
    "sourceIndex": 11,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Dynamics",
    "algorithm": {
      "functionalDescription": "Upward/downward compression, noise gate and safety limiter",
      "nativeBalancedChoice": "Dual detector feed-forward compressor; 1 ms lookahead limiter",
      "browserBalancedChoice": "Stereo-linked peak detector, threshold-relative upward/downward compression, hysteretic gate, and bounded no-lookahead limiter",
      "formulaIds": [
        "F01",
        "F08"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0–1 ms",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Stereo-linked no-lookahead SUSTAINER AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Stereo-linked no-lookahead SUSTAINER AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native dynamics, gate, and limiter processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native dynamics, gate, and limiter processor" }
    ],
    "implementationNote": "Clean-room SUSTAINER is wired to Browser Input and shared Track A–D slots. Its provisional law uses a 2 ms peak-envelope attack, gate opening at threshold -18 dB / closing at threshold -24 dB, 1 ms gate opening and 60 ms closing, and a linked -0.3 dBFS no-lookahead limiter with instantaneous attack and 60 ms gain release. Native also uses a separate clean-room catalog processor; hardware behavior is not verified.",
    "parameters": [
      {
        "id": "sustainer.threshold",
        "key": "threshold",
        "label": "Threshold",
        "unit": "dB",
        "range": {
          "min": -60,
          "max": 0
        },
        "defaultValue": -24,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "sustainer.ratio",
        "key": "ratio",
        "label": "Compression ratio",
        "unit": "ratio",
        "range": {
          "min": 1,
          "max": 20
        },
        "defaultValue": 4,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "sustainer.release",
        "key": "release",
        "label": "Release",
        "unit": "ms",
        "range": {
          "min": 10,
          "max": 1000
        },
        "defaultValue": 180,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "sustainer.output",
        "key": "output",
        "label": "Output level",
        "unit": "dB",
        "range": {
          "min": -24,
          "max": 12
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "auto-riff",
    "displayName": "AUTO RIFF",
    "sourceIndex": 12,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Pitch/sequencer",
    "algorithm": {
      "functionalDescription": "Detect F0/onsets, quantize to scale, drive rhythm-locked pitch sequence",
      "nativeBalancedChoice": "YIN/pYIN + onset detector + TD-PSOLA/phase-vocoder voice",
      "browserBalancedChoice": "Decimated YIN + cheaper WSOLA/Signalsmith Web tier",
      "formulaIds": [
        "F09",
        "F10",
        "F11",
        "F12",
        "F20",
        "F27"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "documented-function-inferred-implementation",
      "statusNote": "Pattern behavior official; internal note extraction inferred",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "10–40 ms",
    "implementationStatus": "experimental",
    "runtimeSupport": "experimental",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Sample-clocked bounded onset/YIN analyzer in the shipped AudioWorklet, with pitch-step commands driving the pinned Signalsmith LIVE_FX shifter in the Browser host" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Same sample-clocked analyzer plus Signalsmith LIVE_FX shifter on shared post-mix Browser Track A–D bank" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Bounded YIN/onset core and sample-clocked scale sequencer driving the pinned Signalsmith FX shifter on Native Input A–D" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Same YIN/scale sequencer and Signalsmith FX shifter on the shared stereo Native Track A–D bus" }
    ],
    "implementationNote": "Experimental clean-room onset/F0 analysis and an authored eight-step scale sequence are connected to the pinned Signalsmith pitch shifter in Browser Input/Track A–D and Native Input/Track A–D. Browser event scheduling is sample-frame based and analysis storage is bounded. Detector/sequence behavior, polyphonic tracking, musical response, latency, and sound quality remain unvalidated for acceptance; no Roland source/code or hardware equivalence is claimed.",
    "parameters": [
      {
        "id": "auto-riff.scale",
        "key": "scale",
        "label": "Scale",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 4
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Chromatic"
          },
          {
            "value": 1,
            "label": "Major"
          },
          {
            "value": 2,
            "label": "Natural minor"
          },
          {
            "value": 3,
            "label": "Harmonic minor"
          },
          {
            "value": 4,
            "label": "Pentatonic"
          }
        ]
      },
      {
        "id": "auto-riff.rate",
        "key": "rate",
        "label": "Step rate",
        "unit": "beats",
        "range": {
          "min": 0.25,
          "max": 4
        },
        "defaultValue": 0.5,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0.25,
            "label": "1/16"
          },
          {
            "value": 0.5,
            "label": "1/8"
          },
          {
            "value": 1,
            "label": "1/4"
          },
          {
            "value": 2,
            "label": "1/2"
          },
          {
            "value": 4,
            "label": "1 bar"
          }
        ]
      },
      {
        "id": "auto-riff.sensitivity",
        "key": "sensitivity",
        "label": "Onset sensitivity",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 55,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "auto-riff.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 65,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "slow-gear",
    "displayName": "SLOW GEAR",
    "sourceIndex": 13,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Envelope",
    "algorithm": {
      "functionalDescription": "Onset-triggered attack envelope that suppresses pick transient",
      "nativeBalancedChoice": "Spectral-flux/energy onset detector + exponential or raised-cosine ramp",
      "browserBalancedChoice": "Block energy onset detector + raised-cosine ramp",
      "formulaIds": [
        "F01",
        "F27"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples; attack is intentional",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room short-window energy onset detector and raised-cosine attack AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room short-window energy onset detector and raised-cosine attack AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native onset-ramped slow-gear processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native onset-ramped slow-gear processor" }
    ],
    "implementationNote": "Clean-room Browser SLOW GEAR reconstruction is wired to the Input FX bank and shared Track A–D bank. It uses a short-window energy onset detector and a raised-cosine attack ramp with 0 fixed pipeline samples; the attack is intentional. The provisional parameter ranges and onset law are authored choices, not Roland limits or a factory-DSP reproduction.",
    "parameters": [
      {
        "id": "slow-gear.attack",
        "key": "attack",
        "label": "Attack time",
        "unit": "ms",
        "range": {
          "min": 5,
          "max": 2000
        },
        "defaultValue": 250,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "slow-gear.sensitivity",
        "key": "sensitivity",
        "label": "Onset sensitivity",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 50,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "slow-gear.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "transpose",
    "displayName": "TRANSPOSE",
    "sourceIndex": 14,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Pitch",
    "algorithm": {
      "functionalDescription": "Constant-ratio polyphonic pitch shift over the stereo input signal",
      "nativeBalancedChoice": "Signalsmith Stretch 1.3.2 streaming polyphonic pitch shift; optional Rubber Band tier not linked",
      "browserBalancedChoice": "Signalsmith Stretch 1.3.2 connected live-input WASM/AudioWorklet",
      "formulaIds": [
        "F09",
        "F10",
        "F11"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "documented-function-inferred-implementation",
      "statusNote": "Function official; algorithm selected by material",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Source matrix: Native 14–43 ms for tested Rubber Band modes. This Signalsmith build reports 40 ms Native and 24 ms Browser algorithmic latency at 48 kHz; not device round-trip.",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      {
        "runtime": "browser",
        "target": "input-bank-slot",
        "algorithm": "Signalsmith Stretch 1.3.2 connected live-input WASM/AudioWorklet; measured 24 ms algorithm latency at 48 kHz; dry path is aligned when active"
      },
      {
        "runtime": "browser",
        "target": "track-bank-slot",
        "algorithm": "Signalsmith Stretch 1.3.2 connected live-input WASM/AudioWorklet on shared post-mix Track A–D; measured 24 ms algorithm latency at 48 kHz"
      },
      {
        "runtime": "native",
        "target": "input-bank-slot",
        "algorithm": "Signalsmith Stretch 1.3.2 C++ streaming polyphonic processor; measured 40 ms algorithm latency at 48 kHz; latency-aligned dry/wet"
      },
      {
        "runtime": "native",
        "target": "track-bank-slot",
        "algorithm": "Signalsmith Stretch 1.3.2 C++ streaming polyphonic processor on shared post-mix Track A–D; measured 40 ms algorithm latency at 48 kHz"
      }
    ],
    "implementationNote": "Connected Signalsmith polyphonic pitch shifter on Native and Browser Input/Track A–D banks. The active dry path is algorithm-latency aligned; direct bypass remains zero-delay. Formant compensation is unsupported and rejected. Sine/DFT tests verify sustained pitch ratio only; this is a clean-room reconstruction with no Roland-fidelity or full quality-admission claim.",
    "parameters": [
      {
        "id": "transpose.shift",
        "key": "shift",
        "label": "Pitch shift",
        "unit": "semitones",
        "range": {
          "min": -24,
          "max": 24
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "transpose.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "pitch-bend",
    "displayName": "PITCH BEND",
    "sourceIndex": 15,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Pitch",
    "algorithm": {
      "functionalDescription": "Activation-triggered one-shot semitone sweep into a streaming polyphonic pitch shifter; the final pitch is held until bypass",
      "nativeBalancedChoice": "Signalsmith Stretch 1.3.2 streaming polyphonic pitch shift with a bounded activation envelope",
      "browserBalancedChoice": "Signalsmith Stretch 1.3.2 connected-input Worklet with scheduled, bounded pitch trajectory",
      "formulaIds": [
        "F01",
        "F09",
        "F11",
        "F12"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Signalsmith algorithm latency at 48 kHz: 40 ms Native, 24 ms Browser; sweep duration is a separate control",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      {
        "runtime": "browser",
        "target": "input-bank-slot",
        "algorithm": "Signalsmith Stretch 1.3.2 connected-input Worklet; bounded one-shot pitch sweep with latency-aligned dry path"
      },
      {
        "runtime": "browser",
        "target": "track-bank-slot",
        "algorithm": "Signalsmith Stretch 1.3.2 connected-input Worklet on shared post-mix Track A–D; bounded one-shot pitch sweep"
      },
      {
        "runtime": "native",
        "target": "input-bank-slot",
        "algorithm": "Signalsmith Stretch 1.3.2 streaming processor on Native Input A–D; bounded one-shot sweep and latency-aligned mix"
      },
      {
        "runtime": "native",
        "target": "track-bank-slot",
        "algorithm": "Signalsmith Stretch 1.3.2 streaming processor on shared post-mix Native Track A–D; bounded one-shot sweep"
      }
    ],
    "implementationNote": "Clean-room one-shot semitone sweep; activation starts at unshifted pitch, the endpoint is held until bypass, and reactivation retriggers from zero. Browser and Native adapters are wired to Input and shared post-mix Track A–D banks with latency-aligned dry paths. Focused functional tests do not constitute full sound-quality admission or Roland firmware fidelity.",
    "parameters": [
      {
        "id": "pitch-bend.range",
        "key": "range",
        "label": "Bend range",
        "unit": "semitones",
        "range": {
          "min": 0,
          "max": 24
        },
        "defaultValue": 12,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "pitch-bend.time_ms",
        "key": "time_ms",
        "label": "Bend time",
        "unit": "ms",
        "range": {
          "min": 20,
          "max": 4000
        },
        "defaultValue": 500,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "pitch-bend.direction",
        "key": "direction",
        "label": "Bend direction",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 1
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Up"
          },
          {
            "value": 1,
            "label": "Down"
          }
        ]
      },
      {
        "id": "pitch-bend.mix_percent",
        "key": "mix_percent",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "robot",
    "displayName": "ROBOT",
    "sourceIndex": 16,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Voice",
    "algorithm": {
      "functionalDescription": "Force F0 to fixed/quantized pitch while retaining or shifting formants",
      "nativeBalancedChoice": "YIN + PSOLA fixed period; phase-vocoder fallback for polyphonic/unstable F0",
      "browserBalancedChoice": "PSOLA-lite with voiced/unvoiced gate; fallback granular vocoder",
      "formulaIds": [
        "F09",
        "F10",
        "F11",
        "F12"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "10–30 ms",
    "implementationStatus": "experimental",
    "runtimeSupport": "experimental",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Experimental bounded decimated-YIN monophonic target quantizer in the shipped AudioWorklet, with frame-stamped scheduling of the pinned Signalsmith LIVE_FX pitch/formant shifter in the Browser host" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Same bounded YIN controller and Signalsmith LIVE_FX host shifter on the shared post-mix Browser Track A–D bank" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Experimental bounded YIN/CMND monophonic controller and one pinned Signalsmith voice in the selected Native Input A–D slot" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Same bounded YIN/CMND controller and Signalsmith voice on the shared stereo Native Track A–D bus" }
    ],
    "implementationNote": "Browser and Native ROBOT are connected to selected Input/Track A–D slots as experimental clean-room monophonic pitch-control paths. Both use bounded YIN/CMND plus one pinned Signalsmith shifter voice and an independent formant control; the Browser schedule anchors compensation to the tracked F0. Fixed-period PSOLA and the polyphonic/unstable-F0 fallback in the matrix are not implemented. Current detector analysis windows and shifter algorithmic latencies are reported separately in the runtime status; no summed end-to-end latency or 10–30 ms target is claimed without measurement. Polyphonic tracking, total live latency, sound-quality admission, hardware behavior, and Roland equivalence remain unverified.",
    "parameters": [
      {
        "id": "robot.pitch",
        "key": "pitch",
        "label": "Target pitch",
        "unit": "semitones",
        "range": {
          "min": -24,
          "max": 24
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "robot.formant",
        "key": "formant",
        "label": "Formant shift",
        "unit": "semitones",
        "range": {
          "min": -12,
          "max": 12
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "robot.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "electric",
    "displayName": "ELECTRIC",
    "sourceIndex": 17,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Voice character",
    "algorithm": {
      "functionalDescription": "Hard pitch quantization plus metallic ring/vocoder/bit-crush macro",
      "nativeBalancedChoice": "Pitch snap + ring modulation + formant/filter macro; scene presets",
      "browserBalancedChoice": "Same modules with one active character path at a time",
      "formulaIds": [
        "F03",
        "F09",
        "F10",
        "F13",
        "F28",
        "F29"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "explicit-perceptual-inference",
      "statusNote": "Exact Roland topology is not public; this is a perceptual reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Browser pitch-snap branch: about 60 ms at 48 kHz for a 55 Hz source to acquire; character-dependent and unvoiced branches do not wait for F0",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room YIN pitch-snap voice with selectable classic, ring-mod metallic, ERB vocoder, and Lo-Fi bit-crush paths" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Same clean-room ELECTRIC character worklet in shared post-mix Track A-D catalog slots" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native ELECTRIC character processor in the callback-driven Input A-D bank" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Same clean-room Native ELECTRIC processor in the shared post-mix Track A-D bank" }
    ],
    "implementationNote": "Browser and Native ELECTRIC route through their real Input and shared post-mix Track A-D catalog processors. Classic and Metallic fail dry until bounded pitch tracking confirms a voiced source; Vocoder and Bit crush retain their character-specific unvoiced behavior. Parameter ranges and processing paths are clean-room perceptual inferences only; Roland topology and sound-quality acceptance are not claimed.",
    "parameters": [
      {
        "id": "electric.character",
        "key": "character",
        "label": "Character",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 3
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Classic"
          },
          {
            "value": 1,
            "label": "Metallic"
          },
          {
            "value": 2,
            "label": "Vocoder"
          },
          {
            "value": 3,
            "label": "Bit crush"
          }
        ]
      },
      {
        "id": "electric.pitch-snap",
        "key": "pitch-snap",
        "label": "Pitch snap",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 50,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "electric.tone",
        "key": "tone",
        "label": "Tone cutoff",
        "unit": "Hz",
        "range": {
          "min": 100,
          "max": 16000
        },
        "defaultValue": 5000,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "electric.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 70,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "hrm-manual",
    "displayName": "HRM MANUAL",
    "sourceIndex": 18,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Harmony",
    "algorithm": {
      "functionalDescription": "Two independent fixed-interval pitch-shift voices added over full-level dry audio with shared pan and harmony-level controls; formant preservation is unsupported",
      "nativeBalancedChoice": "Two independent Signalsmith Stretch 1.3.2 streaming voices; formant preservation unsupported",
      "browserBalancedChoice": "Two independent Signalsmith Stretch 1.3.2 AudioWorklet voices; formant preservation unsupported",
      "formulaIds": [
        "F09",
        "F10",
        "F11",
        "F12",
        "F21"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Signalsmith algorithm latency at 48 kHz: 40 ms Native, 24 ms Browser; both harmony voices run in parallel",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      {
        "runtime": "browser",
        "target": "input-bank-slot",
        "algorithm": "Two independent Signalsmith Stretch 1.3.2 Worklet voices, latency-aligned centered dry and shared panned harmony bus"
      },
      {
        "runtime": "browser",
        "target": "track-bank-slot",
        "algorithm": "Two independent Signalsmith Stretch 1.3.2 Worklet voices on shared post-mix Track A–D, latency-aligned centered dry and shared panned harmony bus"
      },
      {
        "runtime": "native",
        "target": "input-bank-slot",
        "algorithm": "Two independent Signalsmith Stretch 1.3.2 voices on Native Input A–D; centered mono dry; non-center pan rejected"
      },
      {
        "runtime": "native",
        "target": "track-bank-slot",
        "algorithm": "Two independent Signalsmith Stretch 1.3.2 voices on shared post-mix Track A–D, latency-aligned centered dry and shared panned harmony bus"
      }
    ],
    "implementationNote": "Clean-room two-voice harmonizer reuses the pinned MIT Signalsmith Stretch 1.3.2 pitch engine, preserves the centered dry signal and adds the summed harmony bus. Formant preservation is explicitly unsupported; Native mono Input rejects non-center pan. Focused functional and routing tests do not constitute full sound-quality admission or Roland firmware fidelity.",
    "parameters": [
      {
        "id": "hrm-manual.voice_1_interval",
        "key": "voice_1_interval",
        "label": "Voice 1 interval",
        "unit": "semitones",
        "range": {
          "min": -24,
          "max": 24
        },
        "defaultValue": 7,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "hrm-manual.voice_2_interval",
        "key": "voice_2_interval",
        "label": "Voice 2 interval",
        "unit": "semitones",
        "range": {
          "min": -24,
          "max": 24
        },
        "defaultValue": 12,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "hrm-manual.pan_percent",
        "key": "pan_percent",
        "label": "Harmony pan",
        "unit": "%",
        "range": {
          "min": -100,
          "max": 100
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "hrm-manual.mix_percent",
        "key": "mix_percent",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 70,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "hrm-auto-m",
    "displayName": "HRM AUTO (M)",
    "sourceIndex": 19,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Harmony/MIDI",
    "algorithm": {
      "functionalDescription": "MIDI chord/note parsing, voice assignment, diatonic interval selection and pitch shifts",
      "nativeBalancedChoice": "Bounded lock-free MIDI event queue + Signalsmith LIVE_FX voices",
      "browserBalancedChoice": "Timestamped MIDI messages delivered to AudioWorklet; 1–2 voices",
      "formulaIds": [
        "F09",
        "F10",
        "F11"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "documented-function-inferred-implementation",
      "statusNote": "MIDI-based behavior is official; voicing algorithm reconstructed",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Pitch engine dependent",
    "implementationStatus": "experimental",
    "runtimeSupport": "experimental",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "YIN-based monophonic pitch tracker plus bounded absolute-sample-frame MIDI scheduler; targets drive a Signalsmith pitch-shift host adapter in the exact selected Input slot" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Same tracker/scheduler and host pitch adapter in the explicitly selected shared post-mix Track slot" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Bounded absolute-frame MIDI scheduler and two Signalsmith voices in the exact selected Native Input slot, with latency-aligned dry/wet mix" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Same Native MIDI scheduler and Signalsmith voices in the selected shared post-mix Track slot" }
    ],
    "implementationNote": "Browser and Native HRM AUTO (M) are experimental, clean-room reconstructions explicitly MIDI-routed to one selected Input A-D or shared post-mix Track A-D slot. Both use bounded sample-frame MIDI scheduling and the existing Signalsmith pitch backend. The tracker is monophonic, voicing is provisional, and neither stereo-unison, listening-quality acceptance nor hardware fidelity is claimed. No Roland source or code is used.",
    "parameters": [
      {
        "id": "hrm-auto-m.key",
        "key": "key",
        "label": "Key",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 11
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "C"
          },
          {
            "value": 1,
            "label": "C#"
          },
          {
            "value": 2,
            "label": "D"
          },
          {
            "value": 3,
            "label": "D#"
          },
          {
            "value": 4,
            "label": "E"
          },
          {
            "value": 5,
            "label": "F"
          },
          {
            "value": 6,
            "label": "F#"
          },
          {
            "value": 7,
            "label": "G"
          },
          {
            "value": 8,
            "label": "G#"
          },
          {
            "value": 9,
            "label": "A"
          },
          {
            "value": 10,
            "label": "A#"
          },
          {
            "value": 11,
            "label": "B"
          }
        ]
      },
      {
        "id": "hrm-auto-m.scale",
        "key": "scale",
        "label": "Scale",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 4
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Major"
          },
          {
            "value": 1,
            "label": "Natural minor"
          },
          {
            "value": 2,
            "label": "Harmonic minor"
          },
          {
            "value": 3,
            "label": "Dorian"
          },
          {
            "value": 4,
            "label": "Mixolydian"
          }
        ]
      },
      {
        "id": "hrm-auto-m.midi-channel",
        "key": "midi-channel",
        "label": "MIDI channel",
        "unit": "channel",
        "range": {
          "min": 1,
          "max": 16
        },
        "defaultValue": 1,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "hrm-auto-m.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 70,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "vocoder",
    "displayName": "VOCODER",
    "sourceIndex": 20,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Vocoder",
    "algorithm": {
      "functionalDescription": "Configurable 8–24-band logarithmic modulator analysis filterbank with per-band envelope followers and selectable input/saw/square carrier synthesis",
      "nativeBalancedChoice": "Bounded 16-band filterbank and envelope followers with selectable carrier; high-quality STFT mode not implemented",
      "browserBalancedChoice": "Variable 8–24-band filterbank in a shipped AudioWorklet with selectable carrier",
      "formulaIds": [
        "F01",
        "F03",
        "F13"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Standard vocoder reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 fixed algorithm samples; no STFT mode",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "8–24-band configurable logarithmic analysis filterbank and envelope follower, with input/saw/square carriers in the shipped AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "8–24-band configurable logarithmic analysis filterbank and envelope follower, with input/saw/square carriers in the shipped AudioWorklet on shared post-mix Track A–D" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room 8–24-band ERB-spaced filterbank/envelope vocoder, per-channel voice/saw/square carriers, in the Native Input FX bank" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room 8–24-band ERB-spaced filterbank/envelope vocoder, per-channel voice/saw/square carriers, on the shared post-mix Native Track A–D FX bank" }
    ],
    "implementationNote": "Clean-room filterbank/envelope vocoder with three selectable carrier modes. Formant shift is rejected until a true formant-shift path is implemented; 1024/256 STFT processing, full quality admission and Roland firmware fidelity are not claimed.",
    "parameters": [
      {
        "id": "vocoder.bands",
        "key": "bands",
        "label": "Filterbank bands",
        "unit": "bands",
        "range": {
          "min": 8,
          "max": 24
        },
        "defaultValue": 16,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "vocoder.carrier",
        "key": "carrier",
        "label": "Carrier",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 2
        },
        "defaultValue": 1,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Voice input"
          },
          {
            "value": 1,
            "label": "Internal saw"
          },
          {
            "value": 2,
            "label": "Internal square"
          }
        ]
      },
      {
        "id": "vocoder.formant",
        "key": "formant",
        "label": "Formant shift",
        "unit": "semitones",
        "range": {
          "min": -12,
          "max": 12
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "vocoder.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 70,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "osc-voc-m",
    "displayName": "OSC VOC (M)",
    "sourceIndex": 21,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Vocoder/MIDI",
    "algorithm": {
      "functionalDescription": "MIDI-controlled anti-aliased oscillator carrier through vocoder analysis envelopes",
      "nativeBalancedChoice": "PolyBLEP saw/square, 24-band filterbank, stereo unison optional",
      "browserBalancedChoice": "PolyBLEP carrier, 16-band default, voice cap",
      "formulaIds": [
        "F03",
        "F06",
        "F13",
        "F20"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "documented-function-inferred-implementation",
      "statusNote": "MIDI behavior official; carrier design reconstructed",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0–16 ms",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room monophonic MIDI polyBLEP carrier, sample-frame note scheduler and reusable ERB VOCODER filterbank in the shipped Browser AudioWorklet; external Web MIDI requires an explicit connect action" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Same sample-frame MIDI carrier/filterbank processor in the shared post-mix Browser Track A–D bank" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native eight-voice MIDI polyBLEP carrier with bounded absolute-frame queue and reusable vocoder filterbank in Input A–D catalog slots" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Same Native eight-voice MIDI carrier/filterbank processor in the shared post-mix Track A–D catalog bank" }
    ],
    "implementationNote": "Browser Input A–D and shared post-mix Track A–D use a separate OSC VOC processor with a bounded absolute-frame MIDI scheduler, monophonic latest-held-note voice, polyBLEP saw/square/pulse carrier and reusable VOCODER ERB analysis/envelope/carrier-filter path. Web MIDI permission is requested only by the explicit Connect MIDI button. Native Input and shared Track A–D use the C++ catalog processor with up to eight voices and a bounded absolute-frame event queue. Both are clean-room reconstructions, not Roland source; voice behavior differs, and neither has sound-quality acceptance or hardware fidelity evidence.",
    "parameters": [
      {
        "id": "osc-voc-m.waveform",
        "key": "waveform",
        "label": "Carrier waveform",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 2
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Saw"
          },
          {
            "value": 1,
            "label": "Square"
          },
          {
            "value": 2,
            "label": "Pulse"
          }
        ]
      },
      {
        "id": "osc-voc-m.midi-channel",
        "key": "midi-channel",
        "label": "MIDI channel",
        "unit": "channel",
        "range": {
          "min": 1,
          "max": 16
        },
        "defaultValue": 1,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "osc-voc-m.octave",
        "key": "octave",
        "label": "Carrier octave",
        "unit": "semitones",
        "range": {
          "min": -24,
          "max": 24
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "osc-voc-m.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 70,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "osc-bot",
    "displayName": "OSC BOT",
    "sourceIndex": 22,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Voice/synthesis",
    "algorithm": {
      "functionalDescription": "Oscillator-bank robot voice with envelope, step pattern and resonant filter",
      "nativeBalancedChoice": "polyBLEP oscillator + formant filterbank + step sequencer",
      "browserBalancedChoice": "Same with fewer bands/voices",
      "formulaIds": [
        "F03",
        "F06",
        "F13",
        "F20",
        "F27"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "explicit-perceptual-inference",
      "statusNote": "Exact topology not public; perceptual reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 fixed algorithm samples; the authored sixteenth-note sequence is sample-clocked",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room per-band polyBLEP oscillator bank, shared VOCODER filterbank envelope/carrier path, authored eight-step sequence, resonant TPT tone filter in the Browser AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Same processor on shared post-mix Browser Track A–D bank" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native oscillator-bank reconstruction with bounded controls in Input A–D catalog slots" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Same Native oscillator-bank reconstruction in the shared post-mix Track A–D catalog bank" }
    ],
    "implementationNote": "Browser Input A–D and shared post-mix Track A–D connect to a clean-room oscillator bank gated through the reusable ERB VOCODER carrier/envelope filterbank, with polyBLEP saw/square and integrated BLEP triangle carriers, authored semitone patterns at the project-tempo sixteenth-note clock, and a resonant TPT tone filter. Native Input and shared Track A–D expose the separate clean-room carrier-bank catalog processor. The patterns/topology are perceptual reconstructions, not Roland factory behavior. No sound-quality acceptance or hardware fidelity is claimed.",
    "parameters": [
      {
        "id": "osc-bot.waveform",
        "key": "waveform",
        "label": "Oscillator waveform",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 2
        },
        "defaultValue": 1,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Saw"
          },
          {
            "value": 1,
            "label": "Square"
          },
          {
            "value": 2,
            "label": "Triangle"
          }
        ]
      },
      {
        "id": "osc-bot.pattern",
        "key": "pattern",
        "label": "Step pattern",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 7
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "1"
          },
          {
            "value": 1,
            "label": "2"
          },
          {
            "value": 2,
            "label": "3"
          },
          {
            "value": 3,
            "label": "4"
          },
          {
            "value": 4,
            "label": "5"
          },
          {
            "value": 5,
            "label": "6"
          },
          {
            "value": 6,
            "label": "7"
          },
          {
            "value": 7,
            "label": "8"
          }
        ]
      },
      {
        "id": "osc-bot.tone",
        "key": "tone",
        "label": "Resonant filter cutoff",
        "unit": "Hz",
        "range": {
          "min": 100,
          "max": 16000
        },
        "defaultValue": 3000,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "osc-bot.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 70,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "preamp",
    "displayName": "PREAMP",
    "sourceIndex": 23,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Amp simulation",
    "algorithm": {
      "functionalDescription": "Input conditioning, triode/diode nonlinear stages, tone stack and cabinet response",
      "nativeBalancedChoice": "4x oversampled WDF/VA stages + state-space tone stack + short/partitioned cabinet IR",
      "browserBalancedChoice": "2x oversampled WDF/ADAA + minimum-phase 128–256 tap cabinet FIR",
      "formulaIds": [
        "F02",
        "F07",
        "F18",
        "F23"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "explicit-perceptual-inference",
      "statusNote": "Amp style names official; circuit is a clean-room approximation",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Native 88 fixed algorithm frames (24 oversampling + 64-tap group delay); Browser 16 fixed oversampling frames. At 48 kHz default voicing, the Browser full impulse peak is at frame 18 due to cabinet phase.",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "2x Blackman-sinc oversampling + first-order ADAA + analytic 129-tap cabinet FIR in AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "2x Blackman-sinc oversampling + first-order ADAA + analytic 129-tap cabinet FIR in AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "4x oversampled ADAA triode stages + prepared 129-tap per-model cabinet IR" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "4x oversampled ADAA triode stages + prepared 129-tap per-model cabinet IR" }
    ],
    "implementationNote": "Clean-room functional model wired to Browser Input A–D and shared post-mix Track A–D, plus Native Input A–D and shared Track A–D. Browser uses 16 fixed oversampling frames with a measured default-voicing impulse peak at frame 18; Native declares 88 fixed algorithm frames. Both cabinet responses are authored approximations, not measured Roland IRs. Six named controls persist per slot and are sent through each runtime adapter. No device-fidelity or full sound-quality acceptance is claimed.",
    "parameters": [
      {
        "id": "preamp.model",
        "key": "model",
        "label": "Preamp model",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 4
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Clean"
          },
          {
            "value": 1,
            "label": "Tweed"
          },
          {
            "value": 2,
            "label": "Stack"
          },
          {
            "value": 3,
            "label": "Lead"
          },
          {
            "value": 4,
            "label": "Bass"
          }
        ]
      },
      {
        "id": "preamp.gain",
        "key": "gain",
        "label": "Preamp gain",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 35,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "preamp.bass",
        "key": "bass",
        "label": "Bass",
        "unit": "dB",
        "range": {
          "min": -12,
          "max": 12
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "preamp.middle",
        "key": "middle",
        "label": "Middle",
        "unit": "dB",
        "range": {
          "min": -12,
          "max": 12
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "preamp.treble",
        "key": "treble",
        "label": "Treble",
        "unit": "dB",
        "range": {
          "min": -12,
          "max": 12
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "preamp.level",
        "key": "level",
        "label": "Output level",
        "unit": "dB",
        "range": {
          "min": -24,
          "max": 12
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "dist",
    "displayName": "DIST",
    "sourceIndex": 24,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Nonlinear",
    "algorithm": {
      "functionalDescription": "Preset-dependent overdrive/fuzz/metal waveshaping with pre/post EQ and anti-aliasing",
      "nativeBalancedChoice": "4x oversampling + WDF/ADAA; 8x optional render mode",
      "browserBalancedChoice": "2x oversampling + ADAA/WDF default; 4x only high-tier devices",
      "formulaIds": [
        "F02",
        "F07",
        "F23"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Filter delay 8–64 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room 4x sinc/ADAA distortion AudioWorklet (16-sample latency)" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room 4x sinc/ADAA distortion AudioWorklet (16-sample latency)" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native oversampled waveshaper catalog processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native oversampled waveshaper catalog processor" }
    ],
    "implementationNote": "Clean-room 4x sinc/ADAA distortion is wired to Browser input-bank and shared post-mix track-bank A-D slots. It does not implement the matrix WDF choice; Native A–D catalog routing is listed separately; per-loop-track processing is not claimed.",
    "parameters": [
      {
        "id": "dist.type",
        "key": "type",
        "label": "Drive type",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 2
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Overdrive"
          },
          {
            "value": 1,
            "label": "Fuzz"
          },
          {
            "value": 2,
            "label": "Metal"
          }
        ]
      },
      {
        "id": "dist.drive",
        "key": "drive",
        "label": "Drive",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 45,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "dist.tone",
        "key": "tone",
        "label": "Tone cutoff",
        "unit": "Hz",
        "range": {
          "min": 100,
          "max": 16000
        },
        "defaultValue": 5000,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "dist.level",
        "key": "level",
        "label": "Output level",
        "unit": "dB",
        "range": {
          "min": -24,
          "max": 12
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "dist.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 70,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "dynamics",
    "displayName": "DYNAMICS",
    "sourceIndex": 25,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Dynamics",
    "algorithm": {
      "functionalDescription": "Compressor/limiter/noise-suppressor preset macros",
      "nativeBalancedChoice": "Peak/RMS dual detector, log soft knee, optional 0.5–2 ms lookahead",
      "browserBalancedChoice": "Same in WASM; no lookahead on low-latency tier",
      "formulaIds": [
        "F01",
        "F08"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples in the Browser low-latency tier; optional lookahead is not implemented",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room stereo-linked peak/RMS compressor with F08 soft knee AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room stereo-linked peak/RMS compressor with F08 soft knee AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native compressor catalog processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native compressor catalog processor" }
    ],
    "implementationNote": "Browser compressor is wired into input-bank and shared post-mix track-bank A-D slots. The generic macro maps 0–100 to a 1:1–20:1 ratio at -18 dB threshold; peak/RMS, threshold, knee, attack, release and output are configurable by worklet message. Native also uses a separate clean-room catalog processor; per-loop-track routing is not claimed.",
    "parameters": [
      {
        "id": "dynamics.threshold",
        "key": "threshold",
        "label": "Threshold",
        "unit": "dB",
        "range": {
          "min": -60,
          "max": 0
        },
        "defaultValue": -18,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "dynamics.ratio",
        "key": "ratio",
        "label": "Compression ratio",
        "unit": "ratio",
        "range": {
          "min": 1,
          "max": 20
        },
        "defaultValue": 4,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "dynamics.attack",
        "key": "attack",
        "label": "Attack",
        "unit": "ms",
        "range": {
          "min": 0.1,
          "max": 100
        },
        "defaultValue": 10,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "dynamics.release",
        "key": "release",
        "label": "Release",
        "unit": "ms",
        "range": {
          "min": 5,
          "max": 1000
        },
        "defaultValue": 120,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "dynamics.output",
        "key": "output",
        "label": "Output level",
        "unit": "dB",
        "range": {
          "min": -24,
          "max": 12
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "eq",
    "displayName": "EQ",
    "sourceIndex": 26,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "EQ",
    "algorithm": {
      "functionalDescription": "Low/high shelves plus two peaking sections",
      "nativeBalancedChoice": "RBJ DF2T biquads; double-precision coefficient calculation, float processing",
      "browserBalancedChoice": "WASM DF2T; coefficient interpolation/smoothing",
      "formulaIds": [
        "F01",
        "F02"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "published-behavior-reconstruction",
      "statusNote": "Direct implementation of published EQ behavior",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room four-section RBJ EQ AudioWorklet with smoothed coefficient updates" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room four-section RBJ EQ AudioWorklet with smoothed coefficient updates" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native parametric EQ catalog processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native parametric EQ catalog processor" }
    ],
    "implementationNote": "Clean-room EQ is wired to Browser input and shared post-mix Track A-D slots, with low/high shelves and two peaking sections. Native has a separate catalog implementation. Provisional controls; not Roland hardware fidelity.",
    "parameters": [
      {
        "id": "eq.low-frequency",
        "key": "low-frequency",
        "label": "Low shelf frequency",
        "unit": "Hz",
        "range": {
          "min": 20,
          "max": 500
        },
        "defaultValue": 100,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "eq.low-gain",
        "key": "low-gain",
        "label": "Low shelf gain",
        "unit": "dB",
        "range": {
          "min": -15,
          "max": 15
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "eq.mid-1-frequency",
        "key": "mid-1-frequency",
        "label": "Mid 1 frequency",
        "unit": "Hz",
        "range": {
          "min": 80,
          "max": 8000
        },
        "defaultValue": 500,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "eq.mid-1-q",
        "key": "mid-1-q",
        "label": "Mid 1 Q",
        "unit": "ratio",
        "range": {
          "min": 0.1,
          "max": 12
        },
        "defaultValue": 1,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "eq.mid-1-gain",
        "key": "mid-1-gain",
        "label": "Mid 1 gain",
        "unit": "dB",
        "range": {
          "min": -15,
          "max": 15
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "eq.mid-2-frequency",
        "key": "mid-2-frequency",
        "label": "Mid 2 frequency",
        "unit": "Hz",
        "range": {
          "min": 80,
          "max": 12000
        },
        "defaultValue": 2500,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "eq.mid-2-q",
        "key": "mid-2-q",
        "label": "Mid 2 Q",
        "unit": "ratio",
        "range": {
          "min": 0.1,
          "max": 12
        },
        "defaultValue": 1,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "eq.mid-2-gain",
        "key": "mid-2-gain",
        "label": "Mid 2 gain",
        "unit": "dB",
        "range": {
          "min": -15,
          "max": 15
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "eq.high-frequency",
        "key": "high-frequency",
        "label": "High shelf frequency",
        "unit": "Hz",
        "range": {
          "min": 1000,
          "max": 20000
        },
        "defaultValue": 8000,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "eq.high-gain",
        "key": "high-gain",
        "label": "High shelf gain",
        "unit": "dB",
        "range": {
          "min": -15,
          "max": 15
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "isolator",
    "displayName": "ISOLATOR",
    "sourceIndex": 27,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Multiband/gate",
    "algorithm": {
      "functionalDescription": "3-band crossover, independent gain/cut and tempo-rate gating",
      "nativeBalancedChoice": "TPT/Linkwitz–Riley 4th-order crossover; smoothed band gains",
      "browserBalancedChoice": "TPT crossover; sample-clocked BPM-following gate in Worklet",
      "formulaIds": [
        "F01",
        "F03",
        "F16",
        "F20"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room TPT three-band isolator with smoothed band gains and BPM-following sample-clock gate in the AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room TPT three-band isolator with smoothed band gains and BPM-following sample-clock gate in the AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room fourth-order Linkwitz–Riley three-band crossover with smoothed gains and sample-clock gate" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room fourth-order Linkwitz–Riley three-band crossover with smoothed gains and sample-clock gate" }
    ],
    "implementationNote": "Clean-room ISOLATOR is wired to Browser and Native Input banks and shared Track A–D banks. The Native version uses two fourth-order Linkwitz–Riley splits. Band gains and gate controls are provisional; the Browser gate follows BPM with a free-running local phase and is not a factory-DSP or downbeat-phase reproduction.",
    "parameters": [
      {
        "id": "isolator.low",
        "key": "low",
        "label": "Low band gain",
        "unit": "dB",
        "range": {
          "min": -60,
          "max": 12
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "isolator.mid",
        "key": "mid",
        "label": "Mid band gain",
        "unit": "dB",
        "range": {
          "min": -60,
          "max": 12
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "isolator.high",
        "key": "high",
        "label": "High band gain",
        "unit": "dB",
        "range": {
          "min": -60,
          "max": 12
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "isolator.gate-rate",
        "key": "gate-rate",
        "label": "Gate rate",
        "unit": "beats",
        "range": {
          "min": 0.25,
          "max": 4
        },
        "defaultValue": 0.5,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0.25,
            "label": "1/16"
          },
          {
            "value": 0.5,
            "label": "1/8"
          },
          {
            "value": 1,
            "label": "1/4"
          },
          {
            "value": 2,
            "label": "1/2"
          },
          {
            "value": 4,
            "label": "1 bar"
          }
        ]
      },
      {
        "id": "isolator.gate-depth",
        "key": "gate-depth",
        "label": "Gate depth",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "octave",
    "displayName": "OCTAVE",
    "sourceIndex": 28,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Pitch",
    "algorithm": {
      "functionalDescription": "Mix three fixed -24/-12/+12 pitch-shift voices with independent level controls; formant and pitch-tracking controls unsupported",
      "nativeBalancedChoice": "Three independent Signalsmith Stretch streaming voices with shared aligned dry path",
      "browserBalancedChoice": "Three independent Signalsmith Stretch AudioWorklet voices with shared aligned dry path",
      "formulaIds": [
        "F09",
        "F10",
        "F11",
        "F12"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Signalsmith algorithm latency at 48 kHz: 40 ms Native, 24 ms Browser; three pitch voices run in parallel",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Three independent Signalsmith Stretch 1.3.2 AudioWorklet voices at -24/-12/+12 semitones with aligned dry and independent voice levels" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Three independent Signalsmith Stretch 1.3.2 AudioWorklet voices on shared post-mix Track A–D with aligned dry and independent voice levels" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Three independent Signalsmith Stretch 1.3.2 voices on Native Input A–D with aligned dry and independent voice levels" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Three independent Signalsmith Stretch 1.3.2 voices on shared post-mix Track A–D with aligned dry and independent voice levels" }
    ],
    "implementationNote": "Connected three fixed-shift Signalsmith voices at -24, -12 and +12 semitones with independent levels, an overall harmony-layer mix, and latency-aligned full-level dry. Pitch-tracking sensitivity and formant preservation remain unsupported and are rejected. This clean-room reconstruction is not quality-admitted or a claim of Roland firmware fidelity.",
    "parameters": [
      {
        "id": "octave.minus_24_level",
        "key": "minus_24_level",
        "label": "-24 semitone level",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "octave.minus_12_level",
        "key": "minus_12_level",
        "label": "-12 semitone level",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 40,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "octave.plus_12_level",
        "key": "plus_12_level",
        "label": "+12 semitone level",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "octave.tracking_percent",
        "key": "tracking_percent",
        "label": "Tracking sensitivity",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 60,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "octave.mix_percent",
        "key": "mix_percent",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 70,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "auto-pan",
    "displayName": "AUTO PAN",
    "sourceIndex": 29,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Pan modulation",
    "algorithm": {
      "functionalDescription": "Equal-power mono pan and stereo mid/side pan driven by LFO",
      "nativeBalancedChoice": "Per-sample or 16-sample-ramped equal-power gains",
      "browserBalancedChoice": "Smoothed equal-power pan and stereo mid/side processing in one AudioWorklet",
      "formulaIds": [
        "F01",
        "F06",
        "F21"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room equal-power mono/stereo autopan AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room equal-power mono/stereo autopan AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native stereo auto-pan catalog processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native stereo auto-pan catalog processor" }
    ],
    "implementationNote": "Clean-room sine/triangle/polyBLEP-square LFO drives equal-power mono panning or stereo mid/side panning through Browser input A–D and shared track A–D slots. Tempo sync is not implemented; Native has a separate clean-room catalog processor.",
    "parameters": [
      {
        "id": "auto-pan.rate",
        "key": "rate",
        "label": "Rate",
        "unit": "Hz",
        "range": {
          "min": 0.05,
          "max": 20
        },
        "defaultValue": 0.5,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "auto-pan.depth",
        "key": "depth",
        "label": "Pan depth",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 70,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "auto-pan.waveform",
        "key": "waveform",
        "label": "LFO waveform",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 2
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Sine"
          },
          {
            "value": 1,
            "label": "Triangle"
          },
          {
            "value": 2,
            "label": "Square"
          }
        ]
      }
    ]
  },
  {
    "id": "manual-pan",
    "displayName": "MANUAL PAN",
    "sourceIndex": 30,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Pan",
    "algorithm": {
      "functionalDescription": "Equal-power pan controlled by knob/assign/pedal",
      "nativeBalancedChoice": "Smoothed equal-power gains",
      "browserBalancedChoice": "Same in WASM",
      "formulaIds": [
        "F01",
        "F21"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room equal-power mono panner and smoothed stereo balance AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room equal-power mono panner and smoothed stereo balance AudioWorklet" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native stereo manual-pan catalog processor" }
    ],
    "implementationNote": "Clean-room equal-power mono panning is wired to Browser input and shared post-mix Track A-D slots; stereo input uses a center-preserving balance curve. Native supports only the shared stereo output-bus Track A–D bank; Native Input remains unavailable because its capture path is mono, and per-loop-track processing or Roland hardware fidelity is not claimed.",
    "parameters": [
      {
        "id": "manual-pan.position",
        "key": "position",
        "label": "Pan position",
        "unit": "%",
        "range": {
          "min": -100,
          "max": 100
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "stereo-enhance",
    "displayName": "STEREO ENHANCE",
    "sourceIndex": 31,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Stereo",
    "algorithm": {
      "functionalDescription": "Mid/side width, frequency-selective side gain and all-pass decorrelation",
      "nativeBalancedChoice": "M/S matrix + low-frequency mono protection + decorrelating APF",
      "browserBalancedChoice": "M/S + one/two APF sections; correlation safety limiter",
      "formulaIds": [
        "F01",
        "F04",
        "F22"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room M/S width with LF mono protection and all-pass side decorrelation AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room M/S width with LF mono protection and all-pass side decorrelation AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native mid/side stereo-enhance processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native mid/side stereo-enhance processor" }
    ],
    "implementationNote": "Clean-room STEREO ENHANCE is wired to Browser input-bank and shared track-bank A-D slots. Native A–D catalog routing is listed separately; per-loop-track processing is not claimed.",
    "parameters": [
      {
        "id": "stereo-enhance.width",
        "key": "width",
        "label": "Stereo width",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 200
        },
        "defaultValue": 100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "stereo-enhance.low-mono-cutoff",
        "key": "low-mono-cutoff",
        "label": "Low mono cutoff",
        "unit": "Hz",
        "range": {
          "min": 20,
          "max": 1000
        },
        "defaultValue": 120,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "stereo-enhance.decorrelation",
        "key": "decorrelation",
        "label": "Decorrelation",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 25,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "stereo-enhance.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "tremolo",
    "displayName": "TREMOLO",
    "sourceIndex": 32,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Amplitude modulation",
    "algorithm": {
      "functionalDescription": "Amplitude LFO with selectable waveform and depth",
      "nativeBalancedChoice": "Band-limited LFO; smoothed depth",
      "browserBalancedChoice": "Smoothed amplitude LFO in one AudioWorklet",
      "formulaIds": [
        "F01",
        "F06"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room band-limited amplitude LFO AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room band-limited amplitude LFO AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native amplitude-modulation catalog processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native amplitude-modulation catalog processor" }
    ],
    "implementationNote": "Clean-room sine/triangle/polyBLEP-square amplitude LFO is wired through Browser input A–D and shared track A–D slots. No tempo-sync or Native implementation is claimed.",
    "parameters": [
      {
        "id": "tremolo.rate",
        "key": "rate",
        "label": "Rate",
        "unit": "Hz",
        "range": {
          "min": 0.05,
          "max": 20
        },
        "defaultValue": 4,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "tremolo.depth",
        "key": "depth",
        "label": "Depth",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 50,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "tremolo.waveform",
        "key": "waveform",
        "label": "LFO waveform",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 2
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Sine"
          },
          {
            "value": 1,
            "label": "Triangle"
          },
          {
            "value": 2,
            "label": "Square"
          }
        ]
      }
    ]
  },
  {
    "id": "vibrato",
    "displayName": "VIBRATO",
    "sourceIndex": 33,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Modulated delay",
    "algorithm": {
      "functionalDescription": "Wet-only fractional delay modulated by LFO; optional multi-LFO color",
      "nativeBalancedChoice": "4-point Lagrange read head; 2 voices for vintage color",
      "browserBalancedChoice": "One Lagrange voice default; second voice high-tier",
      "formulaIds": [
        "F01",
        "F05",
        "F06"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "<1 sample plus intentional delay",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room stereo modulated-delay AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room stereo modulated-delay AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native fractional-delay vibrato catalog processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native fractional-delay vibrato catalog processor" }
    ],
    "implementationNote": "Clean-room VIBRATO is wired to Browser input-bank and shared track-bank A-D slots. The delay/LFO controls and stereo channel phase offset are authored provisional choices, not verified Roland controls or an official-device emulation. Native also uses a separate clean-room catalog processor; controls remain provisional.",
    "parameters": [
      {
        "id": "vibrato.rate",
        "key": "rate",
        "label": "Rate",
        "unit": "Hz",
        "range": {
          "min": 0.05,
          "max": 20
        },
        "defaultValue": 5,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "vibrato.depth",
        "key": "depth",
        "label": "Depth",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 35,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "vibrato.delay",
        "key": "delay",
        "label": "Base delay",
        "unit": "ms",
        "range": {
          "min": 0.2,
          "max": 10
        },
        "defaultValue": 2,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "vibrato.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "pattern-slicer",
    "displayName": "PATTERN SLICER",
    "sourceIndex": 34,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Rhythmic gate",
    "algorithm": {
      "functionalDescription": "Preset step table controls smooth gain envelope, synced to tempo",
      "nativeBalancedChoice": "Sample-accurate scheduler + raised-cosine 0.5–2 ms edges",
      "browserBalancedChoice": "Worklet sample counter + table; never schedule many AudioBufferSourceNodes",
      "formulaIds": [
        "F16",
        "F20"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room sample-clocked eight-pattern gate with raised-cosine edges in Browser AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room sample-clocked eight-pattern gate with raised-cosine edges in Browser AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room sample-clocked eight-pattern gate with raised-cosine edges in Native C++" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room sample-clocked eight-pattern gate with raised-cosine edges in Native C++" }
    ],
    "implementationNote": "Clean-room sample-clocked PATTERN SLICER is wired to Browser Input A–D and Native Input/Track A–D shared playback buses. Per-loop-track targeting and sound-quality acceptance are not claimed.",
    "parameters": [
      {
        "id": "pattern-slicer.pattern",
        "key": "pattern",
        "label": "Pattern",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 7
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "1"
          },
          {
            "value": 1,
            "label": "2"
          },
          {
            "value": 2,
            "label": "3"
          },
          {
            "value": 3,
            "label": "4"
          },
          {
            "value": 4,
            "label": "5"
          },
          {
            "value": 5,
            "label": "6"
          },
          {
            "value": 6,
            "label": "7"
          },
          {
            "value": 7,
            "label": "8"
          }
        ]
      },
      {
        "id": "pattern-slicer.rate",
        "key": "rate",
        "label": "Step rate",
        "unit": "beats",
        "range": {
          "min": 0.25,
          "max": 4
        },
        "defaultValue": 0.25,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0.25,
            "label": "1/16"
          },
          {
            "value": 0.5,
            "label": "1/8"
          },
          {
            "value": 1,
            "label": "1/4"
          },
          {
            "value": 2,
            "label": "1/2"
          },
          {
            "value": 4,
            "label": "1 bar"
          }
        ]
      },
      {
        "id": "pattern-slicer.depth",
        "key": "depth",
        "label": "Gate depth",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "pattern-slicer.edge",
        "key": "edge",
        "label": "Edge smoothing",
        "unit": "ms",
        "range": {
          "min": 0.5,
          "max": 20
        },
        "defaultValue": 2,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "step-slicer",
    "displayName": "STEP SLICER",
    "sourceIndex": 35,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Rhythmic gate",
    "algorithm": {
      "functionalDescription": "Editable 4/8/16-step amplitude sequence with shared pan and filter controls",
      "nativeBalancedChoice": "Sample-clocked step envelope with shared output pan and low-pass controls",
      "browserBalancedChoice": "Worklet table, parameter mailbox and sample-accurate edges",
      "formulaIds": [
        "F01",
        "F16",
        "F20",
        "F21"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room sample-clocked 4/8/16-step gain table with smoothed transitions in Browser AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room sample-clocked 4/8/16-step gain table with smoothed transitions in Browser AudioWorklet after TrackMix" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room sample-clocked 4/8/16-step gain table with smoothed transitions in Native C++" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room sample-clocked 4/8/16-step gain table with shared-bus pan and low-pass in Native C++" }
    ],
    "implementationNote": "Clean-room STEP SLICER is wired to Browser Input A–D and shared post-mix Track A–D, plus Native Input A–D and the summed shared Track A–D bus. It exposes 16 amplitude levels, selectable step count/rate, depth and shared pan/filter controls. Per-loop-track targeting, Roland fidelity and sound-quality acceptance are not claimed.",
    "parameters": [
      {
        "id": "step-slicer.step-count",
        "key": "step-count",
        "label": "Step count",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 2
        },
        "defaultValue": 2,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "4"
          },
          {
            "value": 1,
            "label": "8"
          },
          {
            "value": 2,
            "label": "16"
          }
        ]
      },
      {
        "id": "step-slicer.rate",
        "key": "rate",
        "label": "Step rate",
        "unit": "beats",
        "range": {
          "min": 0.25,
          "max": 4
        },
        "defaultValue": 0.25,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0.25,
            "label": "1/16"
          },
          {
            "value": 0.5,
            "label": "1/8"
          },
          {
            "value": 1,
            "label": "1/4"
          },
          {
            "value": 2,
            "label": "1/2"
          },
          {
            "value": 4,
            "label": "1 bar"
          }
        ]
      },
      {
        "id": "step-slicer.depth",
        "key": "depth",
        "label": "Gate depth",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "step-slicer.pan-depth",
        "key": "pan-depth",
        "label": "Per-step pan depth",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "step-slicer.filter",
        "key": "filter",
        "label": "Per-step filter cutoff",
        "unit": "Hz",
        "range": {
          "min": 20,
          "max": 20000
        },
        "defaultValue": 20000,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "delay",
    "displayName": "DELAY",
    "sourceIndex": 36,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Delay",
    "algorithm": {
      "functionalDescription": "Circular buffer, fractional read, feedback filter/saturation and tempo sync",
      "nativeBalancedChoice": "4-point Lagrange for modulation; 8-tap sinc for static resampling taps",
      "browserBalancedChoice": "Lagrange in WASM; memory preallocated by maximum delay",
      "formulaIds": [
        "F01",
        "F05",
        "F14",
        "F20"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Intentional delay only; no additional fixed pipeline latency",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room stereo 4-point Lagrange circular-buffer delay AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room stereo 4-point Lagrange circular-buffer delay AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native fractional-delay catalog processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native fractional-delay catalog processor" }
    ],
    "implementationNote": "Browser fixed-delay algorithm is wired to input-bank and shared post-mix track-bank A-D slots. Its generic macro maps amount to wet mix; delay time, filtered feedback, and tone are configurable by worklet message. This does not imply tempo-synced delay or per-loop-track routing; Native uses a separate clean-room catalog processor.",
    "parameters": [
      {
        "id": "delay.time",
        "key": "time",
        "label": "Delay time",
        "unit": "ms",
        "range": {
          "min": 1,
          "max": 2000
        },
        "defaultValue": 500,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "delay.feedback",
        "key": "feedback",
        "label": "Feedback",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 95
        },
        "defaultValue": 30,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "delay.tone",
        "key": "tone",
        "label": "Feedback tone cutoff",
        "unit": "Hz",
        "range": {
          "min": 100,
          "max": 16000
        },
        "defaultValue": 8000,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "delay.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 25,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "panning-delay",
    "displayName": "PANNING DELAY",
    "sourceIndex": 37,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Stereo delay",
    "algorithm": {
      "functionalDescription": "Two delay lines with cross-feedback and equal-power repeat panning",
      "nativeBalancedChoice": "2x2 stable feedback matrix + Lagrange taps",
      "browserBalancedChoice": "Same in one preallocated Browser AudioWorklet",
      "formulaIds": [
        "F05",
        "F14",
        "F20",
        "F21"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "0 fixed pipeline samples; intentional repeat delay",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room stereo fractional-delay AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room stereo fractional-delay AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room stereo fractional-delay catalog processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room stereo fractional-delay catalog processor" }
    ],
    "implementationNote": "PANNING DELAY is wired to Browser and Native Input A–D and shared Track A–D banks. Both are clean-room reconstructions of the documented delay/pan function; the feedback and pan law are not verified against hardware. Browser Track remains post-mix, while Native processes mono loop playback through a stereo output-bus Track bank; this does not imply per-loop-track processing.",
    "parameters": [
      {
        "id": "panning-delay.time",
        "key": "time",
        "label": "Delay time",
        "unit": "ms",
        "range": {
          "min": 1,
          "max": 2000
        },
        "defaultValue": 500,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "panning-delay.feedback",
        "key": "feedback",
        "label": "Feedback",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 95
        },
        "defaultValue": 30,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "panning-delay.pan",
        "key": "pan",
        "label": "Repeat pan",
        "unit": "%",
        "range": {
          "min": -100,
          "max": 100
        },
        "defaultValue": 70,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "panning-delay.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 25,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "reverse-delay",
    "displayName": "REVERSE DELAY",
    "sourceIndex": 38,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Reverse delay",
    "algorithm": {
      "functionalDescription": "Alternating segments written forward/read backward with overlap crossfade",
      "nativeBalancedChoice": "Dual fixed stereo segment buffers and bounded wet-lookahead equal-power fades",
      "browserBalancedChoice": "Dual fixed stereo segment buffers with beat-quantized capture and boundary fades",
      "formulaIds": [
        "F14",
        "F20",
        "F25"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Browser: one active capture segment. Native: one active capture segment plus fixed 100 ms wet lookahead; both scale with tempo, segment length and sample rate.",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room beat-quantized reverse-segment AudioWorklet with bounded feedback and equal-power boundaries" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room beat-quantized reverse-segment AudioWorklet with bounded feedback and equal-power boundaries" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room bounded reverse-segment processor with sample-clocked capture and wet lookahead" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room bounded reverse-segment processor with sample-clocked capture and wet lookahead" }
    ],
    "implementationNote": "REVERSE DELAY is wired to Browser and Native Input A–D and shared Track A–D banks. Segment capture, timing, feedback and boundary transitions are clean-room functional reconstructions; Browser/Native latency differs, Browser Track remains post-mix and Native Track is shared after loop summing. This does not imply per-loop-track targeting or sound-quality acceptance.",
    "parameters": [
      {
        "id": "reverse-delay.time",
        "key": "time",
        "label": "Segment length",
        "unit": "beats",
        "range": {
          "min": 0.25,
          "max": 4
        },
        "defaultValue": 1,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0.25,
            "label": "1/16"
          },
          {
            "value": 0.5,
            "label": "1/8"
          },
          {
            "value": 1,
            "label": "1/4"
          },
          {
            "value": 2,
            "label": "1/2"
          },
          {
            "value": 4,
            "label": "1 bar"
          }
        ]
      },
      {
        "id": "reverse-delay.feedback",
        "key": "feedback",
        "label": "Feedback",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 95
        },
        "defaultValue": 20,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "reverse-delay.crossfade",
        "key": "crossfade",
        "label": "Crossfade",
        "unit": "ms",
        "range": {
          "min": 1,
          "max": 100
        },
        "defaultValue": 20,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "reverse-delay.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 30,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "mod-delay",
    "displayName": "MOD DELAY",
    "sourceIndex": 39,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Modulated delay",
    "algorithm": {
      "functionalDescription": "Long delay with LFO-modulated fractional read and filtered feedback",
      "nativeBalancedChoice": "Lagrange interpolation; parameter smoothing; feedback saturation",
      "browserBalancedChoice": "Fixed stereo delay lines with four-point Lagrange reads; cap modulation depth near buffer boundaries",
      "formulaIds": [
        "F01",
        "F05",
        "F06",
        "F14"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Intentional delay only",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room stereo modulated fractional delay with Lagrange4 reads and filtered contractive feedback" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room stereo modulated fractional delay with Lagrange4 reads and filtered contractive feedback" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room stereo modulated fractional delay with smoothed parameters and bounded feedback" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room stereo modulated fractional delay with smoothed parameters and bounded feedback" }
    ],
    "implementationNote": "Browser MOD DELAY is connected to Input and shared post-mix Track A-D Worklet slots; Native MOD DELAY is connected to Input and shared Track A-D serial banks. All parameter bounds and feedback/filter laws are clean-room provisional; no Roland topology, device latency or quality acceptance is claimed.",
    "parameters": [
      {
        "id": "mod-delay.time",
        "key": "time",
        "label": "Delay time",
        "unit": "ms",
        "range": {
          "min": 10,
          "max": 2000
        },
        "defaultValue": 500,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "mod-delay.rate",
        "key": "rate",
        "label": "Modulation rate",
        "unit": "Hz",
        "range": {
          "min": 0.05,
          "max": 10
        },
        "defaultValue": 0.3,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "mod-delay.depth",
        "key": "depth",
        "label": "Modulation depth",
        "unit": "ms",
        "range": {
          "min": 0,
          "max": 50
        },
        "defaultValue": 10,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "mod-delay.feedback",
        "key": "feedback",
        "label": "Feedback",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 95
        },
        "defaultValue": 25,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "mod-delay.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 25,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "tape-echo",
    "displayName": "TAPE ECHO",
    "sourceIndex": 40,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Tape delay",
    "algorithm": {
      "functionalDescription": "Multi-head delay, wow/flutter, frequency-dependent loss, saturation and hiss",
      "nativeBalancedChoice": "4-point Lagrange heads + 4x nonlinear record/repro path + feedback LPF",
      "browserBalancedChoice": "Lagrange heads + 2x ADAA + filtered noise; fewer heads on low tier",
      "formulaIds": [
        "F02",
        "F05",
        "F06",
        "F07",
        "F14",
        "F20"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Intentional head delay + 8–64 filter samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "implementationNote": "Browser clean-room TAPE ECHO DSP is wired through input A–D and shared post-mix Track A–D FX slots; Native uses its separate catalog processor.",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "BrowserTapeEchoDsp in the variable-quantum AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "BrowserTapeEchoDsp in the variable-quantum AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Native native_tape_echo processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Native native_tape_echo processor" }
    ],
    "parameters": [
      {
        "id": "tape-echo.time",
        "key": "time",
        "label": "Head delay",
        "unit": "ms",
        "range": {
          "min": 20,
          "max": 2000
        },
        "defaultValue": 350,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "tape-echo.feedback",
        "key": "feedback",
        "label": "Feedback",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 95
        },
        "defaultValue": 35,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "tape-echo.wow",
        "key": "wow",
        "label": "Wow/flutter",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 15,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "tape-echo.saturation",
        "key": "saturation",
        "label": "Tape saturation",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 25,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "tape-echo.tone",
        "key": "tone",
        "label": "Tape loss cutoff",
        "unit": "Hz",
        "range": {
          "min": 500,
          "max": 16000
        },
        "defaultValue": 6000,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "tape-echo.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 30,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "granular-delay",
    "displayName": "GRANULAR DELAY",
    "sourceIndex": 41,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Granular",
    "algorithm": {
      "functionalDescription": "Overlapped windowed grains with controllable size, density, pitch and position jitter",
      "nativeBalancedChoice": "2–8 voices, Hann/sqrt-Hann windows, sinc8 static or Lagrange moving reads",
      "browserBalancedChoice": "16-voice bounded overlap pool, Hann windows, Lagrange reads, no callback allocation; grain duration is bounded by voice budget at high density",
      "formulaIds": [
        "F05",
        "F09",
        "F15",
        "F20"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Half grain typical",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Hann-windowed stereo granular delay AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Hann-windowed stereo granular delay AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native bounded granular-delay catalog processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native bounded granular-delay catalog processor" }
    ],
    "implementationNote": "Clean-room granular DSP is wired to Browser input-bank and shared track-bank A–D slots. A fixed 16-voice pool bounds overlap and callback work; at maximum density, effective grain duration is limited by the voice budget. Native routing is listed in the shared catalog targets above.",
    "parameters": [
      {
        "id": "granular-delay.grain-size",
        "key": "grain-size",
        "label": "Grain size",
        "unit": "ms",
        "range": {
          "min": 10,
          "max": 1000
        },
        "defaultValue": 120,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "granular-delay.density",
        "key": "density",
        "label": "Grain density",
        "unit": "Hz",
        "range": {
          "min": 1,
          "max": 80
        },
        "defaultValue": 12,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "granular-delay.pitch",
        "key": "pitch",
        "label": "Grain pitch",
        "unit": "semitones",
        "range": {
          "min": -24,
          "max": 24
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "granular-delay.jitter",
        "key": "jitter",
        "label": "Position jitter",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 15,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "granular-delay.feedback",
        "key": "feedback",
        "label": "Feedback",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 95
        },
        "defaultValue": 15,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "granular-delay.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 35,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "warp",
    "displayName": "WARP",
    "sourceIndex": 42,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Granular/freeze macro",
    "algorithm": {
      "functionalDescription": "Tempo-synced capture/freeze, diffuse feedback, pitch smear and filtered regeneration",
      "nativeBalancedChoice": "Granular freeze + FDN8 feedback; spectral mode high tier only",
      "browserBalancedChoice": "Spectral/granular freeze + FDN-like feedback macro",
      "formulaIds": [
        "F12",
        "F15",
        "F17",
        "F19",
        "F20"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "explicit-perceptual-inference",
      "statusNote": "Name/parameters official; topology is an explicitly marked perceptual inference",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "10–40 ms",
    "implementationStatus": "experimental",
    "runtimeSupport": "experimental",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Experimental clean-room tempo-sized granular capture, pitch-smear grain reader and bounded eight-line FDN feedback in AudioWorklet; no spectral mode" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Same experimental Browser WARP processor in the shared Track A-D bank; no spectral mode" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Experimental clean-room tempo-sized granular capture, pitch-smear grain reader and bounded eight-line FDN feedback; no spectral mode" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Same experimental Native WARP processor in the shared Track A-D catalog bank; no spectral mode" }
    ],
    "implementationNote": "Experimental clean-room lower-tier implementation: tempo-sized stereo history capture with bounded Hann-windowed granular pitch smearing, deterministic two-bank freeze, and an eight-line normalized Hadamard FDN with contractive feedback. The high-tier spectral mode is unsupported and rejected by omission. Browser Input/shared Track A-D and Native Input/shared Track A-D banks are wired; Native Track A-D remains the summed playback bus, not per-loop-track FX. Source row 42's topology is an explicitly marked perceptual inference. No Roland source, firmware, spectral-mode or sound-quality acceptance claim.",
    "parameters": [
      {
        "id": "warp.capture",
        "key": "capture",
        "label": "Capture length",
        "unit": "beats",
        "range": {
          "min": 0.25,
          "max": 4
        },
        "defaultValue": 1,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0.25,
            "label": "1/16"
          },
          {
            "value": 0.5,
            "label": "1/8"
          },
          {
            "value": 1,
            "label": "1/4"
          },
          {
            "value": 2,
            "label": "1/2"
          },
          {
            "value": 4,
            "label": "1 bar"
          }
        ]
      },
      {
        "id": "warp.smear",
        "key": "smear",
        "label": "Pitch smear",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 30,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "warp.pitch",
        "key": "pitch",
        "label": "Pitch shift",
        "unit": "semitones",
        "range": {
          "min": -24,
          "max": 24
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "warp.feedback",
        "key": "feedback",
        "label": "Regeneration",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 95
        },
        "defaultValue": 20,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "warp.freeze",
        "key": "freeze",
        "label": "Capture hold",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 1
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          { "value": 0, "label": "Live grains" },
          { "value": 1, "label": "Hold captured audio" }
        ]
      },
      {
        "id": "warp.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 40,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "twist",
    "displayName": "TWIST",
    "sourceIndex": 43,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Performance macro",
    "algorithm": {
      "functionalDescription": "Single control couples delay time/rate, pitch, feedback, pan and filter along a nonlinear trajectory",
      "nativeBalancedChoice": "Variable-rate delay + safe feedback saturator + filter/pan macro",
      "browserBalancedChoice": "Same modules; precomputed trajectory table",
      "formulaIds": [
        "F01",
        "F03",
        "F05",
        "F06",
        "F07",
        "F14",
        "F21"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "explicit-perceptual-inference",
      "statusNote": "Topology is an explicitly marked perceptual inference",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Intentional delay",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room stereo variable-rate delay, precomputed macro curves, bounded saturated feedback and filter/pan coupling in AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Same Browser TWIST processor in the shared Track A-D bank" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native stereo variable-rate delay with bounded saturated feedback and filter/pan coupling" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Same Native TWIST processor in the shared Track A-D catalog bank" }
    ],
    "implementationNote": "Clean-room functional reconstruction of the TWIST macro: the signed amount control selects a smoothed nonlinear delay/rate trajectory with coupled feedback, tone and pan; trajectory values are provisional authored curves because the referenced algorithm-matrix CSV is absent from this checkout. Wired to Browser Input and shared post-mix Track A-D banks plus Native Input and shared Track A-D catalog banks. Native Track A-D remains the summed playback bus, not per-loop-track FX. No Roland source, firmware or hardware-fidelity claim.",
    "parameters": [
      {
        "id": "twist.amount",
        "key": "amount",
        "label": "Macro amount",
        "unit": "%",
        "range": {
          "min": -100,
          "max": 100
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "twist.trajectory",
        "key": "trajectory",
        "label": "Trajectory",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 3
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Smooth"
          },
          {
            "value": 1,
            "label": "Rise"
          },
          {
            "value": 2,
            "label": "Fall"
          },
          {
            "value": 3,
            "label": "Stepped"
          }
        ]
      },
      {
        "id": "twist.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 50,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "roll",
    "displayName": "ROLL",
    "sourceIndex": 44,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Beat repeat",
    "algorithm": {
      "functionalDescription": "Capture quantized short segment and retrigger with optional pitch/decay/reverse",
      "nativeBalancedChoice": "Dual buffers, zero-cross or equal-power transitions, sample-accurate beat clock",
      "browserBalancedChoice": "Fixed capture pool in Worklet; Lagrange for pitch/rate",
      "formulaIds": [
        "F05",
        "F15",
        "F20",
        "F25"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "One selected slice is captured before wet playback begins; at the default 0.5 beat, 120 BPM and 48 kHz this is 12,000 samples (250 ms). It scales with slice length, tempo, and sample rate.",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Browser AudioWorklet sample-clocked stereo dual-buffer capture/retrigger with four-point fractional playback-rate resampling" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Browser shared Track A-D AudioWorklet sample-clocked stereo dual-buffer capture/retrigger with four-point fractional playback-rate resampling" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Native Input A-D catalog processor with fixed preallocated stereo capture buffers and four-point playback-rate resampling" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Native shared Track A-D catalog processor with fixed preallocated stereo capture buffers and four-point playback-rate resampling" }
    ],
    "implementationNote": "Clean-room ROLL automatically captures and retriggers tempo-quantized slices while active, with decay, forward/reverse/alternate playback and playback-rate pitch. Pitch changes sample traversal duration rather than time-stretching the source. Native Track FX apply to the shared sum, not independent loop tracks. Provisional controls and DSP are not quality-accepted and are not a Roland reproduction.",
    "parameters": [
      {
        "id": "roll.slice",
        "key": "slice",
        "label": "Roll slice",
        "unit": "beats",
        "range": {
          "min": 0.25,
          "max": 4
        },
        "defaultValue": 0.5,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0.25,
            "label": "1/16"
          },
          {
            "value": 0.5,
            "label": "1/8"
          },
          {
            "value": 1,
            "label": "1/4"
          },
          {
            "value": 2,
            "label": "1/2"
          },
          {
            "value": 4,
            "label": "1 bar"
          }
        ]
      },
      {
        "id": "roll.decay",
        "key": "decay",
        "label": "Decay",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 20,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "roll.pitch",
        "key": "pitch",
        "label": "Playback shift",
        "unit": "semitones",
        "range": {
          "min": -24,
          "max": 24
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "roll.direction",
        "key": "direction",
        "label": "Playback direction",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 2
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Forward"
          },
          {
            "value": 1,
            "label": "Reverse"
          },
          {
            "value": 2,
            "label": "Alternate"
          }
        ]
      },
      {
        "id": "roll.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 50,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "freeze",
    "displayName": "FREEZE",
    "sourceIndex": 45,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Freeze",
    "algorithm": {
      "functionalDescription": "Capture loop or freeze STFT magnitude/phase evolution; hold indefinitely",
      "nativeBalancedChoice": "Dual mode: spectral freeze for HQ, micro-loop with decorrelation for zero-risk live",
      "browserBalancedChoice": "Micro-loop default; 1024/256 STFT spectral freeze on capable devices",
      "formulaIds": [
        "F12",
        "F19",
        "F25"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Loop mode 2–20 ms; spectral ~16 ms",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room stereo micro-loop FREEZE AudioWorklet; variable block sizes" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room stereo micro-loop FREEZE AudioWorklet; shared post-mix A–D bank" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room stereo micro-loop FREEZE Native processor; variable block sizes" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room stereo micro-loop FREEZE Native processor; shared post-mix A–D bank" }
    ],
    "implementationNote": "Both runtimes are wired to Input and Track A–D catalog slots. Only clean-room micro-loop mode is implemented; spectral/STFT mode is explicitly rejected. Pitch is varispeed and changes repeat duration. Captured PCM is volatile and resets on reload. Latency, click-free Native release, and sound-quality admission are not yet accepted or measured; this does not claim Roland DSP fidelity.",
    "parameters": [
      {
        "id": "freeze.capture-length",
        "key": "capture-length",
        "label": "Capture length",
        "unit": "ms",
        "range": {
          "min": 2,
          "max": 2000
        },
        "defaultValue": 250,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "freeze.mode",
        "key": "mode",
        "label": "Freeze mode",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 1
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Micro-loop"
          },
          {
            "value": 1,
            "label": "Spectral"
          }
        ]
      },
      {
        "id": "freeze.pitch",
        "key": "pitch",
        "label": "Pitch shift",
        "unit": "semitones",
        "range": {
          "min": -24,
          "max": 24
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "freeze.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "chorus",
    "displayName": "CHORUS",
    "sourceIndex": 46,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Modulated delay",
    "algorithm": {
      "functionalDescription": "2–4 decorrelated fractional delay voices, stereo phase offsets, optional feedback",
      "nativeBalancedChoice": "4-point Lagrange, 2–4 voices, filtered modulation",
      "browserBalancedChoice": "2 voices default, 4 voices high-tier",
      "formulaIds": [
        "F01",
        "F05",
        "F06",
        "F21"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Intentional 5–30 ms delay; no additional fixed pipeline latency",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room stereo 2–4 voice 4-point Lagrange chorus AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room stereo 2–4 voice 4-point Lagrange chorus AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native multi-voice chorus catalog processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native multi-voice chorus catalog processor" }
    ],
    "implementationNote": "Browser clean-room chorus is wired to input-bank and shared post-mix track-bank A-D slots. It uses four preallocated fractional delay voices per channel, with two voices as the default; delay/rate/depth/voice count/feedback/tone and wet mix are configurable. Native also uses a separate clean-room catalog processor; per-loop-track parity is not claimed.",
    "parameters": [
      {
        "id": "chorus.rate",
        "key": "rate",
        "label": "Rate",
        "unit": "Hz",
        "range": {
          "min": 0.05,
          "max": 10
        },
        "defaultValue": 0.8,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "chorus.depth",
        "key": "depth",
        "label": "Depth",
        "unit": "ms",
        "range": {
          "min": 0.2,
          "max": 20
        },
        "defaultValue": 5,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "chorus.voices",
        "key": "voices",
        "label": "Voices",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 2
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "2"
          },
          {
            "value": 1,
            "label": "3"
          },
          {
            "value": 2,
            "label": "4"
          }
        ]
      },
      {
        "id": "chorus.feedback",
        "key": "feedback",
        "label": "Feedback",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 50
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "chorus.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 40,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "reverb",
    "displayName": "REVERB",
    "sourceIndex": 47,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Reverb",
    "algorithm": {
      "functionalDescription": "Early-reflection FIR feeding modulated feedback delay network",
      "nativeBalancedChoice": "16-line modulated FDN + 32–128 tap early FIR; convolution only render/HQ mode",
      "browserBalancedChoice": "8-line modulated FDN + short FIR; optional partitioned IR high tier",
      "formulaIds": [
        "F01",
        "F17",
        "F18"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "FDN ~0 samples; FIR partition mode 64–256 samples",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room normalized FDN8 plus sparse early reflections AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room normalized FDN8 plus sparse early reflections AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room Native FDN16 reverb catalog processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native FDN16 reverb catalog processor" }
    ],
    "implementationNote": "Clean-room FDN8 reverb is wired to Browser input-bank and shared track-bank A-D slots. This worklet uses direct FDN/FIR processing rather than partitioned convolution (0 fixed pipeline samples); Native A–D catalog routing is listed separately; per-loop-track processing is not claimed.",
    "parameters": [
      {
        "id": "reverb.decay",
        "key": "decay",
        "label": "Decay time",
        "unit": "seconds",
        "range": {
          "min": 0.1,
          "max": 20
        },
        "defaultValue": 2.5,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "reverb.pre-delay",
        "key": "pre-delay",
        "label": "Pre-delay",
        "unit": "ms",
        "range": {
          "min": 0,
          "max": 250
        },
        "defaultValue": 20,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "reverb.tone",
        "key": "tone",
        "label": "Damping cutoff",
        "unit": "Hz",
        "range": {
          "min": 500,
          "max": 16000
        },
        "defaultValue": 8000,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "reverb.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 25,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "gate-reverb",
    "displayName": "GATE REVERB",
    "sourceIndex": 48,
    "availability": {
      "input": true,
      "track": true
    },
    "family": "Reverb/gate",
    "algorithm": {
      "functionalDescription": "Reverb return multiplied by hold/release gate envelope",
      "nativeBalancedChoice": "FDN16 + sidechain gate with hysteresis and smooth release",
      "browserBalancedChoice": "FDN8 + gate envelope",
      "formulaIds": [
        "F01",
        "F08",
        "F17"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "As reverb",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Clean-room FDN8 return plus stereo-linked hysteretic gate AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room FDN8 return plus stereo-linked hysteretic gate AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Clean-room FDN16 return plus stereo-linked hysteretic gate Native processor" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room FDN16 return plus stereo-linked hysteretic gate Native processor" }
    ],
    "implementationNote": "Browser GATE REVERB reuses the clean-room FDN8 return; Native uses a separate clean-room FDN16 processor. Both gate only the wet signal with stereo-linked peak detection, threshold hysteresis, sample-counted hold, and bounded release. Controls are provisional and not hardware fidelity; Native Track FX is one shared postmix A-D chain, not per-loop processing.",
    "parameters": [
      {
        "id": "gate-reverb.decay",
        "key": "decay",
        "label": "Reverb decay",
        "unit": "seconds",
        "range": {
          "min": 0.1,
          "max": 20
        },
        "defaultValue": 2,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "gate-reverb.threshold",
        "key": "threshold",
        "label": "Gate threshold",
        "unit": "dB",
        "range": {
          "min": -60,
          "max": 0
        },
        "defaultValue": -24,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "gate-reverb.hold",
        "key": "hold",
        "label": "Gate hold",
        "unit": "ms",
        "range": {
          "min": 5,
          "max": 2000
        },
        "defaultValue": 250,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "gate-reverb.release",
        "key": "release",
        "label": "Gate release",
        "unit": "ms",
        "range": {
          "min": 10,
          "max": 2000
        },
        "defaultValue": 150,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "gate-reverb.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 30,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "reverse-reverb",
    "displayName": "REVERSE REVERB",
    "sourceIndex": 49,
    "availability": { "input": true, "track": true },
    "family": "Reverse reverb",
    "algorithm": {
      "functionalDescription": "Beat-quantized captured source segments are played backwards with overlap crossfades into a diffuse stereo late-field reverb",
      "nativeBalancedChoice": "Bounded dual-segment reverse reader feeding a normalized 16-line Hadamard FDN",
      "browserBalancedChoice": "Bounded beat-segment reverse reader feeding a stereo diffuse reverb",
      "formulaIds": ["F17", "F18", "F25"]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Reverse-segment diffuse-tail interpretation; clean-room implementation",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Wet pre-delay is one tempo-synced source segment; Native adds a 100 ms overlap-lookahead, followed by FDN line delays. This is effect pre-delay, not compensated dry-path latency.",
    "implementationStatus": "experimental",
    "runtimeSupport": "experimental",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "input-bank-slot", "algorithm": "Captured beat segments reversed into a clean-room stereo FDN8 diffuse tail in AudioWorklet" },
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Captured beat segments reversed into a clean-room stereo FDN8 diffuse tail in AudioWorklet" },
      { "runtime": "native", "target": "input-bank-slot", "algorithm": "Captured beat segment reversed into clean-room FDN16 stereo diffuse tail" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Captured beat segment reversed into clean-room FDN16 stereo diffuse tail" }
    ],
    "implementationNote": "Experimental Browser and Native clean-room prototypes route bounded beat-quantized reversed source segments into a separate diffuse FDN tail, with an explicit mix control and bounded runtime parameter API. The Browser panel exposes the opt-in prototype with an EXPERIMENTAL label; no dedicated multi-control editor is present yet. They are not factory firmware; perceptual quality, loop-head semantics, device timing, and Roland fidelity are unverified. This status is not sound-quality acceptance.",
    "parameters": [
      { "id": "reverse-reverb.segment", "key": "segment", "label": "Reverse segment", "unit": "beats", "range": { "min": 0.25, "max": 4 }, "defaultValue": 0.5, "curve": "stepped", "rangeBasis": "provisional-clean-room-default", "options": [
        { "value": 0.25, "label": "1/16" }, { "value": 0.5, "label": "1/8" }, { "value": 1, "label": "1/4" }, { "value": 2, "label": "1/2" }, { "value": 4, "label": "1 bar" }
      ] },
      { "id": "reverse-reverb.feedback", "key": "feedback", "label": "Segment feedback", "unit": "%", "range": { "min": 0, "max": 80 }, "defaultValue": 0, "curve": "linear", "rangeBasis": "provisional-clean-room-default" },
      { "id": "reverse-reverb.crossfade", "key": "crossfade", "label": "Crossfade", "unit": "ms", "range": { "min": 1, "max": 100 }, "defaultValue": 20, "curve": "logarithmic", "rangeBasis": "provisional-clean-room-default" },
      { "id": "reverse-reverb.decay", "key": "decay", "label": "Diffuse tail", "unit": "seconds", "range": { "min": 0.1, "max": 10 }, "defaultValue": 2, "curve": "logarithmic", "rangeBasis": "provisional-clean-room-default" },
      { "id": "reverse-reverb.damping", "key": "damping", "label": "Tail damping", "unit": "Hz", "range": { "min": 500, "max": 16000 }, "defaultValue": 8000, "curve": "logarithmic", "rangeBasis": "provisional-clean-room-default" },
      { "id": "reverse-reverb.mix", "key": "mix", "label": "Effect mix", "unit": "%", "range": { "min": 0, "max": 100 }, "defaultValue": 35, "curve": "linear", "rangeBasis": "provisional-clean-room-default" }
    ]
  },
  {
    "id": "beat-scatter",
    "displayName": "BEAT SCATTER",
    "sourceIndex": 50,
    "availability": {
      "input": false,
      "track": true
    },
    "family": "Track-only beat FX",
    "algorithm": {
      "functionalDescription": "Beat-synchronous grain capture, read-head jumps, random/repeat ordering and pitch changes",
      "nativeBalancedChoice": "Deterministic PRNG, fixed grain pool, quantized read positions",
      "browserBalancedChoice": "Same in Worklet; seed stored in memory for repeatability",
      "formulaIds": [
        "F05",
        "F09",
        "F15",
        "F20",
        "F25"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "documented-function-inferred-implementation",
      "statusNote": "Track-only name/function official; selection law reconstructed",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "One grain/slice",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room deterministic stereo slice/grain scatter AudioWorklet" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room sample-clocked stereo slice/grain scatter in the shared Native Track A–D catalog bank" }
    ],
    "implementationNote": "Clean-room stereo grain-scatter DSP is wired to Browser Track A–D slots and the Native shared Track A–D catalog bank. Input assignment is rejected by both; per-loop-track routing is not claimed.",
    "parameters": [
      {
        "id": "beat-scatter.slice",
        "key": "slice",
        "label": "Slice size",
        "unit": "beats",
        "range": {
          "min": 0.25,
          "max": 4
        },
        "defaultValue": 0.25,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0.25,
            "label": "1/16"
          },
          {
            "value": 0.5,
            "label": "1/8"
          },
          {
            "value": 1,
            "label": "1/4"
          },
          {
            "value": 2,
            "label": "1/2"
          },
          {
            "value": 4,
            "label": "1 bar"
          }
        ]
      },
      {
        "id": "beat-scatter.scatter",
        "key": "scatter",
        "label": "Scatter amount",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 50,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "beat-scatter.pitch",
        "key": "pitch",
        "label": "Pitch range",
        "unit": "semitones",
        "range": {
          "min": -24,
          "max": 24
        },
        "defaultValue": 0,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "beat-scatter.repeats",
        "key": "repeats",
        "label": "Repeat count",
        "unit": "steps",
        "range": {
          "min": 1,
          "max": 16
        },
        "defaultValue": 4,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "beat-scatter.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 50,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "beat-repeat",
    "displayName": "BEAT REPEAT",
    "sourceIndex": 51,
    "availability": {
      "input": false,
      "track": true
    },
    "family": "Track-only beat FX",
    "algorithm": {
      "functionalDescription": "Capture beat subdivision and loop forward/reverse/alternate with decay",
      "nativeBalancedChoice": "Dual capture buffers + beat clock + crossfade",
      "browserBalancedChoice": "Same in Worklet; no node creation during playback",
      "formulaIds": [
        "F15",
        "F20",
        "F25"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Direct functional reconstruction",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "One slice",
    "implementationStatus": "implemented",
    "runtimeSupport": "wired",
    "runtimeImplementations": [
      { "runtime": "browser", "target": "track-bank-slot", "algorithm": "Clean-room dual-buffer beat-slice capture/retrigger AudioWorklet" },
      { "runtime": "native", "target": "track-bank-slot", "algorithm": "Clean-room Native tempo-synchronized beat-repeat processor" }
    ],
    "implementationNote": "Clean-room Browser Worklet with fixed-capacity stereo capture buffers, sample-clock beat retrigger, direction/decay control and equal-power slice crossfade. BPM comes from Browser Transport; BPM and subdivision changes take effect at the next slice boundary. Available only in shared Track FX A–D, starts bypassed and requires explicit user activation. Input FX is unavailable; Native supports the shared Track A–D bank only, with no per-loop-track claim.",
    "parameters": [
      {
        "id": "beat-repeat.division",
        "key": "division",
        "label": "Beat division",
        "unit": "beats",
        "range": {
          "min": 0.25,
          "max": 4
        },
        "defaultValue": 0.5,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0.25,
            "label": "1/16"
          },
          {
            "value": 0.5,
            "label": "1/8"
          },
          {
            "value": 1,
            "label": "1/4"
          },
          {
            "value": 2,
            "label": "1/2"
          },
          {
            "value": 4,
            "label": "1 bar"
          }
        ]
      },
      {
        "id": "beat-repeat.decay",
        "key": "decay",
        "label": "Repeat decay",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 15,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "beat-repeat.direction",
        "key": "direction",
        "label": "Read direction",
        "unit": "choice",
        "range": {
          "min": 0,
          "max": 2
        },
        "defaultValue": 0,
        "curve": "stepped",
        "rangeBasis": "provisional-clean-room-default",
        "options": [
          {
            "value": 0,
            "label": "Forward"
          },
          {
            "value": 1,
            "label": "Reverse"
          },
          {
            "value": 2,
            "label": "Alternate"
          }
        ]
      },
      {
        "id": "beat-repeat.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 50,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  },
  {
    "id": "beat-shift",
    "displayName": "BEAT SHIFT",
    "sourceIndex": 52,
    "availability": {
      "input": false,
      "track": true
    },
    "family": "Track-only beat FX",
    "algorithm": {
      "functionalDescription": "Shift loop read pointer by signed beat/subdivision while preserving click-free continuity",
      "nativeBalancedChoice": "Modulo pointer offset + equal-power crossfade, optional phase-aligned zero-cross selection",
      "browserBalancedChoice": "Same in Worklet",
      "formulaIds": [
        "F20",
        "F25"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Loop-read-head behavior is incomplete; the current Browser prototype is experimental",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Crossfade 1–10 ms",
    "implementationStatus": "experimental",
    "runtimeSupport": "experimental",
    "runtimeImplementations": [
      {
        "runtime": "browser",
        "target": "track-bank-slot",
        "algorithm": "signed look-ahead delay prototype; not loop-read-head processing"
      }
    ],
    "implementationNote": "Experimental Browser shared-postmix look-ahead prototype, explicitly not quality-accepted. It requires a four-beat baseline buffer and adds multi-beat latency that varies with tempo/offset; it starts bypassed. Loop-playback read-head integration and per-loop targeting remain unimplemented. The inactive dry/wet mix parameter is omitted. No Native processor is wired and this is not Roland DSP emulation.",
    "parameters": [
      {
        "id": "beat-shift.offset",
        "key": "offset",
        "label": "Beat offset",
        "unit": "beats",
        "range": {
          "min": -4,
          "max": 4
        },
        "defaultValue": 1,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "beat-shift.crossfade",
        "key": "crossfade",
        "label": "Crossfade",
        "unit": "ms",
        "range": {
          "min": 1,
          "max": 50
        },
        "defaultValue": 5,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
    ]
  },
  {
    "id": "vinyl-flick",
    "displayName": "VINYL FLICK",
    "sourceIndex": 53,
    "availability": {
      "input": false,
      "track": true
    },
    "family": "Track-only transport FX",
    "algorithm": {
      "functionalDescription": "Inertial platter speed model drives a variable-rate resampler; sustained non-unit speed requires a source-aware loop read head",
      "nativeBalancedChoice": "Bounded stereo history + cubic Lagrange resampler; loop-read-head semantics pending",
      "browserBalancedChoice": "Four-second bounded history + Lagrange resampler; finite live-stream transients only",
      "formulaIds": [
        "F05",
        "F09",
        "F26"
      ]
    },
    "evidence": {
      "source": "data/fx_algorithm_matrix.csv",
      "classification": "functional-reconstruction",
      "statusNote": "Experimental clean-room transient prototype; loop-read-head integration remains incomplete",
      "methodology": "clean-room-reconstruction"
    },
    "latencyNote": "Native 3 frames; Browser 2 frames; bounded-history edge behavior is control-dependent",
    "implementationStatus": "experimental",
    "runtimeSupport": "experimental",
    "runtimeImplementations": [
      {
        "runtime": "browser",
        "target": "track-bank-slot",
        "algorithm": "2-frame-aligned live-stream resampler with 4-second history and phase slips; sustained >1x is not maintained"
      },
      {
        "runtime": "native",
        "target": "track-bank-slot",
        "algorithm": "3-frame-aligned cubic resampler with bounded 131072-frame stereo history; loop-read-head semantics pending"
      }
    ],
    "implementationNote": "Experimental shared-postmix Track A–D prototype only; not quality-accepted. It does not have source-aware per-loop read-head access, so sustained non-unit speed on a live stream is unsupported and finite-history reanchoring may alter continuity. The Browser path cannot sustain >1x; the Native path uses a bounded rolling window, not an actual stored-loop reader. Input is intentionally unavailable. This is a clean-room functional reconstruction, not Roland DSP emulation.",
    "parameters": [
      {
        "id": "vinyl-flick.speed",
        "key": "speed",
        "label": "Platter speed target",
        "unit": "%",
        "range": {
          "min": -100,
          "max": 100
        },
        "defaultValue": -100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "vinyl-flick.return-time",
        "key": "return-time",
        "label": "Motor return time",
        "unit": "seconds",
        "range": {
          "min": 0.05,
          "max": 10
        },
        "defaultValue": 1.5,
        "curve": "logarithmic",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "vinyl-flick.brake",
        "key": "brake",
        "label": "Friction/brake",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 35,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      },
      {
        "id": "vinyl-flick.mix",
        "key": "mix",
        "label": "Effect mix",
        "unit": "%",
        "range": {
          "min": 0,
          "max": 100
        },
        "defaultValue": 100,
        "curve": "linear",
        "rangeBasis": "provisional-clean-room-default"
      }
    ]
  }
];

export const FX_CATALOG_BY_ID: ReadonlyMap<string, FxCatalogEntry> = new Map(
  FX_CATALOG.map((effect) => [effect.id, effect]),
);

/** Counts computed from the catalog so downstream tooling can audit the matrix. */
export const FX_CATALOG_AUDIT = Object.freeze({
  effectCount: FX_CATALOG.length,
  inputAvailableCount: FX_CATALOG.filter((effect) => effect.availability.input).length,
  trackAvailableCount: FX_CATALOG.filter((effect) => effect.availability.track).length,
  trackOnlyIds: FX_CATALOG.filter((effect) => effect.availability.track && !effect.availability.input).map((effect) => effect.id),
  parameterCount: FX_CATALOG.reduce((total, effect) => total + effect.parameters.length, 0),
  runtimeImplementationCounts: {
    browser: FX_CATALOG.filter((effect) => effect.implementationStatus === 'implemented' && effect.runtimeImplementations?.some((item) => item.runtime === 'browser')).length,
    native: FX_CATALOG.filter((effect) => effect.implementationStatus === 'implemented' && effect.runtimeImplementations?.some((item) => item.runtime === 'native')).length,
    browserInput: FX_CATALOG.reduce((count, effect) => count + (effect.implementationStatus === 'implemented' && effect.runtimeImplementations?.some((item) => item.runtime === 'browser' && item.target === 'input-bank-slot') ? 1 : 0), 0),
    browserTrack: FX_CATALOG.reduce((count, effect) => count + (effect.implementationStatus === 'implemented' && effect.runtimeImplementations?.some((item) => item.runtime === 'browser' && item.target === 'track-bank-slot') ? 1 : 0), 0),
    nativeInput: FX_CATALOG.reduce((count, effect) => count + (effect.implementationStatus === 'implemented' && effect.runtimeImplementations?.some((item) => item.runtime === 'native' && item.target === 'input-bank-slot') ? 1 : 0), 0),
    nativeTrack: FX_CATALOG.reduce((count, effect) => count + (effect.implementationStatus === 'implemented' && effect.runtimeImplementations?.some((item) => item.runtime === 'native' && item.target === 'track-bank-slot') ? 1 : 0), 0),
  },
  experimentalRuntimeImplementationCounts: {
    browser: FX_CATALOG.filter((effect) => effect.implementationStatus === 'experimental' && effect.runtimeImplementations?.some((item) => item.runtime === 'browser')).length,
    native: FX_CATALOG.filter((effect) => effect.implementationStatus === 'experimental' && effect.runtimeImplementations?.some((item) => item.runtime === 'native')).length,
    browserInput: FX_CATALOG.reduce((count, effect) => count + (effect.implementationStatus === 'experimental' && effect.runtimeImplementations?.some((item) => item.runtime === 'browser' && item.target === 'input-bank-slot') ? 1 : 0), 0),
    browserTrack: FX_CATALOG.reduce((count, effect) => count + (effect.implementationStatus === 'experimental' && effect.runtimeImplementations?.some((item) => item.runtime === 'browser' && item.target === 'track-bank-slot') ? 1 : 0), 0),
    nativeInput: FX_CATALOG.reduce((count, effect) => count + (effect.implementationStatus === 'experimental' && effect.runtimeImplementations?.some((item) => item.runtime === 'native' && item.target === 'input-bank-slot') ? 1 : 0), 0),
    nativeTrack: FX_CATALOG.reduce((count, effect) => count + (effect.implementationStatus === 'experimental' && effect.runtimeImplementations?.some((item) => item.runtime === 'native' && item.target === 'track-bank-slot') ? 1 : 0), 0),
  },
  implementationStatusCounts: {
    catalogued: FX_CATALOG.filter((effect) => effect.implementationStatus === 'catalogued').length,
    implemented: FX_CATALOG.filter((effect) => effect.implementationStatus === 'implemented').length,
    experimental: FX_CATALOG.filter((effect) => effect.implementationStatus === 'experimental').length,
  },
});
