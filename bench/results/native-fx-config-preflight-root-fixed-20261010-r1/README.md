# Independent Native configure preflight fix verification

Root rebuilt the unchanged defect fixture from commit 6499898 against the existing, copied preflight-v1 Release libraries. This is a linked-fixture verification, not a new full source build. The same four rejects now allocate zero bytes and zero objects, retain the expected statuses, and leave the bank unconfigured.

The fixture intentionally exits **1** when the old defect no longer reproduces; exit 0 means the old defect reproduced, and exit 2 means setup failed. Root also executed the copied native_fx_control_tests.exe successfully. The executor separately reported 34/34 tests from its fresh copied build; that broader claim is outside this archive's independent run scope.

Captured inputs include the exact fixture, all supplied Native/DSP public headers, three preflight implementation/test sources, and the three linked libraries. build.raw.log retains compiler output and /showIncludes. build.cmd contains original execution paths; for replay, replace the two include directories and three library paths with the corresponding archived files, and select a fresh output directory.

No hardware stream was started. No claim of full FX quality, all runtime routing, or realtime stress acceptance follows from this probe.
