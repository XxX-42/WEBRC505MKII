# PREAMP maximum-control before/after comparison

This folder replays the pre-fix implementation from `preamp-max-control-audit-20261010T011904902` and compares it with the corrected live implementation. The baseline source contains the original fixed ±16 pre-cabinet and final output clamps. The corrected copy is from live source with benchmark-only pre-cabinet peak/count counters inserted; the counters do not affect samples.

Both builds use the same 48 kHz, 0.72-peak stereo sine fixtures (100, 800, 3800, 5200, and 10000 Hz), Drive 24, Bass/Mid/Treble/Presence +12 dB, Output +12 dB, and a unit impulse cabinet IR. Results report the peak, RMS, and Hann-windowed direct projection of harmonics 1–9 from the last 8192 output frames. This is an implementation comparison, not an audibility or final anti-alias qualification.

Run `build_compare.cmd` from this directory on a host with the pinned MSVC 2019 Build Tools path. Each variant contains its exact source closure, build log, compiler version, objects, executable, and result JSON.
