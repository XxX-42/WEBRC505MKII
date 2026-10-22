/** Production core signal/parameter sanity gates; deliberately not hardware/subjective quality acceptance. */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { getBrowserTrackFxControls } from '../src/composables/browserTrackFxParameters';
import { BROWSER_PER_TRACK_PARAMETER_KEYS } from '../src/audio/BrowserTrackFxChain';
import { FX_CATALOG } from '../src/audio/fx/catalog';
import { BrowserWorkletFX, BROWSER_WORKLET_FX_TYPES, type BrowserWorkletFxName } from '../src/audio/fx/BrowserWorkletFX';
import { BrowserFxDspCore, BROWSER_FX_ALGORITHM_INFO, type BrowserFxParameters } from '../src/audio/fx/dsp/BrowserFxDspCore';

const output = resolve(process.argv[2] ?? 'docs/performance/20261021/fx-sanity.json');
const signals = process.env.FX_SANITY_SIGNALS?.split(',') ?? ['silence', 'impulse', 'sine', 'left-only', 'right-only', 'stereo-asymmetric'];
const durationSeconds = Number(process.env.FX_SANITY_SECONDS ?? 0.25);
if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 30) throw new Error('FX_SANITY_SECONDS must be (0,30]');
const rates = (process.env.FX_SANITY_RATES?.split(',') ?? ['44100','48000']).map(Number);
const modes = process.env.FX_SANITY_MODES?.split(',') ?? ['default','minimum','maximum'];
const nameFor = (name: string) => ({LPF:'DSP LPF', BPF:'DSP BPF', HPF:'DSP HPF', REVERB:'FDN8 REVERB'}[name] ?? name) as BrowserWorkletFxName;
const catalog = FX_CATALOG.filter(x => !process.env.FX_SANITY_EFFECTS || process.env.FX_SANITY_EFFECTS.split(',').includes(x.id)); // Include experimental core routes; report non-core routes explicitly.
if (process.env.FX_SANITY_EFFECTS) {
  const missing = process.env.FX_SANITY_EFFECTS.split(',').filter(id => !catalog.some(effect => effect.id === id));
  if (missing.length) throw new Error(`Unknown requested catalog effects: ${missing.join(', ')}`);
}
const records: any[] = [];
const excluded: string[] = [];
const workletPath = process.env.FX_SANITY_WORKLET;
let Processor: any;
const bundledSource = workletPath ? readFileSync(workletPath, 'utf8') : null;
if (bundledSource) vm.runInNewContext(bundledSource, { AudioWorkletProcessor: class { port = {onmessage:null,postMessage(){}}; }, registerProcessor(_name: string, value: any) { Processor = value; }, sampleRate:48000, currentFrame:0 });
const makeCore = (algorithm: any, rate: number, params: BrowserFxParameters) => Processor ? new Processor({processorOptions:{algorithm,sampleRate:rate,parameters:params,bypassed:false}}).core : new BrowserFxDspCore(algorithm,rate,params);
// Exactly the production UI adapter, then the production facade-to-core mapper.
function parameters(effect: typeof catalog[number], mode: string) {
  const algorithm = BROWSER_WORKLET_FX_TYPES[nameFor(effect.displayName)];
  const facade = Object.create(BrowserWorkletFX.prototype) as BrowserWorkletFX;
  Object.assign(facade, {algorithm, parameters:{}, node:null, error:'', bypassed:true});
  const controls = getBrowserTrackFxControls(nameFor(effect.displayName));
  const admitted = BROWSER_PER_TRACK_PARAMETER_KEYS[algorithm] ?? [];
  for (const control of controls) {
    if (!admitted.includes(control.key)) throw new Error(`UI parameter not admitted: ${effect.id}/${control.key}`);
    facade.setParam(control.key, mode === 'minimum' ? control.min : mode === 'maximum' ? control.max : control.defaultValue);
  }
  const exposedLabels = new Set(controls.map(c => c.label));
  return {values:facade.getParameterSnapshot() as BrowserFxParameters, rejected:facade.error, controls, unsupportedCatalogParameters:effect.parameters.filter(p=>!exposedLabels.has(p.label)).map(p=>p.key), coverage:controls.length ? 'production UI-mapped canonical extrema/defaults' : 'core defaults only; no mapped UI parameter coverage'};
}
function stats(l: Float32Array, r: Float32Array) {
  let peak=0,sumL=0,sumR=0,ll=0,rr=0,lr=0,nonFinite=0,delta=0;
  for (let i=0;i<l.length;i++) {const a=l[i]!,b=r[i]!; if (!Number.isFinite(a)||!Number.isFinite(b)){nonFinite++;continue;}
    peak=Math.max(peak,Math.abs(a),Math.abs(b));sumL+=a;sumR+=b;ll+=a*a;rr+=b*b;lr+=a*b;
    if(i)delta=Math.max(delta,Math.abs(a-l[i-1]!),Math.abs(b-r[i-1]!));}
  return {peak, rmsL:Math.sqrt(ll/l.length),rmsR:Math.sqrt(rr/l.length),dcL:sumL/l.length,dcR:sumR/l.length,correlation:ll&&rr?lr/Math.sqrt(ll*rr):null,nonFinite,maxAdjacentDelta:delta};
}
for (const effect of catalog) {
  const algorithm=BROWSER_WORKLET_FX_TYPES[nameFor(effect.displayName)];
  if (!algorithm){excluded.push(effect.id);continue;}
  for(const rate of rates) for(const mode of modes) for(const signal of signals) {
    const params=parameters(effect,mode), n=Math.floor(rate*durationSeconds), l=new Float32Array(n),r=new Float32Array(n),ol=new Float32Array(n),or=new Float32Array(n);
    for(let i=0;i<n;i++) {const a=.25*Math.sin(2*Math.PI*997*i/rate),b=.2*Math.sin(2*Math.PI*401*i/rate);
      if(signal==='impulse'){l[i]=i===0?.5:0;r[i]=i===0?-.25:0;}
      else if(signal!=='silence'){l[i]=signal==='right-only'?0:a;r[i]=signal==='left-only'?0:signal==='sine'?a:b;}}
    const freezeCapture = algorithm === 'freeze' && params.values.freezeEnabled === 1;
    const core=makeCore(algorithm,rate,freezeCapture ? {...params.values,freezeEnabled:0} : params.values); core.setBypass(false,0);
    if (algorithm === 'osc-voc') core.scheduleMidiNoteOn(params.values.oscVocMidiChannel ?? 1,60,100,0);
    if (freezeCapture) {
      const warmL = l.subarray(0,Math.min(128,n)), warmR = r.subarray(0,Math.min(128,n));
      const wl = new Float32Array(warmL.length), wr = new Float32Array(warmL.length);
      for(let i=0;i<Math.ceil(rate*(params.values.freezeCaptureLengthMs??100)/1000);i+=warmL.length) core.processBlock(warmL,warmR,wl,wr,warmL.length);
      core.setParameters(params.values);
    }
    for(let i=0;i<n;i+=128){const end=Math.min(i+128,n);core.processBlock(l.subarray(i,end),r.subarray(i,end),ol.subarray(i,end),or.subarray(i,end),end-i);}
    const metrics=stats(ol,or),bypass=makeCore(algorithm,rate,params.values);bypass.setBypass(true,0);
    const bl=new Float32Array(128),br=new Float32Array(128);bypass.processBlock(l.subarray(0,128),r.subarray(0,128),bl,br,128);
    let bypassMaxError=0;for(let i=0;i<128;i++)bypassMaxError=Math.max(bypassMaxError,Math.abs(bl[i]!-l[i]!),Math.abs(br[i]!-r[i]!));
    records.push({effect:effect.id,algorithm,rate,mode,signal,durationSeconds,activePathSetup:algorithm==='osc-voc'?'MIDI note 60 velocity 100 scheduled at frame 0':freezeCapture?'history prefilled before freeze capture':'immediate activation; long-delay tails may exceed short window',parameters:params.values,parameterCoverage:params.coverage,unsupportedCatalogParameters:params.unsupportedCatalogParameters,rejectedParameter:params.rejected||null,...metrics,coreNonFiniteInputSamples:core.nonFiniteInputSamples,coreNonFiniteOutputSamples:core.nonFiniteOutputSamples,bypassMaxError,declaredAlgorithmicLatencySamples:BROWSER_FX_ALGORITHM_INFO[algorithm].algorithmicLatencySamples,sha256:createHash('sha256').update(Buffer.from(ol.buffer)).update(Buffer.from(or.buffer)).digest('hex')});
  }
  console.log(JSON.stringify({completedEffect:effect.id,casesSoFar:records.length}));
}
const failures=records.filter(r=>r.nonFinite>0||r.coreNonFiniteInputSamples>0||r.coreNonFiniteOutputSamples>0||r.bypassMaxError>1e-7||r.rejectedParameter!==null||typeof r.coreNonFiniteInputSamples!=='number'||typeof r.coreNonFiniteOutputSamples!=='number');
const key = (r: any) => `${r.effect}/${r.rate}/${r.mode}/${r.signal}/${r.durationSeconds ?? 0.25}s`;
const baselinePath = resolve(process.env.FX_SANITY_BASELINE ?? 'docs/performance/20261021/fx-sanity-corrected-baseline.json');
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
const prior = new Map((baseline?.records ?? []).map((r: any) => [key(r), r]));
const compared = records.filter(r => prior.has(key(r)));
const changedPcm = compared.filter(r => (prior.get(key(r)) as any).sha256 !== r.sha256).map(r => key(r));
const diagnostics = records.filter(r => r.peak > 1 || Math.abs(r.dcL) > 0.02 || Math.abs(r.dcR) > 0.02).map(r => ({case:key(r), peak:r.peak,dcL:r.dcL,dcR:r.dcR,baselinePcmUnchanged:prior.has(key(r)) ? (prior.get(key(r)) as any).sha256===r.sha256 : null}));
const report={createdAt:new Date().toISOString(),durationSeconds,parameterMapping:'getBrowserTrackFxControls → admitted canonical keys → BrowserWorkletFX.setParam snapshot',source:workletPath??'current TypeScript core',sourceSha256:bundledSource?createHash('sha256').update(bundledSource).digest('hex'):null,status:failures.length?'FAIL':'PASS_SOFTWARE_FINITE_AND_BYPASS_ONLY',effects:new Set(records.map(x=>x.effect)).size,cases:records.length,excluded,failures,baselineComparison:{compared:compared.length,changedPcm},diagnosticThresholds:{peakAbove:1,absoluteShortWindowDcAbove:0.02,meaning:'Review flags, not product quality thresholds: nonlinear/gain FX can intentionally exceed full scale internally; 0.25s DC estimates include startup transients.'},diagnostics,records,limits:['All mapped catalog core routes, including experimental routes; excluded non-core routes require their separate runtime acceptance.', 'Per-case duration is recorded; short windows are initialization sanity, not long feedback-tail stability proof.','Cross-channel effect output is diagnostic: stereo reverb/pan/vocoder legitimately crossfeed; track isolation is separately tested.','Catalog extreme mappings are recorded; rejected unsupported modes are explicitly listed, not counted as supported.','Peak/DC/correlation/delta are measurements, not universal acceptance thresholds or subjective/Roland fidelity.','Node-hosted bundled/core DSP, not browser callback or hardware performance; latency is declared metadata, not measured latency.']};
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
writeFileSync(output.replace(/\.json$/,'.md'),`# FX signal sanity\n\n${report.status}: ${report.effects} effects, ${records.length} cases, ${failures.length} finite/bypass failures. ${diagnostics.length} peak/DC diagnostic flags require review; this is NOT a complete quality PASS. ${compared.length} baseline-comparable cases, ${changedPcm.length} changed PCM hashes.\n\nSignals: ${signals.join(', ')}. Rates ${rates.join(', ')} Hz; parameter modes ${modes.join(', ')}; ${durationSeconds} seconds per signal. Full measured parameters, rejection diagnostics, peak/RMS/DC/correlation/transient deltas and PCM hashes are in JSON.\n\n${report.limits.map(x=>'- '+x).join('\n')}\n`);
console.log(JSON.stringify({status:report.status,effects:report.effects,cases:records.length,failures:failures.length,excluded})); if(failures.length)process.exitCode=1;
