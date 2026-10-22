# Duplicate hypothesis screened out before execution

Current checkout: 85de65407377ad0efcbf99967e521db86f9f036d. The proposed GNU/Clang always-inline attribute on antialiasedTriode is not a new candidate: docs/performance/20261021/native-report.md already records force-inline ADAA rejection with 5.20% p50 regression, with original evidence in native-inline-abba.json.

Read-only Release disassembly confirms real out-of-line calls, so the call observation is not merely a gprof instrumentation artefact. However, existence of calls does not imply inlining is beneficial and does not materially distinguish this proposal from the rejected experiment. No candidate was constructed, no benchmark rerun, and no production source changed. Stop this duplicate hypothesis rather than consume another measurement cycle. This is not new performance acceptance or proof that remaining software P0 is solved.
