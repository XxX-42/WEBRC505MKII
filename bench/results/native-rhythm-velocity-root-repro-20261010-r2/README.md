# Rhythm velocity gain-only reproduction

Root compiled a standalone64-frame probe against the existing copied preflight-v1 DSP library. This is a linked-library probe, not a new full source build. Captured rhythm.cpp/spatial_temporal.cpp source/interface hashes match current live source.

At48kHz, stereo,8192frames per hit,16kits x4voices (Kick,Snare,ClosedHat,TomLow)=64cases compared velocity32 and112 with identical initial state. Least-squares gain removal compares stereo waveforms after removing amplitude differences. Every case changes only gain to float precision: fitted gain approximately3.5; largest relative residual5.35469e-8. Tolerance1e-5 distinguishes numerical rounding from synthesis changes and is not a perceptual quality criterion.

The implementation package requires velocity/accent to affect synthesis parameters. These cases therefore do not demonstrate that requirement. Seed variation between hits also does not prove deliberate velocity layers or round-robin articulations. This covers four voices, not every articulation or whole-system stress.

Eight raw PCM sidecars capture kit0 low/high velocity for the four voices,Float32 little-endian interleaved stereo,48kHz,8192frames each. Independent Python reanalysis recomputes gain removal from those exact bytes. Full64case results are in result.json.

Exit0 reproduces gain-only differences across all tested cases; exit1 means at least one is not gain only and requires quality review, rather than automatic Gate6 acceptance; exit2 indicates setup/nonfinite/silence failure. The initial missing-section setup failure remains separately retained. build.cmd contains original paths; replay substitutes dsp-include and archived webrc_dsp.lib with fresh output paths. No hardware stream was opened.
