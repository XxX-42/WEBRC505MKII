# Official FX parameter API contract

## Discover, rather than guess

- `src/audio/fx/official/parameter-guide.json` records the manual rows, ranges, documented defaults and source provenance. The coverage CSV distinguishes executable, partial and unsupported rows.
- Browser executable keys come from `BROWSER_OFFICIAL_PARAMETER_KEYS`. `getBrowserTrackFxControls` adds official labels, units, choices and conditional visibility while retaining separately labelled extension controls.
- Native `GET /v1/status` publishes `nativeFx.catalogEffectAvailability[].officialParameters`, including availability, variant domains, enum labels and semantic limitations. Treat this live capability schema as authoritative for that host, rather than assuming every manual row is implemented.

## Browser public setter

After creating the intended FX in the existing slot, the shared facade is:

```ts
engine.setCatalogFxParameters('input', 0, {
  official_cutoff: 50,
  official_rate: -1,
});
```

Here slot 0 means A; the example requires the LPF effect already selected. Native and Browser engine modes use the same facade. It is a control command, not a measurement of resulting audio or a synchronous Native DSP acknowledgement. Private-track routing uses the existing per-track API and enforces its separate capability constraints.

Official values are in the documented semantic domain: LPF cutoff 0–100 is not the legacy cutoff in Hz. A negative note value such as `-1` denotes a quarter note where that parameter admits it; do not invent intermediate choices absent from the supported domain. MEAS synchronization additionally uses the actual meter. Indexed STEP LEVEL controls have individual `official_step_level_N` addresses. TAPE ECHO and ROLL use explicit variant routing, applied before variant-specific values.

## Native host setter

```json
{
  "path": "input",
  "slot": "A",
  "effectId": "filter.lpf",
  "parameters": { "official_cutoff": 50, "official_rate": -1 },
  "bypassed": false
}
```

Send this body to `POST /v1/native-fx/catalog-slot` on the already configured host. Read the returned status and subsequent authored parameter snapshot. `replaceParameters: true` is an advertised capability for complete replacement/reset, not a merge. Removing active official fields may return HTTP 409 requiring Native audio to stop first; a pending operation must not be persisted as acknowledged. Existing patch behavior remains available without replacement. Engine-owned BPM/meter fields are distinct from authored controls.

## Compatibility and truthfulness

- Official keys are additive `official_*` controls. Existing IDs, extension units and legacy-only behavior remain intact. First explicit official opt-in materializes the supported documented defaults consistently; it is not silently applied merely because the project BPM changes.
- Once opted in, corresponding official controls own their DSP axes. A subsequent legacy macro replay must not overwrite those axes. Removing official overrides uses the actual reset/replacement path.
- The 267-row matrix covers per-algorithm parameter tables, not a claim that every bank-level SW MODE, FX sequence, knob assignment or MIDI function has been completed. Snapshot readback confirms control state, not physical DSP quality or hardware equivalence. Browser recovery and the UI's current persistence are not a claim of full hardware MEMORY archive compatibility or complete MIDI ASSIGN support.
- Undocumented MODE algorithms and factory phrase/pattern banks are not represented by empty working knobs. Unmapped physical carrier inputs are not replaced with synthesized audio under those names. Track-source limitations are explicitly labelled.
- Invalid official values are rejected. Some Browser invalid-control paths enter clean bypass rather than retaining a previously active invalid target; callers must inspect status instead of assuming setter return means success.
