"""Serial Windows/MSVC-compatible callback timing, allocation, and core-lock probes."""
import argparse
import json
import platform
from datetime import datetime, timezone
from pathlib import Path
from engine_baseline import run_checked, verify_native_manifest
from parity_common import ensure_external_path, write_json


def run(manifest: Path, out: Path, callbacks: int) -> dict:
    out=ensure_external_path(out)
    build=verify_native_manifest(manifest)
    rows=[]
    for comparison,variant in (('gate-vs-meter-control','gate-meter'),('mark-vs-meter-control','mark-retained')):
        for leg,(label,scenario) in enumerate((('A','meter'),('B',variant),('B',variant),('A','meter')),1):
            started=datetime.now(timezone.utc).isoformat()
            row=run_checked([build['binary'],'perf',str(callbacks),scenario],timeout=300)
            row.update({'comparison':comparison,'leg':leg,'variant':label})
            row.update({'started_utc':started,'finished_utc':datetime.now(timezone.utc).isoformat()})
            row['p999BudgetPercent']=100*row['p999Ns']/row['budgetNs']
            row['maxBudgetPercent']=100*row['maxNs']/row['budgetNs']
            row['allocation_scope']='C++ operator new/new[] during measured callbacks and one lock probe; malloc/aligned allocation not intercepted'
            row['lock_proof_scope']='One completed callback with all three core-owned std::mutex held by another thread; any blocking acquisition would deadlock and hit process timeout. No global std::mutex interception.'
            row['hardwareXruns']=None
            rows.append(row)
            write_json(out.with_suffix('.partial.json'),{'status':'IN_PROGRESS','rows':rows})
    value={'status':'SOFTWARE_BASELINE','platform':platform.platform(),'native_binary_sha256':build['binary_sha256'],
        'rows':rows,'order':'ABBA per comparison','measured_callbacks':len(rows)*callbacks,
        'hardware_capture':False,'baseline_comparison':'Same integrated workload; control has production metering active and no gate toggle/retained MARK',
        'limitations':['Device-free callback timing only; no hardware XRUN or final regression claim.',
            'gate-meter queues one real gate change per measured callback; metering remains active.',
            'mark-retained creates a real committed-overdub MARK via public control APIs before measurement; MARK transaction latency is not measured.',
            'Metering has no production disable switch; a no-meter comparison is unavailable.',
            'No full malloc/aligned allocator or global lock interception; unavailable metrics remain null.']}
    write_json(out,value);return value


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native-manifest',required=True,type=Path)
    parser.add_argument('--out',required=True,type=Path)
    parser.add_argument('--callbacks',type=int,default=10000)
    args=parser.parse_args()
    if not 10000<=args.callbacks<=1000000:parser.error('callbacks must be 10000..1000000 for P99.9 resolution')
    print(json.dumps(run(args.native_manifest,args.out,args.callbacks),indent=2))
