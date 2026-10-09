import argparse, csv, hashlib, json, platform, shutil, sys
from datetime import datetime, timezone
from pathlib import Path
import numpy as np

RB_DEFAULT = Path(r"D:\Documents\Codes\2024_1_WebRC505MKII\research-input\rubberband-r2r3-independent-20261009T195900Z")
SS_DEFAULT = Path(r"D:\Documents\Codes\2024_1_WebRC505MKII\2025_WebRC505MKII_v2\shared\dsp\benchmarks\results\octave-signalsmith-models-candidate-20261009T194342Z")
FS = 48000
INPUT_EVENT = 9600
WINDOWS = {"half": (48000, 48000, 27.5, 34.375, .5),
           "quarter": (144000, 48000, 13.75, 17.1875, .25)}
EVENTS = [{"frame":0,"mode":"DownOneOctave"},{"frame":96037,"mode":"DownTwoOctaves"},{"frame":192037,"mode":"DualDownOctaves"}]

def sha(p):
    h=hashlib.sha256()
    with open(p,"rb") as f:
        for b in iter(lambda:f.read(1<<20),b""): h.update(b)
    return h.hexdigest()

def sumlist(p):
    d={}
    for line in Path(p).read_text(encoding="utf-8").splitlines():
        if line.strip():
            h,n=line.split(None,1); d[n.strip()]=h
    return d

def copycheck(src,dst,want=None):
    src,dst=Path(src),Path(dst)
    dst.parent.mkdir(parents=True,exist_ok=True)
    h=sha(src)
    if want and h!=want: raise RuntimeError(f"source hash mismatch: {src}")
    shutil.copyfile(src,dst)
    if sha(dst)!=h: raise RuntimeError(f"copy mismatch: {dst}")
    return {"source":str(src),"archivePath":dst.relative_to(OUT).as_posix(),"bytes":dst.stat().st_size,"sha256":h}

def pcm(p):
    a=np.fromfile(p,dtype="<f4")
    if a.size%2: raise RuntimeError("odd float count")
    return a.reshape(-1,2)

def proj(x,t0,hz):
    n=len(x); t=np.arange(t0,t0+n,dtype=np.float64)
    z=np.dot(x.astype(np.float64),np.exp(-2j*np.pi*hz*t/FS))
    return {"amplitudePeak":float(2*abs(z)/n),"phaseRadians":float(np.angle(z)),
            "real":float(z.real),"imag":float(z.imag)}

def broad(x,t0,hz):
    best=None; t=np.arange(t0,t0+len(x),dtype=np.float64); xx=x.astype(np.float64)
    for f in np.arange(hz-3,hz+3.125,.25):
        z=np.dot(xx,np.exp(-2j*np.pi*f*t/FS)); a=float(2*abs(z)/len(x))
        if best is None or a>best["amplitudePeak"]: best={"frequencyHz":float(f),"amplitudePeak":a}
    best.update({"searchRadiusHz":3.0,"stepHz":.25})
    return best

def crossings(x):
    x=x.astype(np.float64); pos=[]
    for i in range(len(x)-1):
        a,b=x[i],x[i+1]
        if a<=0<b: pos.append(i+(-a/(b-a)))
    if len(pos)<3: return {"frequencyHz":None,"positiveCrossingCount":len(pos)}
    per=np.diff(pos)
    return {"frequencyHz":float(FS/np.median(per)),"positiveCrossingCount":len(pos),
            "medianPeriodSamples":float(np.median(per)),"meanPeriodSamples":float(np.mean(per))}

def channel_metric(x,t0,source_hz,target_hz):
    return {"rms":float(np.sqrt(np.mean(x.astype(np.float64)**2))),
            "peakAbs":float(np.max(np.abs(x))),
            "targetHz":target_hz,
            "exactTargetProjection":proj(x,t0,target_hz),
            "sourceFundamentalProjection":proj(x,t0,source_hz),
            "broadPeakNearTarget":broad(x,t0,target_hz),
            "positiveCrossingFit":crossings(x)}

def dump(p,o): Path(p).parent.mkdir(parents=True,exist_ok=True); Path(p).write_text(json.dumps(o,indent=2)+"\n",encoding="utf-8")

