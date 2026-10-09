# Shared-core WASM interface: root review

This implements and verifies a foundational interface. It does not pass Gate 1
for all primitives, or qualify the full looper, effect registry, pitch tiers,
device latency, or 30-minute stress test.

## Reviewed behavior

The pinned Emscripten 6.0.10 build compiles the same C++ primitive source used by
Native into a standalone reactor. Opaque generation-tagged handles reject stale
objects. Linear memory is fixed at 64 MiB; managed reservations are limited to
48 MiB, with setup-time budget rejection preserving existing handles. Raw
`malloc`/`free` are not exported to callback clients.

The main thread compiles the module. The diagnostic AudioWorklet constructor
instantiates it and prepares all state and typed views. `process()` receives
the actual output-array length and copies through existing views. WASI imports
fail closed and expose counters; the measured callback made no WASI I/O calls.
The runtime graph integration and advanced primitive exports remain pending.

A build manifest records the compiled inputs, source hashes, compiler identity,
exact flags and WASM hash. Build-time source mutation and stale manifests reject
acceptance. The documented Windows PowerShell 5.1 command initially failed on
newer .NET APIs; the path/hash helpers were corrected and an independent fresh
build with that command passed.

## Independent verification

`golden.mjs` passed against a fresh build and the Native PCM fixture producer:
six 32-sample algorithm fixtures, 64/128/256/512-frame ABI calls, fixed memory,
26 large delay-ring reservations followed by budget rejection, existing-state
continuity and stale-handle rejection. This short parity test is not long-run
or full-effect quality qualification.

The actual Chromium 154 Worklet interface test passed 1024 callbacks at 48 kHz,
each with an observed 128-frame output. Software-generated input flowed through
one biquad to `sinkId: {type: 'none'}`. The run had zero nonfinite samples,
process failures, logical frame gaps and WASI I/O calls. Logical frame continuity
does not establish hardware XRUN behavior.

Evidence:
`shared/dsp/benchmarks/results/wasm-audio-worklet-interface-20261009T110341899Z.json`
and its `.trace.json.gz`. There were exactly 1024 isolated author-script Process
duration events from one thread; Chromium reported `dataLossOccurred=false`.
Interface diagnostic P99 was **100 µs**, maximum **877 µs**. These trace durations
include the harness and copying; they are not hardware end-to-end latency,
kernel-only timing, or the full five-track DSP graph's admission result.

Two prior failed traces remain compressed with byte-verified restoration hashes:
`105336802Z` and `105504254Z`. A constructor-local WASI adapter was incorrectly
referenced by the callback; storing the prepared adapter on the processor fixed
the failure. Runtime processor errors now fail the test promptly.

The `105727805Z` interface run also completed, but it fingerprinted the working
tree while using an older build without its source manifest. It is historical
evidence and cannot establish source-to-artifact identity. Do not relabel it as
a current-source result.

After the PowerShell compatibility correction, the rebuilt artifact remained
byte-identical: SHA-256
`9dddba363d50b231c2c006d7505202378f471de147c0a109d23224581c7249b9`.
The C++ and callback inputs were unchanged from the manifest-aware Worklet run;
the build-script digest changed, and the fresh build/manifest/golden checks
independently passed. Native control/nonlinear/shelf export expansion, spatial
primitives, streaming pitch and full application integration remain required.
