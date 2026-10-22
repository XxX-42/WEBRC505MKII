"""Fast stub coverage; never invokes a real soak or claims audio correctness."""
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

RUNNER = pathlib.Path(__file__).resolve().parents[1] / 'run_native_soak.py'

class SoakBindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        (self.root / 'bench').mkdir()
        (self.root / 'native-mvp/engine-cpp/src').mkdir(parents=True)
        (self.root / 'native-mvp/engine-cpp/src/native_preamp_processor.cpp').write_text('fixture')
        self.runner = self.root / 'bench/run_native_soak.py'
        self.runner.write_text(RUNNER.read_text())
        (self.root / 'bench/native_build_dependencies.py').write_text('import json,pathlib\ndef collect_dependencies(source, build, targets):\n return json.loads((pathlib.Path(build)/"dependencies.json").read_text())\n')
        self.deps = {'sourceDependencies': {'fixture': 'before'}}
        (self.root / 'dependencies.json').write_text(json.dumps(self.deps))
        self.binary = self.root / 'native_performance_soak'
        self.binary.write_text('#!/usr/bin/env python3\nprint("{}")\n')
        self.binary.chmod(0o700)
        self.output = self.root / 'result.json'
        self.manifest = self.root / 'manifest.json'
        self.save_manifest()

    def tearDown(self):
        self.temp.cleanup()

    def save_manifest(self, **changes):
        data = dict(buildBindingVerified=True, dependencyBindingVersion=1, sourceRoot=str(self.root), buildRoot=str(self.root),
                    binaries={self.binary.name: hashlib.sha256(self.binary.read_bytes()).hexdigest()},
                    dependencyBinding=self.deps)
        data.update(changes)
        self.manifest.write_text(json.dumps(data))

    def run_stub(self, verified=True):
        command = [sys.executable, str(self.runner), str(self.binary), str(self.output), '0']
        if verified:
            command += ['--build-manifest', str(self.manifest)]
        return subprocess.run(command, capture_output=True, text=True)

    def test_legacy_is_unverified(self):
        self.assertEqual(self.run_stub(False).returncode, 0)
        self.assertFalse(json.loads(self.output.read_text())['buildBindingVerified'])

    def test_matching_manifest_is_verified(self):
        self.assertEqual(self.run_stub().returncode, 0)
        self.assertTrue(json.loads(self.output.read_text())['buildBindingVerified'])

    def test_unverified_manifest_rejected(self):
        self.save_manifest(buildBindingVerified=False)
        self.assertNotEqual(self.run_stub().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_legacy_manifest_rejected(self):
        self.save_manifest(dependencyBindingVersion=0)
        self.assertNotEqual(self.run_stub().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_empty_dependencies_rejected(self):
        self.save_manifest(dependencyBinding={})
        self.assertNotEqual(self.run_stub().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_changed_binary_rejected(self):
        self.binary.write_text(self.binary.read_text() + '# changed\n')
        self.assertNotEqual(self.run_stub().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_mid_run_dependency_change_rejected(self):
        self.binary.write_text('#!/usr/bin/env python3\nimport pathlib\npathlib.Path(' + repr(str(self.root / 'dependencies.json')) + ').write_text("{}")\nprint("{}")\n')
        self.save_manifest()
        self.assertNotEqual(self.run_stub().returncode, 0)
        self.assertFalse(self.output.exists())

if __name__ == '__main__':
    unittest.main()
