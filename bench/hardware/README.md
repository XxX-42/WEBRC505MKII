# Windows physical audio harness

Install `py -3.13 -m pip install -r bench/hardware/requirements-hardware.txt`.
Inventory: `py -3.13 bench/hardware/inventory_windows.py --out EXTERNAL_PATH.json`.
PnP, WASAPI/PortAudio advertised defaults and WinMM MIDI are read separately.
An advertised default is not an opened stream's negotiated rate or buffer.

`capture_soak.py` supports 10/30/60 minute PCM16 duplex captures, periodic chirp markers,
cross-correlation latency and PortAudio callback overflow/underflow counters with writer drops separate.
Select `--input-device INDEX --output-device INDEX --sample-rate HZ --duration-minutes 10`
and confirm the actual wiring with `--physical-route-confirmed --route-description DESCRIPTION`.
An RC-505 route additionally needs `--route-mode rc505-hardware-insert --rc505-present-confirmed`.
Store `--outdir` outside the repository. Never confirm a route from a device name alone.
Without confirmed wiring/devices the harness writes BLOCKED and null XRUN counters.
Callback flags only measure this opened stream; they do not prove every hardware/driver dropout was detected.
