"""Reproduce single-logical-CPU device-free Native PAN performance comparisons on Windows."""
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

kernel = ctypes.WinDLL('kernel32', use_last_error=True)
size_t = ctypes.c_size_t
kernel.GetCurrentProcess.restype = wintypes.HANDLE
kernel.GetProcessAffinityMask.argtypes = [wintypes.HANDLE, ctypes.POINTER(size_t), ctypes.POINTER(size_t)]
kernel.GetProcessAffinityMask.restype = wintypes.BOOL
kernel.SetProcessAffinityMask.argtypes = [wintypes.HANDLE, size_t]
kernel.SetProcessAffinityMask.restype = wintypes.BOOL

def masks(handle):
    process_mask, system_mask = size_t(), size_t()
    if not kernel.GetProcessAffinityMask(handle, ctypes.byref(process_mask), ctypes.byref(system_mask)):
        raise ctypes.WinError(ctypes.get_last_error())
    return process_mask.value, system_mask.value

def child(exe, mask, args):
    if not kernel.SetProcessAffinityMask(kernel.GetCurrentProcess(), int(mask)):
        raise ctypes.WinError(ctypes.get_last_error())
    own, system = masks(kernel.GetCurrentProcess())
    if own != int(mask): raise RuntimeError(f'wrapper affinity mismatch: {own:#x}')
    p = subprocess.Popen([exe, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         creationflags=subprocess.CREATE_NO_WINDOW)
    actual, child_system = masks(wintypes.HANDLE(int(p._handle)))
    out, err = p.communicate()
    if p.returncode != 0: raise RuntimeError(f'exit={p.returncode}: {err} {out}')
    if actual != int(mask): raise RuntimeError(f'executable affinity mismatch: {actual:#x}')
    return {'affinityMask': hex(actual), 'systemMask': hex(child_system), 'result': json.loads(out)}

def main():
    if sys.argv[1] == '--child':
        print(json.dumps(child(sys.argv[2], sys.argv[3], sys.argv[4:])))
        return
    baseline, current, output = sys.argv[1:4]
    output = Path(output); output.mkdir(parents=True, exist_ok=True)
    allowed, system = masks(kernel.GetCurrentProcess())
    if not allowed: raise RuntimeError('no allowed logical CPU')
    mask = allowed & -allowed
    meta = {'allowedMask': hex(allowed), 'systemMask': hex(system), 'selectedMask': hex(mask),
            'priority': 'inherited normal', 'compiler': 'MSVC 2019 19.29.30159 x64 Release',
            'baselineExecutable': baseline, 'newExecutable': current,
            'baselineSha256': hashlib.sha256(Path(baseline).read_bytes()).hexdigest(),
            'newSha256': hashlib.sha256(Path(current).read_bytes()).hexdigest()}
    (output / 'metadata.json').write_text(json.dumps(meta, indent=2), encoding='utf-8')
    print(json.dumps(meta), flush=True)
    groups = [
        ('classic', 'ABBABAAB', ['48000','64','5','0','10000','playback','2','live-mono','none','mixed','default','preamp']),
        ('light', 'ABBA', ['48000','64','5','0','50000','playback','2','none','none','mixed','default','preamp']),
        ('dynamic-light', 'B', ['48000','64','5','0','10000','playback','2','none','pan','mixed','default','preamp']),
    ]
    for group, order, args in groups:
        for index, which in enumerate(order, 1):
            exe = baseline if which == 'A' else current
            started = time.time()
            p = subprocess.run([sys.executable, __file__, '--child', exe, str(mask), *args],
                               capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
            if p.returncode: raise RuntimeError(f'{group} {index} {which}: {p.stderr} {p.stdout}')
            record = json.loads(p.stdout); record.update(group=group, order=index, binary=which, elapsedSeconds=time.time()-started, args=args)
            (output / f'{group}-{index:02}-{which}.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
            print(json.dumps(record), flush=True)

if __name__ == '__main__': main()
