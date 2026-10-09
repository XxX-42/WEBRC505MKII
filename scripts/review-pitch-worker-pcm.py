"""Recompute stereo Worker/C ABI/upstream metrics from raw Float32 sidecars."""
from pathlib import Path
import array, hashlib, json, math, sys

def review(root):
    root=Path(root); raw=root/'raw'; manifest=json.loads((raw/'worker-direct-comparison.json').read_bytes()); declared=json.loads((root/'upstream-chunked-comparison.json').read_bytes()); references={f['id']:f for f in declared['fixtures']}; rows=[]; hashes={}
    assert len(references)==len(declared['fixtures'])==6
    assert len({f['id'] for f in manifest['results']})==6
    def load(name):
        data=(raw/name).read_bytes(); assert len(data)%4==0 and len(data)>0,name
        hashes[name]=hashlib.sha256(data).hexdigest(); values=array.array('f'); values.frombytes(data)
        if sys.byteorder!='little': values.byteswap()
        assert all(math.isfinite(x) for x in values),name
        return data,values
    def error(a,b):
        assert len(a)==len(b) and len(a)>0
        return {'frames':len(a),'maxAbs':max(abs(float(x)-y) for x,y in zip(a,b)),'rms':math.sqrt(math.fsum((float(x)-y)**2 for x,y in zip(a,b))/len(a))}
    for f in manifest['results']:
        fid=f['id']; reference=references[fid]; start,end=f['outputCropStartFrame'],f['outputCropEndFrameExclusive']; metrics=[]
        assert 0<=start<end
        for channel,index in [('left',0),('right',1)]:
            input_bytes,source=load(f'{fid}.input.{channel}.f32le'); assert hashes[f'{fid}.input.{channel}.f32le']==f['inputSha256'][index]
            worker_bytes,worker=load(f'{fid}.worker.{channel}.f32le'); direct_bytes,direct=load(f'{fid}.direct-cabi.full.{channel}.f32le'); _,upstream=load(f'{fid}.upstream-chunked.full.{channel}.f32le'); _,exact=load(f'{fid}.upstream-exact.full.{channel}.f32le')
            assert end<=len(direct)==len(upstream)==len(exact)
            assert len(direct)==f['processOutputFrames']+f['flushOutputFrames']
            assert hashes[f'{fid}.direct-cabi.full.{channel}.f32le']==f['fullPaddedOutputSha256'][index]
            assert worker_bytes==direct_bytes[start*4:end*4],fid
            assert len(worker)==f['outputFrames'] and len(source)==f['inputFrames']
            assert hashes[f'{fid}.worker.{channel}.f32le']==f['workerOutputSha256'][index]
            assert hashes[f'{fid}.upstream-chunked.full.{channel}.f32le']==reference['chunkedUpstreamSha256'][index]
            chunk_error=error(worker,upstream[start:end]); exact_error=error(exact,upstream)
            expected=reference['chunkedUpstreamVsWorkerCrop'][index]
            assert math.isclose(chunk_error['maxAbs'],expected['maxAbs'],rel_tol=1e-12,abs_tol=1e-12)
            assert math.isclose(chunk_error['rms'],expected['rms'],rel_tol=1e-12,abs_tol=1e-12)
            count=min(256,len(worker)); tail=math.sqrt(math.fsum(float(x)*x for x in worker[-count:])/count)
            metrics.append({'channel':channel,'workerVsCAbiByteIdentical':True,'chunkedUpstreamVsWorker':chunk_error,'singleCallExactVsChunked':exact_error,'last256WorkerRms':tail})
        blocks=f['processBlocks']; in_cursor=f['seekInputFrames']; out_cursor=0
        for block in blocks:
            assert block['inputOffset']==in_cursor and block['outputOffset']==out_cursor
            assert 0<block['inputFrames']<=8192 and 0<block['outputFrames']<=8192
            in_cursor+=block['inputFrames'];out_cursor+=block['outputFrames']
        assert in_cursor-f['seekInputFrames']==f['processInputFrames'] and out_cursor==f['processOutputFrames']
        rows.append({'id':fid,'profile':f['profile'],'rate':f['exactPlaybackRate'],'crop':[start,end],'processBlocksContiguousAndBounded':True,'channels':metrics})
    assert len(rows)==6
    return {'scope':'Independent raw PCM and process-plan reanalysis only; not an execution rerun, perceptual quality acceptance, latency measurement, or real Browser graph test.','wasmSha256':manifest['wasmSha256'],'sourceSetSha256':manifest['sourceSetSha256'],'fixtureCount':len(rows),'allWorkerCAbiCropsByteIdentical':True,'maxChunkedUpstreamVsWorker':max(c['chunkedUpstreamVsWorker']['maxAbs'] for r in rows for c in r['channels']),'maxSingleCallExactVsChunked':max(c['singleCallExactVsChunked']['maxAbs'] for r in rows for c in r['channels']),'fixtures':rows,'rawInputHashes':hashes}

if __name__=='__main__':
    print(json.dumps(review(sys.argv[1]),indent=2))
