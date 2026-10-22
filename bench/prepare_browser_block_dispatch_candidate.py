#!/usr/bin/env python3
"""Prepare an isolated mechanical block specialization. Never edits production."""
from pathlib import Path
import re, shutil, subprocess, difflib, json, hashlib
root=Path(__file__).resolve().parents[1]
out=Path('/tmp/rc505-browser-perf/block-dispatch');out.mkdir(parents=True,exist_ok=True)
shutil.copytree(root/'src',out/'src',dirs_exist_ok=True)
p=root/'src/audio/fx/dsp/BrowserFxDspCore.ts';base=p.read_text()
start=base.index('  processBlock(\n');end=base.index('\n  reset(): void {',start)
method=base[start:end]; signature=method[:method.index('    this.blocksProcessed')]
args='inputLeft, inputRight, outputLeft, outputRight, frameCount, inputIsMono'
algorithms={'reverb':'processReverb','gate-reverb':'processReverb','phaser':'processPhaser','distortion':'processDistortionSample'}
wrapper=signature+'    switch (this.algorithm) {\n'
clones=[]
for algorithm,dsp in algorithms.items():
 name='processBlock'+''.join(x.title() for x in algorithm.split('-'))
 wrapper+=f"      case '{algorithm}': return this.{name}({args});\n"
 clone=method.replace('  processBlock(',f'  private {name}(',1)
 clone=re.sub(r"this\.algorithm\s*(===|!==)\s*'([^']+)'",lambda m:str((algorithm==m[2])==(m[1]=='===')).lower(),clone)
 assert 'this.algorithm' not in clone
 clone=clone.replace('this.processEffectSample(',f'this.{dsp}(')
 clones.append(clone)
wrapper+=f'      default: return this.processBlockGeneric({args});\n    }}\n  }}\n\n'
new=base[:start]+wrapper+method.replace('  processBlock(','  private processBlockGeneric(',1)+'\n\n'+'\n\n'.join(clones)+base[end:]
(out/'src/audio/fx/dsp/BrowserFxDspCore.ts').write_text(new)
evidence=root/'docs/performance/20261021'
(evidence/'browser-block-dispatch-candidate.patch').write_text(''.join(difflib.unified_diff(base.splitlines(True),new.splitlines(True),fromfile='a/src/audio/fx/dsp/BrowserFxDspCore.ts',tofile='b/src/audio/fx/dsp/BrowserFxDspCore.ts')))
subprocess.run([str(root/'node_modules/.bin/esbuild'),str(out/'src/audio/worklet/FxProcessor.ts'),'--bundle','--format=iife','--target=es2022',f'--outfile={out}/candidate.js'],check=True)
json.dump({'baseSourceHash':hashlib.sha256(base.encode()).hexdigest(),'candidateSourceHash':hashlib.sha256(new.encode()).hexdigest(),'candidateBundleHash':hashlib.sha256((out/'candidate.js').read_bytes()).hexdigest(),'specializedAlgorithms':list(algorithms),'sourceLinesAdded':len(new.splitlines())-len(base.splitlines()),'risk':'Mechanically duplicates block body; maintenance/code-size risk. Candidate only, not production.'},open(evidence/'browser-block-dispatch-candidate.json','w'),indent=2)