def main():
    global OUT
    ap=argparse.ArgumentParser()
    ap.add_argument("--archive-root",required=True,type=Path)
    ap.add_argument("--rubberband-root",type=Path,default=RB_DEFAULT)
    ap.add_argument("--signalsmith-root",type=Path,default=SS_DEFAULT)
    a=ap.parse_args(); OUT=a.archive_root.resolve(); RB=a.rubberband_root.resolve(); SS=a.signalsmith_root.resolve()
    if (OUT/"SHA256SUMS.txt").exists(): raise SystemExit("sealed output exists; refusing overwrite")
    rs=sumlist(RB/"SHA256SUMS.txt"); sm=json.loads((SS/"manifest.json").read_text(encoding="utf-8"))
    sc={x["path"]:x for x in sm["sidecars"]}
    rows=[json.loads(x) for x in (RB/"results/results.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
    tones=[r for r in rows if r.get("scene")=="tone55" and r.get("engine") in ("R2","R3") and r.get("pitchScale") in (.5,.25)]
    impulses=[r for r in rows if r.get("sceneKind")=="stereo_impulse_identity_latency"]
    if len(tones)!=12 or len(impulses)!=6: raise RuntimeError("source run set incomplete")

    copied=[]
    copied.append(copycheck(SS/"data/octave-signalsmith-tone-55Hz-input.f32le",OUT/"data/tone55-input.f32le",
                            sc["data/octave-signalsmith-tone-55Hz-input.f32le"]["sha256"]))
    if sha(SS/"data/octave-signalsmith-tone-55Hz-input.f32le") != sha(SS/"data/octave-signalsmith-tone-55Hz-input.f32le"):
        raise RuntimeError("55 Hz input PCM differs between source archives")
    copied.append(copycheck(SS/"data/octave-signalsmith-tone-55Hz-output.f32le",
                            OUT/"data/signalsmith-tone55-mode-switch-output.f32le",
                            sc["data/octave-signalsmith-tone-55Hz-output.f32le"]["sha256"]))
    copied.append(copycheck(RB/"data/input-impulse-3s.f32le",OUT/"data/impulse-input-3s.f32le",
                            rs["data/input-impulse-3s.f32le"]))
    rawmap={}
    for r in tones+impulses:
        rel=f"results/{r['id']}-raw.f32le"; dest=OUT/f"data/rubberband-{r['id']}-raw.f32le"
        copied.append(copycheck(RB/rel,dest,rs[rel])); rawmap[r["id"]]=dest

    refs=[
      (RB/"eval-src/rubberband_r2r3_eval.cpp","references/rubberband_r2r3_eval.cpp"),
      (RB/"upstream-source/COPYING","references/rubberband-COPYING"),
      (RB/"upstream-source/rubberband/RubberBandStretcher.h","references/RubberBandStretcher.h"),
      (RB/"upstream-source/src/RubberBandStretcher.cpp","references/RubberBandStretcher.cpp"),
      (RB/"upstream-source/src/faster/R2Stretcher.cpp","references/R2Stretcher.cpp"),
      (RB/"upstream-source/src/faster/StretcherProcess.cpp","references/R2StretcherProcess.cpp"),
      (RB/"upstream-source/src/finer/R3Stretcher.cpp","references/R3Stretcher.cpp"),
      (SS/"source/shared/dsp/tests/octave_signalsmith_models_tests.cpp","references/octave_signalsmith_models_tests.cpp"),
      (SS/"source/shared/dsp/src/octave_signalsmith_models.cpp","references/octave_signalsmith_models.cpp"),
      (SS/"source/shared/dsp/include/webrc/dsp/octave_signalsmith_models.hpp","references/octave_signalsmith_models.hpp"),
      (RB/"manifest.json","references/rubberband-original-manifest.json"),
      (RB/"SHA256SUMS.txt","references/rubberband-original-SHA256SUMS.txt"),
      (SS/"manifest.json","references/signalsmith-original-manifest.json"),
      (SS/"SHA256SUMS.txt","references/signalsmith-original-SHA256SUMS.txt")]
    for s,d in refs: copied.append(copycheck(s,OUT/d))

    ti=pcm(OUT/"data/tone55-input.f32le"); so=pcm(OUT/"data/signalsmith-tone55-mode-switch-output.f32le")
    metrics={"schemaVersion":1,"sampleRate":FS,"input":{"frames":len(ti),"sha256":sha(OUT/"data/tone55-input.f32le"),
      "tonesHz":{"left":55.0,"right":68.75},"peakAmplitudes":{"left":.55,"right":.43},"rightPhaseRadians":.31},
      "stableWindows":{"half":[48000,96000],"quarter":[144000,192000]},
      "signalsmith":{"archiveManifestSha256":sha(SS/"manifest.json"),"outputFrames":len(so),"reportedFixedMixedPathSamples":8192,
        "modeEvents":EVENTS,"windowPolicy":"Use the archived source test/output-frame windows as stored. Adding 8192 to the quarter window moves it to 3.1707..4.1707 s and crosses the event at 192037; the requested stable window is [144000,192000).",
        "runs":[]},"rubberBand":{"archiveManifestSha256":sha(RB/"manifest.json"),
        "windowPolicy":"Map source frame t to raw output frame reportedStartDelay+t; analyze the same source-time interval.",
        "runs":[]}}
    for name,(first,n,lHz,rHz,scale) in WINDOWS.items():
        case={"scale":scale,"mode":"DownOneOctave" if scale==.5 else "DownTwoOctaves",
              "timelineWindowFrames":[first,first+n],"seconds":[first/FS,(first+n)/FS],
              "channels":{}}
        for ch,label,input_hz,target in ((0,"left",55.0,lHz),(1,"right",68.75,rHz)):
            case["channels"][label]={"input":channel_metric(ti[first:first+n,ch],first,input_hz,input_hz),
              "output":channel_metric(so[first:first+n,ch],first,input_hz,target),"expectedInputPhaseRadians":0 if ch==0 else .31}
        metrics["signalsmith"]["runs"].append(case)
    for r in sorted(tones,key=lambda q:(q["engine"],q["blockFrames"],-q["pitchScale"])):
        name="half" if r["pitchScale"]==.5 else "quarter"
        first,n,lHz,rHz,scale=WINDOWS[name]; delay=int(r["reportedStartDelay"]); raw=pcm(rawmap[r["id"]]); start=delay+first
        case={"runId":r["id"],"engine":r["engine"],"blockFrames":r["blockFrames"],"pitchScale":scale,
              "preferredStartPadFrames":r["preferredStartPad"],"reportedStartDelayTrimFrames":delay,
              "rawOutputFrames":len(raw),"postTrimOutputFrames":max(0,len(raw)-delay),
              "postTrimMinusInputFrames":max(0,len(raw)-delay)-int(r["inputFrames"]),
              "timelineWindowFrames":[first,first+n],"rawWindowFrames":[start,start+n],"channels":{}}
        for ch,label,input_hz,target in ((0,"left",55.0,lHz),(1,"right",68.75,rHz)):
            case["channels"][label]={"input":channel_metric(ti[first:first+n,ch],first,input_hz,input_hz),
              "output":channel_metric(raw[start:start+n,ch],first,input_hz,target),"expectedInputPhaseRadians":0 if ch==0 else .31}
        metrics["rubberBand"]["runs"].append(case)
    dump(OUT/"results/stable-tone-window-metrics.json",metrics)

    ii=pcm(OUT/"data/impulse-input-3s.f32le")
    input_frame=int(np.argmax(np.max(np.abs(ii),axis=1)))
    if input_frame!=INPUT_EVENT: raise RuntimeError(f"impulse at unexpected frame {input_frame}")
    im={"schemaVersion":1,"sampleRate":FS,"inputImpulseFrame":input_frame,
      "inputImpulseAmplitudes":[float(ii[input_frame,0]),float(ii[input_frame,1])],
      "thresholdMethod":"Per channel, first abs(sample)>=max(1e-7,0.01*channelPeak) in the original harness region [delay+event-8192,delay+event+8192); peak is max abs in that region.",
      "coordinates":{"paddedInputEvent":"preferredStartPad+inputImpulseFrame",
       "rawVsPaddedOffset":"rawIndex-(preferredStartPad+inputImpulseFrame)",
       "postTrimIndex":"rawIndex-reportedStartDelay",
       "postTrimReference":"original inputImpulseFrame",
       "oldNegativeOffset":"Subtracting both pad and delay from the raw peak double-counted alignment. It is a coordinate error, not negative physical latency."},"runs":[]}
    for r in sorted(impulses,key=lambda q:(q["engine"],q["blockFrames"])):
        raw=pcm(rawmap[r["id"]]); pad=int(r["preferredStartPad"]); delay=int(r["reportedStartDelay"])
        physical=pad+input_frame; lo=max(0,delay+input_frame-8192); hi=min(len(raw),delay+input_frame+8192); chm={}
        for ch,label in ((0,"left"),(1,"right")):
            x=raw[lo:hi,ch]; pi=int(np.argmax(np.abs(x))); peak=lo+pi; p=float(abs(x[pi])); th=max(1e-7,.01*p)
            aa=np.flatnonzero(np.abs(x)>=th); onset=lo+int(aa[0]) if len(aa) else None
            po=peak-delay; oo=onset-delay if onset is not None else None
            chm[label]={"threshold":th,"rawFirstAboveThresholdFrame":onset,"rawPeakFrame":peak,"rawPeakAbs":p,
              "paddedInputEventFrame":physical,"rawOnsetOffsetFromPaddedInput":onset-physical if onset is not None else None,
              "rawPeakOffsetFromPaddedInput":peak-physical,"postTrimOnsetFrame":oo,"postTrimPeakFrame":po,
              "postTrimOnsetOffsetFromOriginalInputEvent":oo-input_frame if oo is not None else None,
              "postTrimPeakOffsetFromOriginalInputEvent":po-input_frame}
        im["runs"].append({"runId":r["id"],"engine":r["engine"],"blockFrames":r["blockFrames"],
          "preferredStartPadFrames":pad,"reportedStartDelayTrimFrames":delay,"getLatencyAliasFrames":r.get("getLatencyAlias"),
          "rawOutputFrames":len(raw),"postTrimOutputFrames":max(0,len(raw)-delay),
          "analysisRawFrames":[lo,hi],"channels":chm,
          "oldHarnessFields":{k:r.get(k) for k in ("firstRawAboveThreshold","peakRawFrame","impulseOnsetOffsetAfterPad","impulsePeakOffsetAfterPadAndStartDelay")}})
    dump(OUT/"results/corrected-impulse-timeline.json",im)

    callbacks={}
    with (RB/"results/callback-timing.csv").open(newline="",encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if "tone55" in r["runId"] and r["finalInput"]=="1":
                callbacks[r["runId"]]={"callbackIndex":int(r["callbackIndex"]),"inputStartFrame":int(r["inputStartFrame"]),
                  "inputFrames":int(r["inputFrames"]),"outputFramesAfterFinalCallAndImmediateDrain":int(r["outputFramesAfter"]),
                  "elapsedNs":int(r["elapsedNs"]),"budgetNs":int(r["budgetNs"])}
    lengths={"schemaVersion":1,"timeRatioConfigured":1.0,
      "schedule":"prepend preferred zero pad; process positive-sized blocks and mark last padded input block final=true; after every process call repeatedly retrieve while available()>0; no extra zero-frame final process or injected silence.",
      "apiTrace":"Header documents final=true as the last input block and available()==-1 once processing is complete and all output is read. R3 enters Finished after final=true; R2 available() returns -1 when completion is known and no output remains. The captured harness does not separately save terminal available() (0 versus -1).",
      "qualification":"Observed lengths below describe this final-input/immediate-drain schedule only. timeRatio=1.0 does not prove exact final duration.",
      "timingContext":{"runStartedUtc":"2026-10-09T19:57:14.5945827Z","runEndedUtc":"2026-10-09T19:59:37.0579373Z",
        "processLoadCaptured":False,"parentReportedConcurrentNativeAndWasmBuilds":True,
        "disposition":"Keep previous raw timing, maxima, and overruns as loaded-run data; no fresh timing run in this archive."},"runs":[]}
    for r in sorted(tones,key=lambda q:(q["engine"],q["blockFrames"],-q["pitchScale"])):
        n=int(r["inputFrames"]); raw=int(r["rawOutputFrames"]); delay=int(r["reportedStartDelay"]); trimmed=max(0,raw-delay)
        lengths["runs"].append({"runId":r["id"],"engine":r["engine"],"blockFrames":r["blockFrames"],
          "pitchScale":r["pitchScale"],"timeRatio":1.0,"inputFrames":n,"preferredStartPadFrames":r["preferredStartPad"],
          "rawOutputFrames":raw,"reportedStartDelayTrimFrames":delay,"postTrimOutputFrames":trimmed,
          "postTrimMinusInputFrames":trimmed-n,"durationDeltaMilliseconds":(trimmed-n)*1000/FS,
          "finalInputCallback":callbacks.get(r["id"])})
    dump(OUT/"results/output-length-and-finalization.json",lengths)

    readme="""# Additive Rubber Band / Signalsmith measurement audit

This v2 additive archive leaves both original captures and the earlier additive v1 archive untouched. The v1 audit mistakenly selected the 55 Hz high-resolution probe output (SHA ad76507eb2a83ed4d248e7f210ad93962d37725273d7d3452d018ebf12254316) instead of the main event-changing tone output. This v2 uses the exact main tone-test output sidecar (SHA 7437411d4ed29cad3578abe611c0d05c40c0b7a8849a3152194d630128046a77), then analyzes the requested stable mode windows.

The Signalsmith 55 Hz output is one six-second stream with mode events at frames 96,037 and 192,037. Its stable 0.5x comparison is [48,000, 96,000), and the stable 0.25x comparison is [144,000, 192,000). The 0.25x segment is present in the existing sidecar. Those event-indexed source-test windows avoid crossing mode changes. Rubber Band's independent fixed-pitch outputs use the same original-time windows after each run's reported getStartDelay trim. Both channels are analyzed independently against their exact target frequency using complex projection, a 0.25 Hz broad search within plus/minus 3 Hz, and interpolated positive-going zero-crossings.

The Signalsmith model reports an 8,192-frame mixed-path delay. Adding those frames to the quarter-octave window would shift it to 3.1707..4.1707 seconds and cross the event at frame 192,037. This audit therefore uses the documented event-indexed source test/output-frame window for this mode-changing sidecar; future host-level latency alignment must keep that distinction explicit.

Impulse coordinates distinguish the original input event, preferred-pad plus event frame in the supplied stream, raw output index, and post-trim index (raw minus getStartDelay). The negative peak offset in the old JSON was caused by subtracting both pad and delay from an already raw-coordinate peak. The corrected output shows the peak at the padded input event and at the original event after trimming; it is not negative physical latency.

The Rubber Band duration data describes exactly one protocol: set timeRatio to 1.0, prepend getPreferredStartPad zero frames, send final=true on the last positive input block, and retrieve while available()>0. The harness sends no extra zero-frame process call and no additional silence. The API documents -1 as fully processed with all output retrieved, but the old harness did not persist the terminal return value. The post-trim frame differences are measured facts for that schedule, not a final-duration qualification.

The prior wall-clock timing arrays, maxima, and overruns remain unchanged. Contemporaneous process load was not captured; the parent reports Native/WASM builds overlapped the earlier run. This archive starts no timing benchmark. Future timing qualification needs an agreed quiet window and process/background metadata captured during the run.

Rubber Band 4.0.0 is GPL-2.0-or-later with a separate commercial license offered upstream. Its sources are copied only into this independent research archive, not product sources. Pinned Signalsmith components are MIT licensed. No hardware was accessed.

Files: data contains exact referenced PCM; references contains exact evaluator/test and API/core source files plus the original manifests/licenses; results contains the corrected metrics; SHA256SUMS.txt covers all other files. Run analysis.py with a fresh archive-root and the two source-root arguments to reproduce. The script refuses to overwrite a directory already containing SHA256SUMS.txt.
"""
    (OUT/"README.md").write_text(readme,encoding="utf-8")

    manifest={"schemaVersion":1,"artifact":"rubberband-r2r3-additive-stable-window-and-timeline-audit",
      "createdUtc":datetime.now(timezone.utc).isoformat(),"disposition":"additive correctness/quality audit; no timing rerun or qualification",
      "tooling":{"python":sys.version,"platform":platform.platform(),"numpy":np.__version__},
      "sourceArchives":{"rubberBand":{"path":str(RB),"manifestSha256":sha(RB/"manifest.json"),"sumsSha256":sha(RB/"SHA256SUMS.txt")},
        "signalsmith":{"path":str(SS),"manifestSha256":sha(SS/"manifest.json"),
          "declaredArchiveHash":"71422e4043de41ac0956fc3277259b368ea302ed93f190658a7b8c4f415d3485"}},
      "modeEvents":EVENTS,"stableWindows":{"half":[48000,96000],"quarter":[144000,192000],"sampleRate":FS},
      "verifiedCopies":copied,"results":["results/stable-tone-window-metrics.json","results/corrected-impulse-timeline.json","results/output-length-and-finalization.json"]}
    dump(OUT/"manifest.json",manifest)
    lines=[]
    for p in sorted(x for x in OUT.rglob("*") if x.is_file() and x.name!="SHA256SUMS.txt"):
        lines.append(f"{sha(p)}  {p.relative_to(OUT).as_posix()}")
    (OUT/"SHA256SUMS.txt").write_text("\n".join(lines)+"\n",encoding="utf-8")
    for line in (OUT/"SHA256SUMS.txt").read_text(encoding="utf-8").splitlines():
        h,rel=line.split(None,1)
        if sha(OUT/rel.strip())!=h: raise RuntimeError(f"archive checksum failure: {rel}")
    print(json.dumps({"archive":str(OUT),"files":len(lines),"toneRuns":len(metrics["rubberBand"]["runs"]),
      "signalsmithWindows":len(metrics["signalsmith"]["runs"]),"impulseRuns":len(im["runs"]),
      "durationRuns":len(lengths["runs"]),"signalsmithOutputSha256":sha(OUT/"data/signalsmith-tone55-mode-switch-output.f32le")},indent=2))

if __name__=="__main__": main()
