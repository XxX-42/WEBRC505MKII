#!/usr/bin/env python3
"""Source-derived interface coverage, not a hardware sound-equivalence claim."""
import csv,json,re,subprocess,argparse
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('--native-revision')
parser.add_argument('--browser-revision', help='Read Browser registry and its source imports from a frozen Git revision instead of a concurrent working tree.')
parser.add_argument('--native-schema', help='Sanitized schema emitted by the tested Native host, preferred over source regex.')
parser.add_argument('--output', help='Optional output path; defaults to the tracked coverage CSV.')
parser.add_argument('--browser-meter-verified',action='store_true')
parser.add_argument('--native-meter-verified',action='store_true')
args=parser.parse_args()
root=Path(__file__).resolve().parents[2]
read=lambda p:(root/p).read_text()
guide=json.loads(read('src/audio/fx/official/parameter-guide.json'))
cross=json.loads(read('docs/fx-official-20261022/current-crosswalk.json'))['effects']
# Execute the real merged registry instead of parsing source syntax. Indexed
# STEP LEVEL addresses count as one documented parameter row, not 16 claims.
registry_script = """
const esbuild = require('esbuild');
const Module = require('module');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const revision = REVISION_LITERAL;
const plugins = revision ? [{name:'frozen-browser-source', setup(build) {
  build.onLoad({filter:/.*/}, ({path:filename}) => {
    const relative = path.relative(process.cwd(), filename).split(path.sep).join('/');
    if (!relative.startsWith('src/')) return;
    return { contents: execFileSync('git', ['show', `${revision}:${relative}`], {encoding:'utf8'}),
      loader: path.extname(filename) === '.json' ? 'json' : 'ts', resolveDir: path.dirname(filename) };
  });
}}] : [];
(async () => {
const result = await esbuild.build({entryPoints:['src/audio/fx/official/browserBindings.ts'], bundle:true, platform:'node', format:'cjs', write:false, plugins});
const moduleInstance = new Module('official-coverage-registry');
moduleInstance._compile(result.outputFiles[0].text, 'official-coverage-registry.cjs');
process.stdout.write(JSON.stringify(moduleInstance.exports.BROWSER_OFFICIAL_PARAMETER_KEYS));
})().catch(error => { console.error(error); process.exitCode = 1; });
""".replace('REVISION_LITERAL', json.dumps(args.browser_revision))
registry=json.loads(subprocess.check_output(['node','-e',registry_script],cwd=root,text=True))
browser={algorithm:[re.sub(r'^step_level_\d+$','step_level',key.removeprefix('official_')) for key in keys] for algorithm,keys in registry.items()}
pitch={}
native=read('native-mvp/engine-cpp/src/native_fx_catalog.cpp') if not args.native_revision else subprocess.check_output(['git','show',args.native_revision+':native-mvp/engine-cpp/src/native_fx_catalog.cpp'],cwd=root,text=True)
ids=dict(re.findall(r'constexpr std::string_view (\w+)\{"([^"]+)"\}',native))
arrays={name:re.findall(r'"official_([\w]+)"',body) for name,body in re.findall(r'NativeEffectParameterDescriptor (kOfficial\w+)\[\] = \{(.*?)\n\};',native,re.S)}
function=native.split('const NativeEffectParameterDescriptor* nativeEffectOfficialParameters(',1)[-1].split('const NativeEffectParameterDescriptor* findNativeEffectOfficialParameter',1)[0]
nativekeys={}
for conditions,array in re.findall(r'if \((.*?)\) \{\s*count = std::size\((\w+)\)',function,re.S):
 for token in re.findall(r'id == (\w+)',conditions):nativekeys[ids.get(token,token)]=arrays.get(array,[])
native_descriptors={}
if args.native_schema:
 payload=json.loads(Path(args.native_schema).read_text())
 catalog=payload if isinstance(payload,list) else payload.get('nativeFx',payload).get('catalogEffectAvailability',[])
 if not catalog:raise ValueError('Native schema contains no catalogEffectAvailability')
 for item in catalog:
  native_descriptors[item['effectId']]=item.get('officialParameters',[])
  nativekeys[item['effectId']]=[re.sub(r'^step_level_\d+$','step_level',descriptor['id'].removeprefix('official_')) for descriptor in item.get('officialParameters',[])]
else:
 nativekeys={effect:[re.sub(r'^step_level_\d+$','step_level',key) for key in keys] for effect,keys in nativekeys.items()}
