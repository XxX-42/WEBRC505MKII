import { readFileSync, writeFileSync } from 'node:fs';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';

// Runs the shipped AudioWorklet's production DSP module, not a simulated gain.
// This does not exercise AudioContext scheduling, device I/O, or app export.
function render(inputPath: string, outputPath: string, rateText: string | number, mode = 'lpf') {
if (!inputPath || !outputPath || !['lpf', 'dry'].includes(mode)) throw new Error('input.f32 output.f32 sampleRate lpf|dry');
const rate = Number(rateText);
if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) throw new Error('Invalid sample rate');
const raw = readFileSync(inputPath);
if (raw.length % 8) throw new Error('Expected interleaved stereo Float32LE');
const frames = raw.length / 8;
const dsp = new BrowserFxDspCore('lpf', rate, {cutoffHz: 1200, filterResonancePercent: 15, mix: 1});
dsp.setBypass(mode === 'dry', 0);
const left = new Float32Array(128), right = new Float32Array(128);
const outLeft = new Float32Array(128), outRight = new Float32Array(128);
const output = Buffer.alloc(raw.length);
for (let start = 0; start < frames; start += 128) {
  const count = Math.min(128, frames - start);
  left.fill(0); right.fill(0);
  for (let f = 0; f < count; f++) { left[f] = raw.readFloatLE((start + f) * 8); right[f] = raw.readFloatLE((start + f) * 8 + 4); }
  dsp.processBlock(left, right, outLeft, outRight, count, false);
  for (let f = 0; f < count; f++) {
    if (!Number.isFinite(outLeft[f]) || !Number.isFinite(outRight[f])) throw new Error('Non-finite production DSP output');
    output.writeFloatLE(outLeft[f]!, (start + f) * 8); output.writeFloatLE(outRight[f]!, (start + f) * 8 + 4);
  }
}
writeFileSync(outputPath, output);
return {status:'SOFTWARE_BASELINE', renderer:'production-BrowserFxDspCore', mode, frames, sampleRate:rate,
  path:'src/audio/fx/dsp/BrowserFxDspCore.ts::processBlock', hardwareCapture:false, audioContextScheduling:false};
}
const args=process.argv.slice(2);
if(args[0]==='--batch') {
  const batch=JSON.parse(readFileSync(args[1]!, 'utf8')) as {entries:Array<{inputPath:string;outputPath:string;sampleRate:number;mode:string}>};
  const entries=batch.entries.map(entry=>render(entry.inputPath,entry.outputPath,entry.sampleRate,entry.mode));
  console.log(JSON.stringify({status:'SOFTWARE_BASELINE',entries,freshDspInstancePerStimulus:true}));
} else {
  console.log(JSON.stringify(render(args[0]!,args[1]!,args[2]!,args[3])));
}
