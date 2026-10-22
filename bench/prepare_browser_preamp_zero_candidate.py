#!/usr/bin/env python3
"""Independent exact +0 transfer identity candidate, never edits production."""
from pathlib import Path
import shutil, subprocess, difflib
root=Path(__file__).resolve().parents[1];out=Path('/tmp/rc505-browser-perf/preamp-zero');out.mkdir(parents=True,exist_ok=True)
shutil.copytree(root/'src',out/'src',dirs_exist_ok=True)
p=root/'src/audio/fx/dsp/BrowserPreampDsp.ts';old=p.read_text();needle='        shaped = (Math.tanh(shape * (0.5 * (driven + previous) + bias)) - biasValue) / slopeAtZero;';assert old.count(needle)==1
new=old.replace(needle,'''        const midpoint = 0.5 * (driven + previous);
        // Only exact positive zero uses the identity. Preserve all histories,
        // invalidation and FIR/EQ/cabinet work, including on silence.
        shaped = Object.is(midpoint, 0) ? 0
          : (Math.tanh(shape * (midpoint + bias)) - biasValue) / slopeAtZero;''')
(out/'src/audio/fx/dsp/BrowserPreampDsp.ts').write_text(new)
(root/'docs/performance/20261021/browser-preamp-zero-candidate.patch').write_text(''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/src/audio/fx/dsp/BrowserPreampDsp.ts',tofile='b/src/audio/fx/dsp/BrowserPreampDsp.ts')))
subprocess.run([str(root/'node_modules/.bin/esbuild'),str(out/'src/audio/worklet/FxProcessor.ts'),'--bundle','--format=iife','--target=es2022',f'--outfile={out}/candidate.js'],check=True)
