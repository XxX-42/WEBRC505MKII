# PREAMP headroom correction and standalone review

The PREAMP processor previously clipped the tone-stack/output-gain result and final wet output at ±16 at the base sample rate. Legal maximum controls on a 0.72-peak input reached approximately 24.55 before that rail, so this added a second nonlinearity after the intended x4 diode stage. The correction removes both clamps, retains finite-value/denormal guards and rejects cabinet IR channels with L1 > 64 during preparation. It does not normalize an admitted IR.

Root checked all 22 indexed artifacts of `preamp-fx-max-control-fixed-20261010T014553132` and all 50 artifacts of the before/after comparison. All 11 source closure files in the corrected suite matched the live source at review. Root independently reran the archived suite executable and both comparison executables successfully. The corrected suite reports zero callback allocation/free, zero partition difference, exact L1-boundary acceptance, over-boundary rejection and a 24.5499 maximum-control output peak.

The fixed suite archive is an exact copy of the executor's already-built Release output, not a new compilation. Its manifest states the build origin/timestamps and the missing compiler-console-log limitation. Root did not recompile either suite or benchmark.

At 5.2 kHz, the comparison's Hann-windowed harmonic/fundamental ratio changed from 0.16310 to 0.12301 after removing the rail. At 800 Hz and 3.8 kHz the ratios increased from 0.52640 to 0.53024 and 0.26252 to 0.28417. These fixtures demonstrate restored headroom and changed harmonic response; they do not establish universal THD improvement or final alias/quality qualification. Original clipped-audit results and the baseline executable are retained.

The same root review independently checked 24 artifacts and reran the standalone VOCODER chord/carrier candidate. Its transactional MIDI-chord and external-carrier tests pass, but `Vintage` currently uses a sine oscillator. Distinct output PCM does not qualify the published VINTAGESAW waveform. That candidate remains archived with this known semantic gap; a separately frozen correction is required before waveform coverage can be accepted.

Exact artifact checks and executable rerun output are in `docs/validation/20261010/preamp-vocoder-root-review.json`. This checkpoint does not qualify Native/Web routing, published PREAMP amp/speaker/mic controls, full realtime graphs, hardware latency or later gates.
