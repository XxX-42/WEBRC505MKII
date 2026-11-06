# RC-505 integration gates — 2026-11-07

**PARTIAL; hardware 1:1 remains unverified.** This is a dated integration
record, not a replacement for the historical receipts in earlier directories.
Exact prior complete-E2E counts and artifact hashes are in [regression.json](regression.json).

| Gate | Current evidence |
|---|---|
| Integrated source | `f4e9f99ed2b6714ff08438013020ff18a0dfa8c5` |
| Complete unit | 227 files, **2833/2833**, zero failed/skipped; two workers, original test limits |
| Production build | PASS: TypeScript, both worklets, Vite, six exact license files |
| Complete E2E | Previous source `7bc0422`: **133/135**, zero retries/skips. Final integrated complete run is still pending |
| Current scoped E2E | **11/11**, zero failed/skipped/retries, original 30-second test limit: closed-context recovery, archive round trip, Classic controls/virtual recording and two viewport sizes |
| Rhythm callback ACK | Exact host/revision/intent, callback wait, non-BPM patch CAS and durable import handoff are integrated; targeted HTTP/UI tests passed on the executing branch |
| Context recovery | Three independent full-fixture scenarios replace the over-budget composite; original assertions and 30-second limit retained |
| Passive panel geometry | FX housings and track-deck perimeter changed; before/after control rectangles and scales match at 1920/1366. No hardware photometry claim |
| Native atomic ALL | Separate WIP branch; software-only UI and callback tests do not yet constitute final integrated acceptance |
| Current local UI | Port 4196 process belongs to this integration worktree; independent Browser captures did not start audio or touch the user's tab |
| RC-505 discovery | At 2026-11-07 06:32 +08:00, Windows SoundDevice and present-PnP name checks found no RC-505/BOSS/Roland matches |
| Physical latency / XRUN / sound / LEDs | **HARDWARE_RC505_BLOCKED**; no measured values supplied |

The current unit JSON is `rc505-main-unit-f4e9f99-20261107.json` in the local
Codex temporary directory, SHA-256
`f3f7d7d43a6fb108249062ae90628d4623ce78a8e94bb36980101cfdb78c363e`.
That report is not evidence for later Native batch worktree changes.

The corresponding scoped E2E JSON is
`rc505-main-scoped-f4e9f99-20261107.json`, SHA-256
`8e2a6f162f56ea007a2ce017ea253ea4a9dc2e6b1b7c4fb6d7e583adf0013714`.
It does not replace the pending complete integrated E2E run.

The HQ simulation executable used for the Rhythm branch has SHA-256
`2dfaaf8b05269f93e385eb235738fb748a88c0470fbf71ccf75905f9505ffa4e`.
It was built in the independent Rhythm worktree. Its tracked engine-cpp tree
and this integrated source both resolve to
`6360a7ebab7123cb49173c4bfd28c70c0a7d16d1`; this equivalence is not a claim of
a separate fresh build in the integration worktree or physical WASAPI testing.

## Software gates still open

- Complete one zero-retry integrated E2E run after the final changes.
- Finish Native ALL recovery ownership, initial identity persistence and
  readiness fencing, then rerun its complete units, fresh Native targets,
  HTTP/UI paths and affected callback performance matrix.
- Native ALL with LOOP SYNC, AutoRec and quantized group scheduling are not
  supplied by the current non-synchronized batch implementation. These are
  software gaps, not consequences of missing hardware.
- Mark BACK still requires verified transition semantics. Physical routing,
  full Memory equivalence, calibrated indicators and audio equivalence remain
  separately qualified in the [UI capability dashboard](../ui-parity/RC505_UI_PARITY.md).

R2/R3 waveform checks and passive LED rendering checks must state their exact
scope; synthetic/imported PCM or component props do not prove Roland sound,
physical capture, real Bank routing or LED photometry.
