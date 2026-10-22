# FX signal sanity

PASS_SOFTWARE_FINITE_AND_BYPASS_ONLY: 8 effects, 16 cases, 0 finite/bypass failures. 1 peak/DC diagnostic flags require review; this is NOT a complete quality PASS. 16 baseline-comparable cases, 0 changed PCM hashes.

Signals: impulse, stereo-asymmetric. Rates 48000 Hz; maximum mapped supported parameters; 10 seconds per signal. Full measured parameters, rejection diagnostics, peak/RMS/DC/correlation/transient deltas and PCM hashes are in JSON.

- All mapped catalog core routes, including experimental routes; excluded non-core routes require their separate runtime acceptance.
- Per-case duration is recorded; short windows are initialization sanity, not long feedback-tail stability proof.
- Cross-channel effect output is diagnostic: stereo reverb/pan/vocoder legitimately crossfeed; track isolation is separately tested.
- Catalog extreme mappings are recorded; rejected unsupported modes are explicitly listed, not counted as supported.
- Peak/DC/correlation/delta are measurements, not universal acceptance thresholds or subjective/Roland fidelity.
- Node-hosted bundled/core DSP, not browser callback or hardware performance; latency is declared metadata, not measured latency.
