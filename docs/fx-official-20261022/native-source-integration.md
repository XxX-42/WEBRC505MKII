# Source-aware Native integration checkpoint

The Native host's actual schema reconciles to 252 functional clean-room rows, 3 partial-source-mode rows and 12 unsupported rows out of the 267 official source rows. Partial rows are BEAT SHIFT TYPE/SHIFT and VINYL FLICK: shared Track A stored-loop playback is implemented, but recording, overdubbing, reverse and conflicting live pitch modes are explicitly unsupported. Track A private REPEAT/SCATTER is supported; source-readhead SHIFT/VINYL requires shared A.

Browser coverage in this checkpoint is deliberately frozen to revision `944b728`; concurrent, unvalidated VOCODER carrier work is not counted. Reproduce with `python3 scripts/fx/generate-official-coverage.py --native-schema docs/fx-official-20261022/native-runtime-schema.json --browser-revision 944b728 --browser-meter-verified --native-meter-verified`.

Evidence: 52/52 portable CTest targets, 5/5 HTTP/simulation targets, and 3 frontend schema/catalog suites with 104 tests pass. The SCATTER ownership regression failed before the `slice_beats` guard correction and passed afterward. Raw logs are in `validation-logs/native-source-*`. Independent read-only source/lifecycle review found the ownership issue; no other source-transport blockers were found. Full frontend regression at `944b728` remains historical, not a claim about concurrent Browser changes.

Schema SHA-256: `15b3333cc31251f38972afa2d9dfcfa78eb07f142bac712511a647703d2234a6`. The 265 runtime official descriptors include two routing selectors and expand indexed STEP LEVEL values, so this number is not the 267-row manual coverage count.

No physical-device deployment, factory sound parity, hardware round-trip latency, XRUN or strict realtime deadline acceptance is claimed. Native source readhead processing occurs before insert processing; a standalone pass-through insert benchmark does not measure that source work.
