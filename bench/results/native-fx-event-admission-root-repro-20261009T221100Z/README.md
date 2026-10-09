# Native per-slot event admission diagnostic

Captured older pre-HTTP Native libraries reproduce an admission defect without starting an audio device. This is not a whole-source build closure or a Gate acceptance result.

SUSTAINER ordinal 11 has a 64-parameter-event bound. After graph activation, two consecutive batches of 40 Wet events at frame 64 both enqueue successfully. The next 64-frame graph callback returns EventBatchRejected, rejects all 80 events, and leaves bus PCM untouched. Enqueue acceptance therefore cannot establish DSP application. The Native executor is adding producer-side admission by each staged slot's actual capacity.

The first fixture used Mix, which is not a descriptor of SUSTAINER, and exited 2 during setup. The original repro.cpp, empty result.json and build.log preserve that failed setup. The corrected repro-v2.cpp uses Wet and result-v2.json verifies the actual defect. Both captured executables and build commands are preserved. The commands contain the original workspace paths; headers/libraries are copied beside this README for inspection and repeat compilation.

The build uses MSVC 19.29 / toolset 14.29.30133, x64, /O2 /Ob2 /DNDEBUG /MD /EHsc /std:c++17, without /fp:fast. Capture headers and libraries are byte-pinned in diagnostic-inputs.json; later current Native/Pitch/HTTP edits are outside these binaries. This does not assert that the complete original library source can be reconstructed from this diagnostic archive.
