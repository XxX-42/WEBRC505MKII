# Portable control and nonlinear batch: root review

This is a partial Gate 1 implementation. Gates 1–7 remain unpassed. These
shared-core tests do not qualify the 53 effects, the integrated looper, audio
device callbacks, hardware latency, or the required 30-minute stress run.

## Implemented and reviewed

- F02: RBJ low/high shelves, double-precision coefficients, bounded controls,
  coefficient ramps, unity and frequency-response checks.
- F09/F16/F20: semitone ratio, raised-cosine slicer, fixed-capacity absolute-frame
  scheduler and swing. Late events retain their scheduled frame and explicitly
  report `late=true`, `blockOffset=0`; zero-frame collection consumes nothing.
- F22/F27/F28/F29: complementary low/high side split and correlation monitor,
  energy-flux onset/attack, seeded TPDF quantization/sample hold, sine ring
  modulation. Width, wet mix and ring depth have prepared smoothing state.
  Correlation monitoring alone does not qualify an effect's safety policy.
- F07/F23: 2x/4x half-band filtering with ADAA or an antiparallel-diode WDF
  one-port. Stateful shaping now explicitly follows chronological oversampled
  sample order; C++ function-argument evaluation order cannot reorder the ADAA
  history. Full preamp circuits and distortion presets are still pending.

Failed scheduler reconfiguration preserves the prior clock and event queue.
Zero wet mix preserves dry values beyond ±1. Tests exercise variable 64/128/256
blocks and automation under scoped allocation counters; this does not prove
future graph construction or every library path allocation-free.

## Independent verification, 2026-10-09

`scripts/native-dsp-verify.ps1` built a fresh MSVC 19.29 Release core under TEMP.
CTest passed **3/3**: primitives, control/dynamics, nonlinear. The verifier
confirmed an unchanged source fingerprint before promoting its outputs.

Evidence from the same run:

- `bench/results/native_primitives_20261009T110412153Z_acd35539bb3d.json`
- `bench/results/native_nonlinear_20261009T110412153Z_acd35539bb3d.json`

The primitive microbenchmark processed 20,000 separately timed 64-frame blocks
at 48 kHz: P99 **65.8 µs**, P99.9 **218.1 µs**, max **1284.1 µs**; block deadline
**1333.333 µs**. This timing covers the benchmark's initial primitive stack,
not all new classes or the full five-track effects graph.

An earlier fresh attempt passed CTest 3/3 but failed to archive its nonlinear
JSON because the output environment variable was set after CTest. That script
ordering was corrected before this run. The earlier primitive timing reached
**2198.7 µs max**, exceeding the block deadline; its unpromoted raw benchmark is
preserved separately. A subsequent lower maximum does not erase that outlier.

The nonlinear test measured the actual product primitive outputs:

| Measurement | 2x | 4x |
| --- | ---: | ---: |
| FIR phase delay at 1 kHz, base samples | 14.5 | 21.75 |
| ADAA extra phase delay at 1 kHz, base samples | 0.25 | 0.125 |
| Total small-signal phase delay at 1 kHz, base samples | 14.75 | 21.875 |
| Total at 48 kHz, milliseconds | 0.3073 | 0.4557 |
| One 750 Hz folded harmonic magnitude | 0.000001193 | 0.000014063 |

The filter-only impulse energy centroids were 14.5 / 21.81065 samples. Energy
centroid and phase delay are different measurements. This single folded
harmonic does not show that 4x improves every bin over 2x, nor qualify complete
DIST/PREAMP sound quality. Sweep, multi-tone, IMD and full-chain tests remain
required. The WDF test checked 648 accepted parameter/input corners against
wave-equation residual and passive-power bounds.

The audio device was not opened. Hardware end-to-end latency and XRUNs are
unmeasured.
