# Browser LOOP SYNC scope

Roland's [Parameter Guide v1.3](https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf), pages 3–4, describes LOOP SYNC as a per-track switch and restricts recording quantization to tracks with that switch enabled. Browser tracks with LOOP SYNC OFF now start and stop without the master-grid wait and keep their recorded PCM length instead of forcing it to a multiple of another track. Classic LCD exposes the per-track switch; Native remains disabled until its backend provides the setting.

This does not establish full LOOP SYNC parity. The existing ON path uses a main-thread Transport measure event and its master-track rules do not yet cover every documented rhythm/MIDI/synchronized-track condition. In particular, the 25 ms scheduling poll is not a sample-accurate hardware clock. Those limitations remain open; no physical RC-505 behavior or timing comparison has been performed.
