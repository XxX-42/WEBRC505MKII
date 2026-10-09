"""Verify the frozen standalone delay capture; this never qualifies product RT."""
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CAPTURE = ROOT / 'shared/dsp/benchmarks/results/modulated-delay-fx-review-20261009T233500'
manifest = json.loads((CAPTURE / 'manifest.json').read_text(encoding='utf-8-sig'))
for entry in manifest['inputFiles']:
    path = CAPTURE / 'snapshot' / entry['path']
    data = path.read_bytes()
    assert len(data) == entry['bytes'], entry['path']
    assert hashlib.sha256(data).hexdigest() == entry['sha256'].lower(), entry['path']
canonical = ''.join(f"{e['path']}:{e['sha256'].lower()}:{e['bytes']}\n"
                    for e in sorted(manifest['inputFiles'], key=lambda e: e['path']))
assert hashlib.sha256(canonical.encode()).hexdigest() == manifest['sourceFingerprintSha256']
assert manifest['sourceFingerprintSha256'] == 'f0b35e08fee3406390b14334c4566f3a9604ce501b7a9b5269c2c19d241b63dc'
raw_bytes = (CAPTURE / 'modulated_delay_callback_bench.json').read_bytes()
assert hashlib.sha256(raw_bytes).hexdigest() == 'ffae9956faa060f7f4f8d4fd1537a3d8c898cd52e9ac0189f65e32ec1b85bfdd'
raw = json.loads(raw_bytes.decode('utf-8-sig'))
assert raw['cases'] == manifest['benchmarkCases']
assert raw['sampleRate'] == 48000 and raw['framesPerBlock'] == 64
assert len(raw['cases']) == 10
hard_misses = 0
for case in raw['cases']:
    samples = case['rawCallbackNsChronological']
    assert len(samples) == case['measuredBlocks'] == 10000
    assert all(isinstance(n, int) and n >= 0 for n in samples)
    ordered = sorted(samples)
    for name, fraction in [('p50Ns', .5), ('p95Ns', .95), ('p99Ns', .99), ('p999Ns', .999)]:
        assert case[name] == ordered[math.ceil(fraction * len(ordered)) - 1]
    assert case['maxNs'] == ordered[-1]
    assert case['deadlineNs'] == 1_000_000_000 * 64 // 48000
    for count, threshold in [('over60', 'target60Ns'), ('over80', 'target80Ns'), ('over100', 'deadlineNs')]:
        assert case[count] == sum(n > case[threshold] for n in samples)
    hard_misses += case['over100']
print(json.dumps({'integrity': 'PASS', 'cases': 10, 'measurements': 100000,
                  'hardDeadlineMisses': hard_misses, 'productRealtimeQualified': False}))
