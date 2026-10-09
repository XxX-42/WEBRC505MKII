"""Read-only verification of independent evaluator captures; no benchmark rerun."""
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timezone
import argparse, csv, hashlib, json, math, platform, sys
import numpy as np

REPO = next(p for p in Path(__file__).resolve().parents
            if (p / 'shared/dsp').is_dir() and (p / 'package.json').is_file())
BASE = REPO.parent
RB = BASE / 'research-input/rubberband-r2r3-independent-20261009T195900Z'
AUDIT = BASE / 'research-input/rubberband-r2r3-additive-stable-window-audit-v2-20261009T201400Z'
OUT = REPO / 'docs/validation/20261009/rubberband-independent-root-review.json'

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()

def readj(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def verify_index(root):
    records = []
    seen = set()
    for line in (root / 'SHA256SUMS.txt').read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        digest, rel = line.split(None, 1)
        rel = rel.strip()
        path = root / rel
        assert rel not in seen and path.resolve().is_relative_to(root.resolve()), rel
        seen.add(rel)
        assert sha(path) == digest, rel
        records.append({'path': rel, 'bytes': path.stat().st_size, 'sha256': digest})
    return {'indexedFiles': len(records), 'indexedBytes': sum(x['bytes'] for x in records),
            'indexSha256': sha(root / 'SHA256SUMS.txt'), 'allIndexedHashesMatch': True}

def pcm(path):
    a = np.fromfile(path, dtype='<f4')
    assert len(a) % 2 == 0 and np.isfinite(a).all(), str(path)
    return a.reshape(-1, 2)

def percentile(a, p):
    s = sorted(a)
    return s[math.ceil(len(s) * p) - 1]

def spectral_metric(x, target):
    # A broad dominant spectral component is not necessarily the fundamental.
    # Zero padding interpolates the spectrum; the 1-second window still limits resolution.
    x = x.astype(np.float64)
    window = np.hanning(len(x))
    nfft = 1 << 19
    magnitude = np.abs(np.fft.rfft((x - np.mean(x)) * window, nfft))
    frequencies = np.fft.rfftfreq(nfft, 1 / 48000)
    allowed = np.flatnonzero((frequencies >= 1) & (frequencies <= 200))
    k = int(allowed[np.argmax(magnitude[allowed])])
    y = np.log(np.maximum(magnitude[k-1:k+2], 1e-300))
    denominator = y[0] - 2 * y[1] + y[2]
    delta = 0.5 * (y[0] - y[2]) / denominator if denominator else 0
    peak_hz = (k + delta) * 48000 / nfft
    local = [int(i) for i in allowed if magnitude[i] > magnitude[i-1] and magnitude[i] >= magnitude[i+1]]
    chosen = []
    for i in sorted(local, key=lambda i: magnitude[i], reverse=True):
        if all(abs(frequencies[i] - frequencies[j]) >= 1 for j in chosen):
            chosen.append(i)
        if len(chosen) == 5:
            break
    t = np.arange(len(x), dtype=np.float64)
    projection = float(2 * abs(np.dot(x, np.exp(-2j * np.pi * target * t / 48000))) / len(x))
    return {'targetHz': target, 'rectangularExactTargetProjectionPeak': projection,
            'hannDominantSpectralComponentHz': float(peak_hz),
            'dominantOutsidePriorPlusMinus3HzSearch': bool(abs(peak_hz-target) > 3),
            'topSpectralComponents': [{'binHz': float(frequencies[i]),
                'hannPeakAmplitude': float(2 * magnitude[i] / window.sum())} for i in chosen]}

def main():
    global RB, AUDIT, OUT
    parser = argparse.ArgumentParser()
    parser.add_argument('--rubberband-root', type=Path, default=RB)
    parser.add_argument('--audit-root', type=Path, default=AUDIT)
    parser.add_argument('--output', type=Path, default=OUT)
    args = parser.parse_args()
    RB, AUDIT, OUT = args.rubberband_root.resolve(), args.audit_root.resolve(), args.output.resolve()
    report = {'schemaVersion': 1, 'createdUtc': datetime.now(timezone.utc).isoformat(),
        'disposition': 'Research evidence verified; no product adoption, timing qualification or Gate pass',
        'tooling': {'python': sys.version, 'numpy': np.__version__, 'platform': platform.platform()},
        'captures': {'rubberBand': {'path': str(RB), **verify_index(RB)},
                     'correctedStableWindowAudit': {'path': str(AUDIT), **verify_index(AUDIT)}}}
    manifest = readj(RB / 'manifest.json')
    before = manifest['build']['sourceHashesBefore']
    after = manifest['build']['sourceHashesAfter']
    assert before == after and len(before) == 169
    for rel, digest in before.items():
        assert sha(RB / 'upstream-source' / rel) == digest, rel
    for record in manifest['artifacts'] + manifest['analysisArtifacts']:
        path = RB / record['path']
        assert path.stat().st_size == record['bytes'] and sha(path) == record['sha256'], record['path']
    report['upstream'] = {**manifest['upstream'], 'beforeAfterSourceHashesMatch': True,
                          'actualVerifiedUpstreamFiles': len(before),
                          'completeExternalSdkBuildClosureVerified': False}
    audit_manifest = readj(AUDIT / 'manifest.json')
    assert sha(RB / 'manifest.json') == audit_manifest['sourceArchives']['rubberBand']['manifestSha256']
    for record in audit_manifest['verifiedCopies']:
        source = Path(record['source'])
        original_rb = Path(audit_manifest['sourceArchives']['rubberBand']['path'])
        original_ss = Path(audit_manifest['sourceArchives']['signalsmith']['path'])
        if source.is_relative_to(original_rb):
            source = RB / source.relative_to(original_rb)
        elif source.is_relative_to(original_ss):
            source = REPO / 'shared/dsp/benchmarks/results/octave-signalsmith-models-candidate-20261009T194342Z' / source.relative_to(original_ss)
        assert sha(source) == record['sha256']
        assert sha(AUDIT / record['archivePath']) == record['sha256']
    tone_source = AUDIT / 'data/tone55-input.f32le'
    assert sha(tone_source) == sha(RB / 'data/signalsmith-reference/input-55Hz.f32le')
    report['inputPairing'] = {'exact55HzInputBytesMatch': True, 'inputSha256': sha(tone_source),
                            'auditSelfComparisonWasTautological': True,
                            'rootVerifiedActualRubberBandInputInstead': True}

    rows = [json.loads(s) for s in (RB / 'results/results.jsonl').read_text(encoding='utf-8').splitlines() if s.strip()]
    by_id = {r['id']: r for r in rows}
    assert len(rows) == len(by_id) == 72
    calls = defaultdict(list)
    with (RB / 'results/callback-timing.csv').open(encoding='utf-8', newline='') as f:
        for c in csv.DictReader(f):
            for key in ('callbackIndex', 'inputFrames', 'elapsedNs', 'budgetNs', 'cppNewCalls', 'cppDeleteCalls', 'finalInput'):
                c[key] = int(c[key])
            calls[c['runId']].append(c)
    assert set(calls) == set(by_id)
    recomputed = {}
    for run_id, cs in calls.items():
        raw = by_id[run_id]
        assert [c['callbackIndex'] for c in cs] == list(range(len(cs))), run_id
        assert sum(c['finalInput'] for c in cs) == 1 and cs[-1]['finalInput'] == 1, run_id
        times = [c['elapsedNs'] for c in cs]
        stats = {'callbackCount': len(cs), 'p50Ns': percentile(times, .5), 'p99Ns': percentile(times, .99),
                 'p999Ns': percentile(times, .999), 'maxNs': max(times),
                 **{f'over{p}': sum(c['elapsedNs'] > c['budgetNs'] * p // 100 for c in cs) for p in (60, 80, 100)}}
        assert stats == manifest['independentlyRecomputedTiming'][run_id], run_id
        pairs = [('callbackCount', 'callbackCount'), ('p50Ns', 'callbackP50Ns'), ('p99Ns', 'callbackP99Ns'),
                 ('p999Ns', 'callbackP999Ns'), ('maxNs', 'callbackMaxNs'), ('over60', 'over60PercentBudget'),
                 ('over80', 'over80PercentBudget'), ('over100', 'over100PercentBudget')]
        for a, b in pairs:
            assert stats[a] == raw[b], (run_id, a)
        assert sum(c['cppNewCalls'] for c in cs) == raw['cppNewCallsInCallbacks'] == 0
        assert sum(c['cppDeleteCalls'] for c in cs) == raw['cppDeleteCallsInCallbacks'] == 0
        out = pcm(RB / 'results' / (run_id + '-raw.f32le'))
        assert len(out) == raw['rawOutputFrames'] and raw['nonFiniteSamples'] == 0
        recomputed[run_id] = {**stats, 'engine': raw['engine'], 'blockFrames': raw['blockFrames'],
                             'pitchScale': raw['pitchScale'], 'scene': raw['scene']}
    report['timing'] = {'totalCallbacks': sum(len(cs) for cs in calls.values()), 'all72RunsRecomputed': True,
        'percentilePolicy': 'nearest rank ceil(p*N)-1; startup and final callbacks retained',
        'qualification': 'Loaded-run microbenchmark only; overlapping builds reported, process load metadata absent',
        'allocationScope': 'Calling-thread C++ new/delete only; malloc/OS heap/locks not intercepted',
        'perRun': recomputed, 'perEngineBlockRanges': []}
    for engine in ('R2', 'R3'):
        for block in (64, 128, 256):
            group = [r for r in recomputed.values() if r['engine'] == engine and r['blockFrames'] == block]
            report['timing']['perEngineBlockRanges'].append({'engine': engine, 'blockFrames': block,
                'deadlineMs': block / 48, 'runCount': len(group),
                **{name: [min(r[key] for r in group) / 1e6, max(r[key] for r in group) / 1e6]
                   for name, key in [('p99MsRange', 'p99Ns'), ('p999MsRange', 'p999Ns')]},
                'maxMs': max(r['maxNs'] for r in group) / 1e6,
                'over100Count': sum(r['over100'] for r in group)})

    metrics = readj(AUDIT / 'results/stable-tone-window-metrics.json')
    ss = pcm(AUDIT / 'data/signalsmith-tone55-mode-switch-output.f32le')
    broad_runs = []
    for group in ('signalsmith', 'rubberBand'):
        for r in metrics[group]['runs']:
            if group == 'signalsmith':
                signal = ss
                first, last = r['timelineWindowFrames']
                run_id = 'Signalsmith-' + r['mode']
            else:
                signal = pcm(AUDIT / 'data' / ('rubberband-' + r['runId'] + '-raw.f32le'))
                first, last = r['rawWindowFrames']
                run_id = r['runId']
            assert last-first == 48000 and last <= len(signal)
            channels = {}
            for ch, label in enumerate(('left', 'right')):
                original = r['channels'][label]['output']
                m = spectral_metric(signal[first:last, ch], original['targetHz'])
                assert abs(m['rectangularExactTargetProjectionPeak'] - original['exactTargetProjection']['amplitudePeak']) < 2e-12
                prior = original['broadPeakNearTarget']
                m['priorBoundedSearchPeakHz'] = prior['frequencyHz']
                m['priorPeakAtSearchBoundary'] = bool(abs(abs(prior['frequencyHz']-original['targetHz'])-3) < 1e-9)
                channels[label] = m
            broad_runs.append({'runId': run_id, 'scale': r.get('scale', r.get('pitchScale')),
                               'analysisWindowFrames': [first, last], 'channels': channels})
    report['stableToneBroadSpectralAudit'] = {'runs': broad_runs,
        'method': 'One-second Hann window; DC removed; 524288 FFT; dominant component searched over 1..200 Hz; log-bin quadratic interpolation',
        'limitations': 'Spectral components and zero crossings do not prove perceived pitch or musical quality; zero padding does not increase window resolution',
        'priorSearchCorrection': 'The v2 broad label denotes only target +/-3 Hz; boundary hits are not unconstrained dominant-frequency estimates'}
    impulses = readj(AUDIT / 'results/corrected-impulse-timeline.json')
    for r in impulses['runs']:
        a = pcm(AUDIT / 'data' / ('rubberband-' + r['runId'] + '-raw.f32le'))
        lo, hi = r['analysisRawFrames']
        for ch, label in enumerate(('left', 'right')):
            original = r['channels'][label]
            peak = lo + int(np.argmax(np.abs(a[lo:hi, ch])))
            threshold = max(1e-7, .01 * float(abs(a[peak, ch])))
            onset = lo + int(np.flatnonzero(np.abs(a[lo:hi, ch]) >= threshold)[0])
            assert peak == original['rawPeakFrame'] and onset == original['rawFirstAboveThresholdFrame']
            assert peak-r['reportedStartDelayTrimFrames'] == original['postTrimPeakFrame'] == 9600
    report['impulseAudit'] = {'all6StereoImpulsesRecomputed': True,
        'r2ReportedStartDelaySamples': 1024, 'r3ReportedStartDelaySamples': 2048,
        'postTrimPeakOffsetFromOriginalEventSamples': 0,
        'physicalHardwareLatency': 'untested; offline protocol alignment is not a hardware measurement'}
    report['durationAndFinalization'] = readj(AUDIT / 'results/output-length-and-finalization.json')
    report['limitations'] = [
        'Original and additive archives remain immutable; original comparison mixed mode windows and falsely denied the quarter-octave segment',
        'V1 additive audit selected the wrong Signalsmith PCM and remains superseded',
        'No evaluator benchmark or hardware test was run by this review',
        'No full Native/Browser graph performance, exact final duration, musical-quality or realtime Gate is passed',
        'Rubber Band is isolated research material; no product source or binary adoption in this checkpoint']
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'report': str(OUT), 'sha256': sha(OUT), 'captures': report['captures'],
        'totalCallbacks': report['timing']['totalCallbacks'],
        'ranges': report['timing']['perEngineBlockRanges'],
        'signalsmithBroad': broad_runs[:2]}, indent=2))

if __name__ == '__main__':
    main()
