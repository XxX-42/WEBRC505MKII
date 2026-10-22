#!/usr/bin/env python3
"""Actual input/shared FX, rhythm and pitch routes in the device-free core."""
import datetime, hashlib, json, pathlib, subprocess, sys, os
binary, destination = sys.argv[1:3]
cpu = int(sys.argv[3]) if len(sys.argv)>3 else None
if cpu is not None and cpu not in os.sched_getaffinity(0): raise SystemExit('CPU not allowed')
rows = []
for rate in (44100, 48000):
    for mode in ('all-banks', 'live-mono', 'live-poly'):
        started = datetime.datetime.now(datetime.timezone.utc).isoformat()
        row = json.loads(subprocess.check_output([binary, str(rate), '64', '5', '1', '2000', 'playback', '2', mode], preexec_fn=(lambda: os.sched_setaffinity(0, {cpu})) if cpu is not None else None))
        row.update(runStartedUtc=started, runFinishedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   binarySha256=hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest(),
                   functionalGate='PASS', hardwareXruns=None, requestedChildCpu=cpu,
                   buildBindingVerified=False, declaredPreampSourceSha256=hashlib.sha256(pathlib.Path('native-mvp/engine-cpp/src/native_preamp_processor.cpp').read_bytes()).hexdigest(),
                   allocationScope='C++ operator new/new[] only',
                   performanceGate='PASS' if row['p99Ns'] < row['budgetNs']*.5 and row['maxNs'] < row['budgetNs']*.8 and not row['cpuBudgetExceedances'] else 'FAIL')
        rows.append(row)
        pathlib.Path(destination).write_text(json.dumps(rows, indent=2)+'\n')
        print(rate, mode, row['p50Ns'], row['performanceGate'], flush=True)
