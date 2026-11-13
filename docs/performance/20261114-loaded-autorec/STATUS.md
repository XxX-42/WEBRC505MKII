# Loaded software gate

Baseline: `41756410108712ce1fa2600f43b6bdf1575be4db`.
Working branch: `codex/rc505-loaded-gate-20261114`.

## Changes

- Classic MAIN's LCD capability description now agrees with its independent software gain provider. Missing providers retain their actual unavailable reason. MAIN is not an alias for MASTER and is not a claim about physical output routing.
- Reconciled software setting documentation: Native DUB MODE already exists; Native PAN remains unavailable.
- Extended the device-free performance harness with isolated effect profiles, the Classic eight-shared-slot topology, and an explicit test-only FTZ/DAZ experiment. Production Native DSP is unchanged.
- Rejected the ROBOT contiguous-frame candidate: unchanged output hashes, but mixed-load benefit was inconsistent and each instance required an extra 8192 bytes. The patch is retained only as experiment evidence.

## Results and limits

The [measurement log](README.md) retains every case, binary hash and command. Twenty-private-slot heavy workloads do not meet the 64-frame deadline. Classic eight-shared-slot extremes have much more headroom, but three of four sampled cases still had deadline exceedances; they are not a strict real-time PASS. FTZ/DAZ did not solve the measured PREAMP workload.

Allocation counts cover the test tracker's ordinary global `new` and `new[]` overrides. They do not prove the absence of `malloc`, aligned allocation, locks, or blocking operations. These short, single-threaded, device-free elapsed-time measurements are not 10/30/60-minute stability runs, physical latency, or driver XRUN counts. All hardware sound/LED/latency acceptance remains unmeasured.

The real WASAPI host compiled from the frozen baseline using MSVC 2019; [build receipt](real-wasapi-build.json) records its exact binary and hash. Automatic approval rejected the isolated launch/GET/child-cleanup command, so the host was not launched and its devices or audio callback were not verified. The rejection supplied no more specific reason than policy blocking. No system audio routing was changed.

Local Chrome at `127.0.0.1:5173` displayed OUTPUT MIXER with MAIN 100% and the corrected capability description. No audio was started in that tab. Virtual-input Browser and isolated Native simulation remain separate from real WASAPI acceptance.

Production build and the current full frontend unit run passed (2933/2933; zero failed or pending). One complete E2E run passed 144/144 in 400.21 seconds, with zero skips, retries or flaky outcomes; one worker and the existing 30-second test timeout were retained. See the [compact regression receipt](regression.json). These functional results do not override the failed performance cases or certify physical hardware.

## Remaining work

- PREAMP function-level cost attribution and quality-preserving optimization; heavy graph performance is still open.
- Native PAN needs real DSP/readback/Memory integration before enabling the Classic field.
- Physical RC-505 oracle captures, latency/XRUN long runs, Golden Master listening and calibrated LED measurements require the absent device and remain blocked.
