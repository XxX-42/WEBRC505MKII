# Corrected Rhythm independent regression capsule

This preserves the unchanged gain-only defect probe against a fresh MSVC build of all five corrected DSP source units. `execution.json` records 64/64 velocity comparisons changing more than gain. Eight raw stereo float32 files preserve four kit-0 comparisons; this is not perceptual quality or realtime qualification.

The original probe returns **1 when timbre differs**, 0 when every pair is gain-only, and 2 for setup/nonfinite failures. The recorded exit 1 is expected evidence of the fix.

Run `build.cmd` from this folder using the indicated installed VS2019 toolchain, then `probe.exe . > result.json`. Executable/object files are deliberately excluded from this capsule; their original hashes and raw build output are retained. Inputs are pinned in `source-hashes.json`.
