# Frozen pre-optimization YIN reference

These are exact source copies from local baseline commit 6bf4a2c011f7e9aba46a7bba02b0021873d19b89, before scratch-frame and prefix early-termination optimization. They are test-only independent reference implementations, not production imports. Do not update them along with production code.

The mirrored tree makes frozen BrowserRobotDsp import the frozen ../../pitch/liveMono, not the new production implementation.

SHA-256:
- src/audio/pitch/liveMono.ts: 4b86f8fe36da25941e502985c82a8f31c18864f4bf8c8489c33be64ae588da20
- src/audio/fx/dsp/BrowserRobotDsp.ts: d1d46201e8d703fd72aa40965a0839bf40bd506dad6a543e1652ae1623d17888

Reconstructed in the new recovery workspace after the earlier uncommitted work became unavailable. No earlier test or benchmark result is a new verification of this checkout.
