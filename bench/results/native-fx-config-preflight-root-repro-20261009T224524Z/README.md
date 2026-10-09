# Native configure preflight: independent failure reproduction

Root built and executed this software-only C++ harness with MSVC 14.29 /O2, against three copied libraries from the Native r3 build. It did not start any hardware stream. The current public regression suite was green, but the harness demonstrates allocation before early configuration rejection.

With only one byte left in the aggregate FX ledger, a valid Filter configuration is rejected for budget only after two shadow allocations totaling 448 bytes. An unprepared host, a rate mismatch, and an invalid 8 kHz Nyquist frequency each allocate one 224-byte shadow before returning their correct rejection status. The accepted bank remains unset; the defect concerns temporary memory admission and unnecessary repeated validation, not an incorrectly accepted graph.

The archive retains exact harness, captured Native/DSP headers, linked libraries, command, raw /showIncludes compiler log, executable/object, stdout JSON and input manifest. The input manifest describes the original copied inputs; the archive index covers all final payloads. Libraries are captured precompiled artifacts, so this is not claimed to be a complete rebuildable Native source closure. The raw compiler log may use the installed MSVC locale; it is preserved without conversion.

The harness exits 0 when all four old failures are reproduced, exits 2 on setup failure and exits 1 when the four-case old-defect predicate is false (including after a correct fix). Future regression tests must instead require zero allocations on those rejection paths. No callback latency, hardware latency, Native full-system Gate or quality pass follows from this result.
