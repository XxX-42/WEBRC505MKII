# Official FX UI source facts, 2026-10-10

The reviewed source artifact covers all 53 contract FX families: 49 Input FX and 53 Track FX. It preserves 55 printed sections and 267 parameter rows because TAPE ECHO and ROLL each have two separate published variants. Variant-qualified parameter IDs prevent one table from overwriting the other.

Root reviewed rendered pages 34–43 of the [English 04 parameter guide](https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf). The source PDF SHA-256 is `6473e5d990849d3c083cd532764d2a17326c9db6d7068bbe54b1fee6397c289b`. The review record in `docs/validation/20261010/official-fx-ui-root-review.json` records the renderer, page image hashes and exact source artifact hashes. The original PDF and temporary review PNGs are not duplicated into the repository.

The artifact retains raw value cells, source geometry, default evidence and independent assignability/sequence/initial-value markers. Explicit source ranges have canonical units where justified. Musical glyph ranges remain unexpanded; unprinted divisions and DSP transfer curves are not inferred. Unmarked DYNAMICS/DIST TYPE defaults remain unknown.

Implementation-relevant findings include the OCTAVE choices -1OCT, -2OCT and their dual voice; VOCODER's input/track carrier choices; finite-repeat Delay UI values; separate Tape Echo and Roll variant domains; and the page-43 restriction of the four Track-only performance effects to FX A in MULTI mode. These facts expose missing local controls or semantics; they do not qualify the reconstructed algorithms or prove runtime feature parity.

Validation:

```powershell
python dsp/spec/build_native_fx_ui_contracts.py
python dsp/spec/validate_native_fx_ui_contracts.py
```

The independent validator checks family/section/row counts, stable IDs, raw source/default/marker preservation, numeric domains, variants and placement constraints. `runtimeConsumptionAllowed=false` and `dspImplementationContract=false` remain mandatory. Native/Web UI mapping, all implemented controls, quality and realtime acceptance remain pending.

Root also exported the staged Git objects to a separate directory and regenerated the exact same artifact before running both validators. The candidate's original CRLF bytes are pinned with `-text` so its recorded SHA survives checkout; its content after newline normalization equals the previous commit.
