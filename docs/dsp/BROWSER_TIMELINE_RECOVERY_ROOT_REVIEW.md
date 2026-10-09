# Browser shared DSP and timeline recovery checkpoint

The actual application now loads a hash-pinned shared WASM module with 17 available FX processors, stereo filter paths and the clean-room 240-pattern/16-kit rhythm engine. The runtime preserves stereo recording and playback. The rhythm UI and Memory selection restore the actual clean-room pattern and kit. Generic 17-processor FX bank routing and the shared master FDN are still pending; processor availability does not mean all those effects are already in the application signal graph.

The Worklet now distinguishes duplicate callbacks, missing frame intervals, bounded catch-up and explicit recovery after a larger discontinuity. Duplicate callbacks replay prepared output storage without recording twice or executing controls twice. Catch-up processes silence with a bound of two quanta per callback. Larger gaps require an explicit recovery handshake; project stop/restore performs that handshake before issuing transport commands. The handshake retains discontinuity/XRUN statistics and reanchors rhythm. A failed WASM fetch can be retried; concurrent callers share the pending load.

## Evidence and scope

The immutable checkpoint is `bench/results/browser_graph_timeline_recovery_product_20261010T002000Z`. Its folder label is an identifier; the report records the actual UTC interval 2026-10-09 16:02:02–16:02:34. Root independently verified all 158 archived files against their manifest and current counterparts, including 52 WASM build source/provenance inputs (the inventory includes vendor documentation). Canonical app/source/asset fingerprint: `56a2650b921f255c77ab5e13a9e170b7e216e061062b088b89f5847b4a681d8d`. Git attributes preserve the exact pinned source bytes across checkouts; this includes existing vendor line endings.

The actual fetched 590730-byte WASM has SHA-256 `c17244e85d8f2c0c7eabbeafa216e95d2a34e2800969f2343451e0241701d8db`; it matches the public manifest, runtime fetch and checked-in pin. The live source guard passes for that 17-processor build. Future registry changes require a fresh Browser module and pin.

Chrome 149.0.7827.55 passed all 69 assertions using one project AudioContext at 48 kHz and the observed 128-frame quantum. The scenarios include independent left/right recordings, five-track playback/KeepPitch checks, input routing, pan, source replacement, mono compatibility, overdub, quantized external-clock recording, rhythm selection and project/Memory restore. This is functional software verification, not a pitch-quality gate.

The run reports approximately 22.35 seconds of project audio-clock progression. It retains 18 duplicate callbacks, 18 forward gaps totaling 2304 frames, and 18 timeline XRUNs. Those missing frames were filled with silence; no unexpected shared-DSP/rhythm status errors remain. Deadline timing is unavailable in this Worklet environment. Zero-XRUN and realtime qualification remain false. The main clock, callback and diagnostic snapshots were sampled separately, so their duration/counter differences must not be interpreted as one synchronized timing interval.

The frozen targeted Worklet/protocol suites pass 31/31; production build includes the asset guard, vue-tsc and Vite and passes. Exact test source copies, source hashes and unfiltered logs are in the checkpoint verification folder. The loader retry regression also has a separately verified unit test. Earlier 66/67 and explicit timeline-rejection failures remain preserved in their original snapshots.

No hardware stream or physical loopback was used. Full FX graph integration, three distinct pitch routes, long quality measurements, strict no-GC behavior and the 30-minute integrated stress gate remain outstanding. The full implementation goal remains active.
