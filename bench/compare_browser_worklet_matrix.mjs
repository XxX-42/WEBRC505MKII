#!/usr/bin/env node
// Exact-source OfflineAudioContext ABBA diagnostic, not device realtime acceptance.
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const [base, candidate, output] = process.argv.slice(2);
if (!output) throw Error('Usage: BASELINE.js CANDIDATE.js OUTPUT.json');
const sources = { baseline: await readFile(base), candidate: await readFile(candidate) };
const server = createServer((req, res) => {
  const key = req.url?.slice(1).replace('.js', '');
  res.setHeader('content-type', key in sources ? 'application/javascript' : 'text/html');
  res.end(sources[key] ?? '<!doctype html><title>Offline Worklet ABBA</title>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BROWSER ?? '/usr/bin/chromium', headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async ({seconds, rounds, matrix}) => {
    const scenarios = [];
    for (const rate of [44100, 48000]) for (const channels of [1,2]) for (const tracks of matrix ? [1,5] : [1]) for (const algorithm of matrix ? ['bypass','reverb','gate-reverb','reverse-reverb'] : ['reverb','gate-reverb']) {
      async function render(version, duration) {
        const frames = Math.floor(rate * duration), ctx = new OfflineAudioContext(channels, frames, rate);
        await ctx.audioWorklet.addModule(`/${version}.js`);
        for(let track=0;track<tracks;track++) {
          const buffer = ctx.createBuffer(channels,frames,rate);
          for(let ch=0;ch<channels;ch++) {const data=buffer.getChannelData(ch); for(let f=0;f<frames;f++) data[f] = (f < frames*0.7 ? 0.12*Math.sin(2*Math.PI*(233+track*71+ch*307)*f/rate)+(f%8192===0?0.4:0) : 0)/tracks;}
          const source=ctx.createBufferSource(); source.buffer=buffer;
          const fx=new AudioWorkletNode(ctx,'rc505-fx-processor',{outputChannelCount:[channels],channelCount:channels,channelCountMode:'explicit',processorOptions:{algorithm:algorithm==='bypass'?'reverb':algorithm,sampleRate:rate,bypassed:algorithm==='bypass',parameters:{decaySeconds:8,mix:0.7,dampingHz:9000}}});
          source.connect(fx); fx.connect(ctx.destination); source.start();
        }
        const start=performance.now(); const rendered=await ctx.startRendering(); const elapsedMs=performance.now()-start;
        let finite=true, energy=0, stereoDifference=0; const bytes=new Uint8Array(frames*channels*4);
        for(let ch=0;ch<channels;ch++){const data=rendered.getChannelData(ch); bytes.set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength),ch*frames*4); for(let f=0;f<frames;f++){finite&&=Number.isFinite(data[f]); energy+=data[f]*data[f]; if(ch===1) stereoDifference+=Math.abs(data[f]-rendered.getChannelData(0)[f]);}}
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), x=>x.toString(16).padStart(2,'0')).join('');
        return {version,elapsedMs,finite,rms:Math.sqrt(energy/(frames*channels)),stereoDifference,hash};
      }
      await render('baseline',0.3); await render('candidate',0.3);
      const runs=[];
      for(let round=0;round<rounds;round++) for(const version of ['baseline','candidate','candidate','baseline']) runs.push({round,...await render(version,seconds)});
      const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
      const baselineMs=median(runs.filter(r=>r.version==='baseline').map(r=>r.elapsedMs)), candidateMs=median(runs.filter(r=>r.version==='candidate').map(r=>r.elapsedMs));
      scenarios.push({rate,channels,tracks,algorithm,baselineMs,candidateMs,improvementPercent:100*(1-candidateMs/baselineMs),bitExact:runs.every(r=>r.hash===runs[0].hash),finite:runs.every(r=>r.finite),stereoPreserved:channels===1||runs.every(r=>r.stereoDifference>0),runs});
    }
    return {scenarios};
  }, {seconds:Number(process.env.SECONDS_PER_RENDER??2),rounds:Number(process.env.ROUNDS??3),matrix:process.env.MATRIX==='1'});
  await writeFile(output, JSON.stringify({generatedAt:new Date().toISOString(),browser:await browser.version(),sourceHashes:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')])),scope:'OfflineAudioContext wall render time, not callback deadline, XRUN, hardware, or full application acceptance. Track count is independent FX branches, not production loop tracks. Reverse uses reverse-reverb; KeepPitch covered separately by production harness.',...result},null,2)+'\n');
  console.log(JSON.stringify(result.scenarios.map(({runs,...s})=>s),null,2));
} finally {await browser?.close();await new Promise(r=>server.close(r));}