rows=[]
for effect in guide['effects']:
 family=next((item for item in cross if item['official']['name']==effect['name'] or effect['name'] in item['official'].get('variants',[])),None)
 if not family:
  family=next((item for item in cross if effect['name'].startswith(item['official']['name'].replace(' 1, 2',''))),None)
 current=family['current'] if family else {}
 cid=current.get('id','')
 alg={'dist':'distortion','hrm-auto-m':'hrm-auto','osc-voc-m':'osc-voc'}.get(cid,cid)
 nid=(current.get('native') or {}).get('id','')
 if effect['name']=='BEAT SHIFT' and 'beat_shift' in native_descriptors:nid='beat_shift'
 for parameter in effect['parameters']:
  key=parameter['key']; b='functional_clean_room' if key in browser.get(alg,[]) else 'functional_clean_room' if key in pitch.get(alg,[]) else 'unsupported'
  n='functional_clean_room' if key in nativekeys.get(nid,[]) else 'unsupported'
  reason=''
  descriptor=None
  if args.native_schema:
   variant_match=re.search(r'([12])$',effect['name'])
   variant=int(variant_match.group(1)) if variant_match else None
   descriptor=next((item for item in native_descriptors.get(nid,[]) if re.sub(r'^official_step_level_\d+$','official_step_level',item['id'])=='official_'+key and (not item.get('applicableVariants') or variant in item['applicableVariants'])),None)
   n='functional_clean_room' if descriptor else 'unsupported'
   if descriptor and descriptor.get('semanticSupport') in ['partial_live_stream','partial_source_modes']:
    n=descriptor['semanticSupport'];reason='Native: '+descriptor.get('limitation','Partially supported source modes; see validation evidence.')
  if effect['name'] in ['BEAT SHIFT','VINYL FLICK'] and b=='functional_clean_room':
   b='partial_source_modes';reason=(reason+' ' if reason else '')+'Browser: shared Track A source-aware loop playback; reverse/live pitch/overdub modes remain unsupported.'
  if effect['name']=='VOCODER' and key=='carrier' and b=='functional_clean_room':
   b='partial_source_modes';reason=(reason+' ' if reason else '')+'Browser: TRACK1–5 playback-only sources are routed; the six physical MIC/INST sources are unmapped and CARRIER THRU is unavailable.'
  if 'MEAS' in parameter['values_raw']:
   if b=='functional_clean_room' and not args.browser_meter_verified:b='functional_partial_meter'
   if n=='functional_clean_room' and not args.native_meter_verified:n='functional_partial_meter'
   reason='MEAS meter propagation is verified only on backends marked functional_clean_room; partial_meter retains the prior 4/4-only limitation.'
  if b=='unsupported' and n=='unsupported':reason='Not exposed as an operational official control; legacy extension is not equivalent.'
  if effect['name']=='VINYL FLICK' and n=='functional_clean_room' and not args.native_schema:
   n='partial_live_stream';reason=(reason+' ' if reason else '')+'Native: bounded live-history playback with crossfaded wrap; not source-aware track transport or sustained future audio.'
  if key=='mode':reason='Manufacturer MODE algorithms undocumented; not aliased to an unrelated control.'
  if effect['name']=='VOCODER' and key.startswith('carrier') and b=='unsupported' and n=='unsupported':reason='Needs independently routed carrier audio; internal oscillator is not equivalent.'
  if effect['name']=='AUTO RIFF' and key=='phrase':reason='P1–P30 phrase contents undocumented; authored riffs are not official presets.'
  if effect['name']=='PATTERN SLICER' and key=='pattern':reason='P01–P20 factory pattern contents undocumented; authored gate is not the factory pattern bank.'
  if effect['name']=='BEAT SCATTER' and key=='type':reason='P1–P4 factory scatter transforms undocumented; a selector without verified transforms is not exposed.'
  rows.append({'effect':effect['name'],'parameter':parameter['name'],'key':'official_'+key,'manual_page':effect['page'],'domain':parameter['values_raw'],'domain_completeness':'documented_note_endpoints_only' if parameter.get('tempo_range') or parameter.get('tempo_sync',{}).get('complete_intermediate_enum_documented') is False else 'documented_domain','documented_default':parameter['default'],'browser':b,'native':n,'hardware_sound_parity':'unverified','note':reason})
out=Path(args.output) if args.output else root/'docs/fx-official-20261022/parameter-coverage.csv'
with out.open('w') as f:
 w=csv.DictWriter(f,fieldnames=list(rows[0]),lineterminator='\n');w.writeheader();w.writerows(rows)
print(f'{len(rows)} source parameter rows written; unsupported and pending rows are not completion.')
