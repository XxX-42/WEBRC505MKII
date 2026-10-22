import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const [a,b,out]=process.argv.slice(2);
const sources=[a,b].map(p=>fs.readFileSync(p,'utf8'));
const cases=[];
for(const algorithm of ['tremolo','auto-pan']) for(const rate of [44100,48000]) for(const channels of [1,2]) for(const mode of ['sine','triangle','square']) {
 const key=algorithm==='tremolo'?'tremoloWaveform':'autoPanWaveform';
 const states=sources.map(source=>{let P;const g={sampleRate:rate,currentFrame:0,AudioWorkletProcessor:class {constructor(){this.port={onmessage:null,postMessage(){}}}},registerProcessor(n,p){P=p}};vm.runInNewContext(source,g);return {g,p:new P({processorOptions:{algorithm,sampleRate:rate,parameters:{mix:1,[key]:mode}}}),h:crypto.createHash('sha256'),out:[Array.from({length:channels},()=>new Float32Array(128))]}});
 const input=[Array.from({length:channels},()=>new Float32Array(128))];let maxDiff=0,finite=true;
 const blocks=process.env.BLOCKS ? Number(process.env.BLOCKS) : 384;
 for(let block=0;block<blocks;block++) {
  for(let ch=0;ch<channels;ch++)for(let i=0;i<128;i++){const frame=block*128+i; input[0][ch][i]=(frame%rate<rate*0.2?0.8:0)*Math.sin((frame*(ch?997:311)/rate)*Math.PI*2);}
  for(const s of states){s.g.currentFrame=block*128;if(block===50)s.p.port.onmessage({data:{type:'configure',parameters:{[key]:'square'}}});if(block===150)s.p.port.onmessage({data:{type:'configure',parameters:{[key]:'triangle'}}});if(block===210)s.p.port.onmessage({data:{type:'set-bypass',value:true,rampFrames:137}});if(block===240)s.p.port.onmessage({data:{type:'set-bypass',value:false,rampFrames:91}});if(block===300)s.p.port.onmessage({data:{type:'reset'}});if(block===350)s.p.port.onmessage({data:{type:'configure',parameters:{[key]:'sine'}}});s.p.process(input,s.out);for(const x of s.out[0])s.h.update(new Uint8Array(x.buffer));}
  for(let ch=0;ch<channels;ch++)for(let i=0;i<128;i++){const av=states[0].out[0][ch][i],bv=states[1].out[0][ch][i];finite&&=Number.isFinite(av)&&Number.isFinite(bv);maxDiff=Math.max(maxDiff,Math.abs(av-bv));}
 }
 const hashes=states.map(s=>s.h.digest('hex'));cases.push({algorithm,rate,channels,mode,frames:blocks*128,finite,maxDiff,bitExact:hashes[0]===hashes[1],hashes});
}
const result={requestedBlocks:process.env.BLOCKS??null,generatedAt:new Date().toISOString(),scope:'Exact bundled worklet synchronous Node VM parity, not browser callback or hardware acceptance',sourceHashes:sources.map(s=>crypto.createHash('sha256').update(s).digest('hex')),cases,pass:cases.every(c=>c.finite&&c.bitExact)};fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({pass:result.pass,cases:cases.length}));if(!result.pass)process.exitCode=1;
