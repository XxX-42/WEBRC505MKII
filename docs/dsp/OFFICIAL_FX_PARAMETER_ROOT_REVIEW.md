# Official FX parameter extraction review

The coordinator rendered and visually reviewed all printed FX pages 34–43 of the SHA-pinned English 04 parameter guide. The extraction remains a candidate, separate from production control acceptance. The 53 effect identities include the separately documented Tape Echo 1/2 and Roll 1/2 variants; the final four Track-only effects are restricted to FX A in MULTI mode as printed on page 43.

The Value column is the parameter source; Explanation prose is excluded. Ordinary defaults are blue bold spans. Custom note-font defaults use the same blue value style without a bold font, requiring explicit visual confirmation. On pages 34, 40, 41 and 43, the blue quarter-note glyph is visibly the default value. Page 34 global sequencer SW/SYNC/RETRIG defaults are OFF and MAX defaults to 16; VAL1–16 has no observed default cue.

At 12-times PDF rendering scale, glyph U+00AA is a hollow whole-note head without a stem; U+02C7 is a hollow half-note head with stem; U+00B8 is a filled quarter-note head with stem; U+02DC has two flags (sixteenth note); U+0060 has three flags (thirty-second note). The initial candidate misread U+0060 as eighth; the coordinator rejected that mapping. These endpoint glyphs do not enumerate all intermediate, dotted or triplet rhythmic choices. Runtime tempo-domain choices must explicitly distinguish source facts from locally chosen behavior.

Page 38 EQ mixed-unit conversions are confirmed: LO-MID FREQ 20–10000 Hz, default 800 Hz; HI-MID FREQ 20–10000 Hz, default 3150 Hz. Page 42 reverb time 0.1–10 seconds, default 3 seconds, can canonically use 100–10000 ms/default 3000 ms; reverse gate time 0.1–1 second/default 0.5 second becomes 100–1000 ms/default 500 ms. The source text and unit evidence must remain alongside canonical values.

Page 36 ELECTRIC has two distinct rows FORMANT (-50–50, default 0) and SPEED (0–10, default 5). The initial extractor merged them as FORMANT SPEED; that candidate cannot be considered complete until its row geometry is repaired. Other mixed domains include OFF plus bit depth/downsampling, FLAT plus frequency, CENTER plus pan/distance, INF plus repeat count, note/key ranges, and rhythmic values plus numeric rates. Keeping their raw text is useful provenance, but does not implement bounded controls or validate a DSP mapping.

Official names, numeric labels and defaults establish the control contract. They do not expose proprietary DSP constants, transfer functions or acoustic equivalence. Runtime adapters, smoothing, switching, aliases, graph integration and quality fixtures must be accepted separately. The candidate files remain runtime-disabled while those mappings are reviewed.

Source: [RC-505mkII Parameter Guide, English 04](https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf), SHA256 `6473e5d990849d3c083cd532764d2a17326c9db6d7068bbe54b1fee6397c289b`.
