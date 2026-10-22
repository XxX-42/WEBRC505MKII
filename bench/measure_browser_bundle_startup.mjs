#!/usr/bin/env node
// Isolated startup/first-call diagnostic; not real AudioWorklet scheduling.
import fs from 'node:fs';import vm from 'node:vm';import {performance} from 'node:perf_hooks';import {createHash} from 'node:crypto';
const [a,b,out]=process.argv.slice(2);const sources={baseline:fs.readFileSync(a,'utf8'),candidate:fs.readFileSync(b,'utf8')};const runs=[];
for(let round=0;round<4;round++)for(const algorithm of ['reverb','phaser','distortion','lpf'])for(const version of ['baseline','candidate','candidate','baseline']){
 let P;const globals={AudioWorkletProcessor:class{constructor(){this.port={onmessage:null,postMessage(){}}}},registerProcessor(n,p){P=p},sampleRate:48000,currentFrame:0};
 const start=performance.now();vm.runInNewContext(sources[version],globals);const loaded=performance.now();const p=new P({processorOptions:{algorithm,sampleRate:48000,bypassed:false}});const constructed=performance.now();
 const input=[[Float32Array.from({length:128},(_,i)=>.2*Math.sin(i)),Float32Array.from({length:128},(_,i)=>.1*Math.cos(i))]],output=[[new Float32Array(128),new Float32Array(128)]];
 const firstStart=performance.now();p.process(input,output);const firstEnd=performance.now();for(let i=0;i<128;i++){globals.currentFrame+=128;p.process(input,output)}const warm=performance.now();
 runs.push({round,algorithm,version,loadMs:loaded-start,constructMs:constructed-loaded,firstQuantumMs:firstEnd-firstStart,warmup128QuantaMs:warm-firstEnd});
}
fs.writeFileSync(out,JSON.stringify({scope:'Node VM fresh-context bundle parse/evaluate, constructor and first/warmup calls. Not isolated V8 compilation/JIT attribution, browser load or real-time acceptance.',sourceHashes:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')])),bundleBytes:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,Buffer.byteLength(v)])),runs},null,2));
