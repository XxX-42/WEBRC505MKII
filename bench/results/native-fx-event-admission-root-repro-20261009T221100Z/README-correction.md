# Setup-failure inventory correction

The original README incorrectly names an empty `result.json` as a preserved
file. The first executable exited with setup code 2 and printed no output;
PowerShell's `Tee-Object` did not create that file. No `result.json` exists or is
listed in the archive index. The original `repro.cpp`, `build.cmd`, `build.log`
and captured executable preserve the failed fixture; its exit code was observed
in the root tool result. The corrected fixture's `result-v2.json` exists and
reports the reproduced admission gap. That result and its hashes are unchanged.
