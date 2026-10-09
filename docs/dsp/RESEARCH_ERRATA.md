# DSP research and benchmark errata

This file records corrections found while auditing the supplied implementation research. The source package is retained unchanged; these notes prevent its mistakes and non-equivalent measurements from becoming implementation contracts or product evidence.

## F04 all-pass coefficient/sign mismatch

The primary report states `a=(tan(pi*fc/fs)-1)/(tan(pi*fc/fs)+1)` and then gives `y[n]=-a*x[n]+x[n-1]+a*y[n-1]`. Those two expressions do not place the all-pass phase center at `fc` together: with the stated coefficient, the stated recurrence centers at `Nyquist-fc`. For the declared coefficient and requested center frequency, use `y[n]=a*x[n]+x[n-1]-a*y[n-1]`. Native has a phase-center regression check at 3 kHz in a 48 kHz sample-rate test. The source report remains the source citation; the corrected implementation contract is explicit in `dsp/spec/formula_index.json` and `dsp/spec/formula_errata.json`.

## F07 ADAA benchmark antiderivative

The old benchmark's clamp antiderivative is not a global antiderivative of the clipped cubic. The corrected candidate is `F(x)=0.75*x^2-0.125*x^4` for `|x|<1`, and `F(x)=|x|-0.375` outside that range. Integrate the transfer function without clamping the input first. Code still needs derivative/continuity and alias-quality tests before it qualifies. First-order ADAA has no whole-sample delay buffer, but its divided difference has frequency-dependent small-signal group delay (approximately half a sample at low frequencies); “zero algorithmic latency” must not be read as literally zero phase/group delay.

## FDN Hadamard normalization mismatch

The archived `bench/browser_kernels.c` scales by `1/sqrt(8)` at every one of three Hadamard stages, leaving aggregate matrix norm near `1/8`, instead of applying the orthogonal transform normalization once. Native source applies one final `1/sqrt(8)` factor. The old browser and Native FDN numbers are therefore not equivalent and cannot pass product Gate3 or Gate7.

## Noise stimulus is not bipolar

The archived browser benchmark's `seed >> 8` input produces nonnegative values (0..2 in the reviewed path), not bipolar noise. Noise/stochastic quality results from that stimulus do not qualify product behavior.

## Parameter-guide extractor status

The local PDF extraction draft has known geometric and font issues: value-column bleed into Explanation, wrapped TYPE values split at the wrong row boundary, mixed Hz/kHz values needing canonicalization, and musical glyph/default detection that must remain nullable when not proven. `official_fx_parameters.json` is a draft for review, not a normative range/default/choice contract. No explanatory manual prose, manual PDF, Roland code, factory audio, or factory MIDI is included in the catalog.
