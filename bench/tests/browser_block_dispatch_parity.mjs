#!/usr/bin/env node
// Correctness-only active/bypass transition and buffer-shape gate.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const [a,b,out]=process.argv.slice(2);const sources=[a,b].map(p=>fs.readFileSync(p,'utf8'));const classes=sources.map(source=>{let P;vm.runInNewContext(source,{AudioWorkletProcessor:class{constructor(){this.port={onmessage:null,postMessage(){}}}},registerProcessor(n,p){P=p},sampleRate:48000,currentFrame:0});return P});let cases=0,blocks=0;
for(const algorithm of (process.env.ALGORITHMS?.split(',')??['reverb','gate-reverb','phaser','distortion','chorus','auto-pan','reverse-reverb','preamp']))for(const rate of [44100,48000])for(const shape of ['normal','mono','missing','partial','alias','cross','overlap','output-overlap']){
 const cores=classes.map(P=>new P({processorOptions:{algorithm,sampleRate:rate,bypassed:false}}).core);
 for(let step=0;step<48;step++){
  const n=[0,1,3,127,128,129][step%6];
  const results=cores.map(core=>{
   if(step===7||step===8||step===9)core.setParameters({distortionMode:['fuzz','hard-clip','overdrive'][step-7],driveDb:step*3,mix:0.13*step,decaySeconds:step,phaserDepth:step/10});
   if(step===11||step===12||step===20||step===30)core.setBypass(step!==12&&step!==30,step===20?0:137);
   if(step===25)core.reset();
   core.synchronizeFrame(step*128);
   let l=Float32Array.from({length:n},(_,i)=>step===5?(i%2===0?-0:0):i===0&&step===4?NaN:Math.sin(i+step)*0.2),r=Float32Array.from({length:n},(_,i)=>step===5?(i%2===0?0:-0):i===1&&step===4?Infinity:Math.cos(i-step)*0.3),ol=new Float32Array(n),or=new Float32Array(n);
   if(shape==='mono')r=null;if(shape==='missing'){l=null;r=null;}if(shape==='partial'){l=l.subarray(0,n>>1);or=or.subarray(0,n>>1);}if(shape==='alias'){ol=l;or=r;}if(shape==='cross'){ol=r;or=l;}if(shape==='overlap'||shape==='output-overlap'){const s=new Float32Array(n+1);s.set(l);l=s.subarray(0,n);ol=s.subarray(1,n+1);if(shape==='output-overlap')or=s.subarray(0,n);}
   core.processBlock(l,r,ol,or,n,r===null);
   return {pcm:[ol,or].map(x=>Buffer.from(x.buffer,x.byteOffset,x.byteLength).toString('hex')),state:['blocksProcessed','framesProcessed','currentAudioFrame','nonFiniteInputSamples','nonFiniteOutputSamples','fullyBypassed','phaserPhase','gateGain'].map(k=>core[k]),controls:Array.from(core.currentControls)};
  });
  for(let i=0;i<results[0].state.length;i++) assert.ok(Object.is(results[0].state[i],results[1].state[i]),'exceptional state identity');
  assert.deepEqual(results[0],results[1],`${algorithm}/${rate}/${shape}/${step}`);blocks++;
 }
 cases++;
}
const report={passed:true,cases,blocks,sourceHashes:sources.map(s=>createHash('sha256').update(s).digest('hex')),scope:'Exact output bytes, counters, frame clock and controls through interrupted ramps/mode changes/reset/nonfinite input and overlapping buffers; correctness only'};fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
