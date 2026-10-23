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
