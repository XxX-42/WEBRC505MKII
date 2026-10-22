#!/usr/bin/env bash
# Functional/stability batch, intentionally co-loaded. Never use its timings as isolated A/B evidence.
set -u
cd "$(dirname "$0")/.."
D=docs/performance/20261021
mkdir -p "$D" /tmp/rc505-browser-perf
if [ ! -f /tmp/rc505-browser-perf/baseline.js ]; then
 git show dd7dbea3502993d9167c4af16aef5dce98577c9e:public/worklets/fx-processor.js > /tmp/rc505-browser-perf/baseline.js || exit 1
fi
printf 'started=%s\nload=co-loaded functional checks; not isolated timing acceptance\n' "$(date -u +%FT%TZ)" > "$D/final-gates.status"
sha256sum public/worklets/fx-processor.js > "$D/final-gates-source.sha256"
(
 npm run build > "$D/final-build.txt" 2>&1; echo "build=$?" >> "$D/final-gates.status"
 npm run test:unit -- --run > "$D/final-unit.txt" 2>&1; echo "unit=$?" >> "$D/final-gates.status"
 node bench/verify_cloud_preview.mjs > "$D/cloud-preview.txt" 2>&1; echo "cloudPreview=$?" >> "$D/final-gates.status"
) & gates=$!
(
 FX_SANITY_WORKLET=/tmp/rc505-browser-perf/baseline.js npx vite-node bench/run_fx_sanity_matrix.ts "$D/fx-sanity-corrected-baseline.json" > "$D/fx-sanity-corrected-baseline.txt" 2>&1; echo "sanityBaseline=$?" >> "$D/final-gates.status"
 FX_SANITY_WORKLET=public/worklets/fx-processor.js npx vite-node bench/run_fx_sanity_matrix.ts "$D/fx-sanity.json" > "$D/fx-sanity-final.txt" 2>&1; echo "sanityFinal=$?" >> "$D/final-gates.status"
 export FX_SANITY_EFFECTS=delay,reverse-delay,warp,roll,freeze,reverb,gate-reverb,reverse-reverb FX_SANITY_RATES=48000 FX_SANITY_MODES=maximum FX_SANITY_SIGNALS=impulse,stereo-asymmetric FX_SANITY_SECONDS=10
 FX_SANITY_BASELINE="$D/fx-long-tail-baseline.json" FX_SANITY_WORKLET=/tmp/rc505-browser-perf/baseline.js npx vite-node bench/run_fx_sanity_matrix.ts "$D/fx-long-tail-baseline.json" > "$D/fx-long-tail-baseline.txt" 2>&1; echo "longTailBaseline=$?" >> "$D/final-gates.status"
 FX_SANITY_BASELINE="$D/fx-long-tail-baseline.json" FX_SANITY_WORKLET=public/worklets/fx-processor.js npx vite-node bench/run_fx_sanity_matrix.ts "$D/fx-long-tail.json" > "$D/fx-long-tail.txt" 2>&1; echo "longTailFinal=$?" >> "$D/final-gates.status"
) & sanity=$!
(
 SIM_SECONDS=1800 STRESS_OUTPUT="$D/browser-functional-30min.json" npx vite-node bench/run_browser_cpu_functional_stress.ts > "$D/browser-functional-30min.txt" 2>&1; echo "functionalSim30min=$?" >> "$D/final-gates.status"
) & stress=$!
wait "$gates" "$sanity" "$stress"
printf 'finished=%s\n' "$(date -u +%FT%TZ)" >> "$D/final-gates.status"
sha256sum public/worklets/fx-processor.js > "$D/final-gates-source-end.sha256"
cmp -s "$D/final-gates-source.sha256" "$D/final-gates-source-end.sha256"; echo "sourceStable=$?" >> "$D/final-gates.status"
cat "$D/final-gates.status"
if grep -Eq '^[A-Za-z0-9]+=[1-9][0-9]*$' "$D/final-gates.status"; then exit 1; fi
