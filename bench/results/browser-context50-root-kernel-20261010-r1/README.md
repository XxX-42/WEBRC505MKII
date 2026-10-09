# Real WASM typed-context kernel validation capsule

Root independently executed the frozen typed-context test against the real 50-factory WASM module, then copied all 88 declared build inputs, module, manifest and test here and replayed successfully from this capsule. The test checks raw source input hashes and the module digest before execution. Both independent context executions produced PASS with no stderr. Root additionally copied and replayed the real registry test: all 50 available processors were created and processed, with no memory growth and no WASI I/O calls. Three ordinals remained metadata only. The source set digest is 0584854a72abc19c3911637a8ed1629609c0ee42621f6092d3e14d29a10deb53; module SHA-256 is 65960fceaf4cc343629d2cbaaed560a898233c4d3e2d3cda7c9c365fdeca4f5e.

From this directory, replay with Node:

```text
node repo/shared/dsp/wasm/tests/fx-context-smoke.mjs repo/build-output/webrc-dsp.wasm repo/build-output/webrc-dsp.build.json
node repo/shared/dsp/wasm/tests/fx-registry-smoke.mjs repo/build-output/webrc-dsp.wasm repo/build-output/webrc-dsp.build.json
```

Coverage: independent stereo VOCODER carrier, carrier spans/frame/channel validation, sample-offset-17 MIDI PCM effects, same-offset parameter-before-MIDI ordering, invalid MIDI and parameter buffers/order/alignment, exact 64-event acceptance and 65-event rejection with state/output transactionality, rejection of sidecars on nonmusical processors, context API version.

This is a kernel C ABI test, not an actual AudioWorklet routing or latency test. At review time, production Worklet context calls still supplied empty carrier/MIDI sidecars and explicitly rejected VOCODER without a route. This capsule does not install public assets, change live source pins, claim 53 FX completeness, qualify Pitch quality, or pass realtime stress. It retains existing build artifacts and declared build sources; Root did not rerun the compiler or independently prove complete compiler dependency closure for this capsule.
