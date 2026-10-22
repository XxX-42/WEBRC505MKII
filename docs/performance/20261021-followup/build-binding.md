# Expanded Native build provenance guard

The previous verifier bound PREAMP source/header to its object, DSP archive and explicit benchmark executables. This iteration recursively reads the selected targets' GNU Make link commands and GCC depfiles, checking every declared source/header dependency (including bench files outside the engine root and system headers), object, archive and executable timestamp order, and retaining their SHA-256 values. It does not assert a signed or adversary-resistant build attestation.

New manifests require `dependencyBindingVersion: 1` and nonempty source dependencies. The matrix runner rejects legacy/empty manifests instead of silently treating them as comprehensive verification. Calls without a manifest remain explicitly unverified. The soak runner additionally checks binding before and after its run.

Five dependency unit tests cover normal binding, a changed non-PREAMP header, an external bench source, stale linked library and missing depfile. Matrix preflight regressions cover legacy and empty bindings, mismatched source/header dependencies, unverified manifests and correct per-row unverified labeling. These are metadata fixtures, not audio/performance results. The Native soak runner has its own seven fixture tests.

`baseline-build-dependencies.json` and `build-manifest-tests.json` at this directory's top level are initial development evidence predating the version-1/all-dependency tightening. They are superseded for final acceptance by `native/final-build-manifest.json` and `final/build-*` test outputs. No current runner should accept that earlier manifest as comprehensive binding.

Limitations: this implementation supports the existing GNU Make/GCC portable build layout. It records declared dependencies rather than discovering undocumented generated inputs or proving toolchain correctness. A missing/stale artifact fails closed; timestamp and hash provenance is a reproducibility guard, not an authenticity guarantee.
