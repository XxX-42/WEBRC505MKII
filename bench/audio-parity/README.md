# Audio comparison harness

Python 3.13: `py -3.13 -m pip install -r bench/audio-parity/requirements.txt`.

Run `py -3.13 -m unittest discover -s bench/audio-parity/tests -v`.
Generate fixtures, 34 identity/gain analyses and randomized A/B fixtures with
`py -3.13 bench/audio-parity/software_baseline.py --outdir EXTERNAL_TEMP_DIRECTORY`.
These are SOFTWARE_BASELINE synthetic controls, never actual engine renders or hardware captures.
Seventeen stereo 48 kHz PCM16 stimuli include silence, impulse, sweep, multitone,
997 Hz tone, amplitude staircase, transient, L/R only, antiphase, asymmetric stereo,
vocal/guitar-like, bass, drum, pitch sweep and tempo pulse.

For actual renders use `analyze.py --reference input.wav --capture render.wav --stimulus-name tone_997 --capture-kind software_baseline --out EXTERNAL_PATH.json`.
Metrics report applicability and unavailable reasons. Alignment uses the highest-energy channel to avoid antiphase cancellation;
descriptive metrics have no universal pass threshold. Frequency/THD/pitch/tail claims require appropriate stimuli.
Use `blind_package.py --stimuli-dir DIRECTORY --variant engine1=DIRECTORY --variant engine2=DIRECTORY --out EXTERNAL_PACKAGE --mapping-out EXTERNAL_PRIVATE_MAPPING`.
Keep private mapping outside the shareable package. Hashes provide integrity, not cryptographic anonymity against someone holding the source candidates.
No listening happened: MULTIMODAL_AUDIO_JURY_BLOCKED. No preference scores are invented.

## Production software renders

Use external build/output directories. On Windows/MSVC:

```powershell
python bench/audio-parity/build_native_probe.py --outdir C:/Temp/rc505-probe --generator "Visual Studio 16 2019"
python bench/audio-parity/engine_baseline.py --native-manifest C:/Temp/rc505-probe/native-probe-build.json --outdir C:/Temp/rc505-engine-baseline --mode lpf
python bench/audio-parity/run_callback_probe.py --native-manifest C:/Temp/rc505-probe/native-probe-build.json --out C:/Temp/rc505-callback.json --callbacks 10000
```

Run builds and timing serially during an idle measurement window. The renderer produces 34 Float32 WAVs from 17 stimuli, with source paths, SHA256, settings, runtime metadata and analyzer output in `engine-baseline.json`. `--mode dry` exercises production bypass/monitor paths; default `lpf` exercises explicit 1200 Hz/15% resonance low-pass DSP. Browser uses the shipped AudioWorklet DSP module directly under Node; Native uses the real callback/input-FX/software-monitor pipeline with fake RtAudio. Exact paths are recorded. This does not cover complete app export, browser AudioContext scheduling, or hardware. Tails after input duration are truncated. No `hardware.wav` is generated.

The Native manifest binds binary and conservative source hashes and rejects changed sources. The callback runner supports Windows/MSVC and Linux without GNU-specific process APIs. It runs serial ABBA comparisons of gate changes and retained MARK against an active-meter control, using five populated one-second loops, ten per-track FX slots, input/shared FX, accepted active mono pitch and rhythm. Each leg warms 1000 callbacks and measures at least 10000 callbacks; P99.9 and tail resolution are recorded. A no-meter control is unavailable because production metering has no disable switch. Control work and MARK transaction latency are outside callback timing. New/new[] counts cover measured callbacks. One completed callback while all three core mutexes are held by another thread proves those blocking locks were not acquired. Global mutex counts, malloc/aligned allocation and hardware XRUNs remain unavailable; no fake zeros are substituted.
