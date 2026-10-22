# Vite cold-start repair (Windows, 2026-10-22)

Base: `a710f21c4c636eabb6851793c13a8f58311209bc`. Branch: `codex/vite-cold-start-20261022`.

## Cause and change

An HTTP 200 did not mean the application was ready: the original server answered after 1.91–2.32 seconds, while `/src/main.ts` remained pending and all three initial samples missed the 30-second UI deadline.

The diagnostic [CPU sample](cpu-profile-summary.json) attributes 17.19 seconds of self time to Windows `FSWatcher` registration, reached through Vite's directory/file watcher setup. Native build trees and archived benchmark outputs were being watched along with the frontend. Excluding only `native-mvp/build*/**` and `bench/results/**` reduced `getWatched()` inventory from 374 directories / 3,114 entries to 92 / 1,334. `src`, `public`, config, tests, documentation schemas and benchmark source remain watched.

Watcher exclusions alone were insufficient: one sample still missed 30 seconds, and two loaded after 20.41 / 23.63 seconds. Vite 7.2.4 also waits for dependency discovery in `tryOptimizedResolve` before resolving the first Vue import. The app has only one runtime external dependency, Vue. Explicit `optimizeDeps.include: ['vue']` with `noDiscovery: true` avoids scanning the complete application graph for additional external packages. New runtime external dependencies must be added to `include`.

Only development-server configuration changed. DSP, backend initialization, WASM, Native protocol and runtime Vue components are unchanged. The former Native journey's 60-second override was removed; it uses Playwright's original default **30 seconds** again.

References: [Vite 7 watcher options](https://v7.vite.dev/config/server-options#server-watch), [explicit dependency optimization](https://v7.vite.dev/config/dep-optimization-options#optimizedeps-nodiscovery), [Vite performance guidance](https://v7.vite.dev/guide/performance).

## Actual cold-start results

Every sample uses a new Vite process, an empty unique optimizer cache and a new Chromium process/context. The **30-second budget begins before spawning Vite**, including server initialization, dependency prebundling and browser launch. There is no manual warm-up outside the measured interval. Windows filesystem caches were not flushed.

| Stage, seconds from Vite process spawn | Sample 1 | Sample 2 | Sample 3 |
|---|---:|---:|---:|
| Original UI readiness | >30 | >30 | >30 |
| Fixed Browser load | 12.47 | 12.81 | 18.35 |
| Fixed Browser actual PAGE interaction | 13.10 | 13.14 | 18.67 |
| Fixed Native load | 15.93 | 12.95 | 15.63 |
| Fixed Native actual PAGE interaction | 16.16 | 13.29 | 15.89 |
| Fixed Native audio-engine READY | 17.02 | 14.31 | 16.78 |

Final startup performance gate: **6/6**, zero time-budget increases. COOP remains `same-origin`; COEP remains `require-corp`. See [comparison](cold-start-comparison.json) and [validation](validation.json). Measurements are local observations, not a cross-machine guarantee or P99 estimate.

The intermediate watcher-only Native samples used origin 5186, which the bridge does not allow. Their UI timing remains diagnostic; their failed Native READY condition is not used as an audio result. Final Native samples use the already allowed, isolated port 4174. CORS/security settings were not changed.

## Functional and watcher checks

The [watch-scope receipt](watch-scope-receipt.json) confirms a real module update from version 1 to 2 without navigation/document replacement. Source, docs, benchmark source, public assets, index and config remain in the watcher inventory; docs/bench changes are observable. Writes to the two excluded artifact trees produce no watcher event. All temporary probe files were removed.

Type-check, build, focused unit results and the restored-30-second Native journey are recorded in [validation](validation.json). Historical UI-parity acceptance counts belong to their original runs and are not reused as fresh results here.

## Separate Native observation

Browser startup samples had no console, response or request errors. Each final Native sample observed 28 FX catalog-slot HTTP 409 responses while connecting to an already running real host; network-request failures were zero. `NATIVE AUDIO READY` denotes the bridge/audio engine, not acknowledgement of all FX settings.

The unchanged Native code points to the existing seven-bank/four-slot initialization path: an already running stream resumes after configuration, then slot preparation conflicts with the running-state guard. Response bodies were not captured, so the precise rejection text is a code-based inference. See [error summary](native-bootstrap-errors.json). These samples certify startup timing, not successful Native FX application. Native FX ACK is checked separately by the isolated integration journey.

## Reproduce

With locked dependencies and an installed Playwright Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to that executable if it is outside Playwright's default installation.

```powershell
npm run test:startup -- --audio browser --rounds 3
npm run test:startup -- --audio native --rounds 3
npm run test:watch-scope
```

Default ports are Browser 5186, Native 4174 and watcher probe 5187. Native samples require the existing bridge and an empty loop session; normal Native UI initialization is not a read-only operation. Scripts preserve existing runtime ports/caches, stop only their own processes and delete only their uniquely created probe files. Detailed raw measurement reports and CPU profiles remain in TEMP; compact evidence and hashes are retained here.
