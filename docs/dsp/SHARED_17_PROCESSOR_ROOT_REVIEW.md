# Shared 17-processor checkpoint

The root reviewer independently checked all 62 exact archived source files,
their byte counts and SHA-256 values, the source-set fingerprint, and the nine
indexed build artifacts. All 62 matched the live compiler inputs at review time.
The independent CTest rerun against the copied-source Release build passed
11/11 tests in 2.32 seconds. The executor's preceding run passed in 2.62 seconds.

Archive: `bench/results/native_shared_dsp_checkpoint_20261009T151930Z`.
Source manifest SHA-256: `7883259e6512385dea7138277cfaf806a1f2d65cdf17647cf29e0cef39cefdde`.
Source-set SHA-256: `e66b8890c310aa490bd04a944dce1cc8bc6e4de452b89a8699d2b309ff36b3f4`.
The canonical fingerprint concatenates lexicographically sorted UTF-8
`path=sha256\n` entries, including the last newline. The archive contains all
CMake-listed compiler inputs, including seven benchmark/executable sources,
without recursively copying historical benchmark result trees.

The build used MSVC 19.50.35721.0, CMake 4.4, NMake Makefiles and Release flags
recorded in the archive. It configured and built from the copied source tree.
Directory timestamps are labels; the archive index records its actual creation
time separately (`2026-10-09T15:14:58Z`).

The registry's `ProcessorAvailable` entries are ordinals
1, 2, 3, 4, 7, 9, 25, 26, 29, 30, 32, 36, 47, 50, 51, 52 and 53.
They have executable stereo processors and bounded parameter validation.
The other 36 entries remain metadata only. Availability does not establish
official parameter-curve equivalence, final audio quality, complete FX-bank UI
integration, Browser availability or full-graph realtime qualification. Composite
Radio/Sustainer/Slow Gear/Stereo Enhance sources are excluded from this checkpoint.

The checkpoint also contains an incremental fixed-window YIN detector and an
actual mono YIN-to-streaming-TD-PSOLA route. The latter's test tracks a 55 Hz
input and checks a 1.5x pitch-shifted output. Its broad frequency tolerance is a
functional check, not a cents-accuracy or listening-quality qualification. Native
route code exists; a corresponding WASM wrapper and application route selection
are not qualified by these CTests. LIVE_POLY and HQ_RENDER remain separate work.

The declared 4,096-frame detector window and 3,600-frame resynthesis lookahead
are static configuration components. Their sum excludes observed detector
processing lag and is not a measured group delay, first shifted output latency,
full graph latency or device latency. Analysis-work counters bound detector
analysis operations; input ingestion is additionally covered by elapsed callback
timing. Preflight now rejects invalid YIN threshold and hop settings before
allocation, with tests preserving an already prepared route on rejection.

The rhythm renderer and generated 240-pattern/16-kit source are included in the
tested library. This does not establish all-pattern listening quality, original
Roland sound equivalence or complete Browser timing behavior. No Gate is passed
by this source checkpoint alone.

## Separate incremental YIN timing failure

Historical capture: `bench/results/native_streaming_yin_callback_20261009T150826Z`.
The root reviewer verified its 55-source fingerprint, three artifact hashes,
20,000 chronological rows, three percentile summaries, analysis-work bounds and
deadline counts. The raw result is unchanged:
`54f234d9c453b7a56e6436124618d677042fad0cec033628a69b17fb94d2db2d`.

At 48 kHz / 64 frames, all-call P99 was 869 microseconds, P99.9 was 3,639
microseconds, maximum was 45,825.8 microseconds, and 91 calls exceeded the
1,333.333-microsecond deadline. There were no observed process allocations.
Parallel project work was active; there is no evidence attributing individual
overruns to host jitter. This result fails the callback timing thresholds and
is not complete-graph or hardware qualification.

That historical 55-file archive predates the later LIVE_MONO preflight correction
and does not contain all benchmark sources referenced by its CMake file. Its
detector inputs are retained, but whole-project reproduction uses the complete
62-file checkpoint above. The historical raw is not relabeled as a newer run.
