import json
import sys
import tempfile
import unittest
from pathlib import Path
import numpy as np
from scipy.io import wavfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import analyze
import engine_baseline
from parity_common import sha256_file

class EngineBaselineTests(unittest.TestCase):
    def test_render_validation_rejects_missing_and_nonfinite_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'render.f32'
            np.zeros((4,2),dtype='<f4').tofile(path)
            self.assertEqual(engine_baseline.validate_render(path,4).shape,(4,2))
            with self.assertRaisesRegex(ValueError,'length'):engine_baseline.validate_render(path,5)
            np.array([0,float('nan')],dtype='<f4').tofile(path)
            with self.assertRaisesRegex(ValueError,'non-finite'):engine_baseline.validate_render(path,1)
    def test_native_build_binding_fails_closed_on_stale_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);binary=root/'probe.exe';binary.write_bytes(b'not-executed')
            manifest=root/'build.json'
            manifest.write_text(json.dumps({'binary':str(binary),'binary_sha256':'wrong','source_hashes':{}}))
            with self.assertRaisesRegex(ValueError,'binary SHA'):engine_baseline.verify_native_manifest(manifest)
            manifest.write_text(json.dumps({'binary':str(binary),'binary_sha256':sha256_file(binary),'source_hashes':{}}))
            with self.assertRaisesRegex(ValueError,'source tree'):engine_baseline.verify_native_manifest(manifest)
    def test_silence_does_not_invent_zero_latency(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'silence.wav';wavfile.write(path,48000,np.zeros((4800,2),dtype=np.float32))
            result=analyze.analyze_pair(path,path,'silence',capture_kind='software_baseline')
            self.assertIn('unavailable',json.dumps(result))
            lag,score=analyze._estimate_lag(np.zeros((4800,2)),np.zeros((4800,2)),480)
            self.assertIsNone(lag);self.assertIsNone(score)

if __name__=='__main__':unittest.main()
