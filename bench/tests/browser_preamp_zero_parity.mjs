#!/usr/bin/env node
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const [a,b,out]=process.argv.slice(2);const sources=[a,b].map(p=>fs.readFileSync(p,'utf8'));const classes=sources.map(source=>{let P;vm.runInNewContext(source,{AudioWorkletProcessor:class{constructor(){this.port={onmessage:null,postMessage(){}}}},registerProcessor(n,p){P=p},sampleRate:48000,currentFrame:0});return P});let samples=0;
for(const rate of [44100,48000])for(let model=0;model<5;model++){
 const dsps=classes.map(P=>new P({processorOptions:{algorithm:'preamp',sampleRate:rate,parameters:{preampModel:model,preampGainPercent:90},bypassed:false}}).core.preamp);
 for(let f=0;f<12000;f++){
  if(f===2000||f===7000)for(const d of dsps)d.setParameters({model:4-model,gainPercent:f===2000?100:0});
  if(f===6000)for(const d of dsps)d.reset();
  const silent=f<1500||(f>=4000&&f<8000),tiny=f>=8500&&f<9000;
  const l=silent?(f%2===0?0:-0):tiny?1e-14:f>10000?0:Math.sin(f*.17)*.3;
  const r=silent?(f%2===0?-0:0):tiny?-1e-14:f<10000?0:Math.cos(f*.13)*.2;
  for(const d of dsps)d.processSample(l,r);
  for(const key of ['outputLeft','outputRight'])assert.ok(Object.is(dsps[0][key],dsps[1][key]),`${rate}/${model}/${f}/${key}`);
  for(const key of ['previousDriven','antiderivativeValid','upsampleWriteIndex','waveshapedWriteIndex','cabinetWriteIndex'])assert.deepEqual(Array.from(dsps[0][key]),Array.from(dsps[1][key]),key);
  samples++;
 }
}
const d={passed:true,models:5,rates:[44100,48000],stereoFrames:samples,sourceHashes:sources.map(s=>createHash('sha256').update(s).digest('hex')),scope:'Object.is double-precision PREAMP outputs and history indices/cache flags through positive/negative zero silence, model ramps, reset, tiny deltas, channel-swapped tone restoration'};fs.writeFileSync(out,JSON.stringify(d,null,2));console.log(JSON.stringify(d));
