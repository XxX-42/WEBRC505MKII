import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('deps', Path(__file__).parents[1] / 'native_build_dependencies.py')
deps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deps)

class BuildDependencyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / 'source with spaces'
        self.build = self.base / 'build'
        self.header = self.source / 'robot.hpp'
        self.cpp = self.source / 'robot.cpp'
        self.obj = self.build / 'CMakeFiles/dsp.dir/robot.cpp.o'
        self.lib = self.build / 'libdsp.a'
        self.exe = self.build / 'probe'
        for path in [self.header, self.cpp, self.obj, self.lib, self.exe]:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(path.name)
        stamp = 100000000000
        for index, path in enumerate([self.header, self.cpp, self.obj, self.lib, self.exe]):
            os.utime(path, ns=(stamp + index, stamp + index))
        escaped = lambda path: str(path).replace(' ', '\\ ')
        Path(str(self.obj) + '.d').write_text('object: ' + escaped(self.cpp) + ' \\\n ' + escaped(self.header) + '\n')
        (self.obj.parent / 'link.txt').write_text('ar qc libdsp.a CMakeFiles/dsp.dir/robot.cpp.o')
        directory = self.build / 'CMakeFiles/probe.dir'
        directory.mkdir()
        (directory / 'link.txt').write_text('c++ -o probe libdsp.a')

    def run_check(self):
        return deps.collect_dependencies(self.source, self.build, ['probe'])

    def test_dependencies_include_non_preamp_header(self):
        result = self.run_check()
        self.assertIn(str(self.header), result['sourceDependencies'])
        self.assertIn(str(self.obj), result['objectDependencies'])

    def test_newer_non_preamp_header_rejected(self):
        os.utime(self.header, ns=(200000000000, 200000000000))
        with self.assertRaisesRegex(ValueError, 'Stale object'):
            self.run_check()

    def test_dependency_outside_source_root_is_tracked(self):
        external = self.base / 'bench' / 'probe.cpp'
        external.parent.mkdir()
        external.write_text('int main() {}')
        os.utime(external, ns=(99999999999, 99999999999))
        depfile = Path(str(self.obj) + '.d')
        depfile.write_text(depfile.read_text().rstrip() + ' ' + str(external) + '\n')
        self.assertIn(str(external), self.run_check()['sourceDependencies'])
        os.utime(external, ns=(200000000000, 200000000000))
        with self.assertRaisesRegex(ValueError, 'Stale object'):
            self.run_check()

    def test_newer_library_rejected(self):
        os.utime(self.lib, ns=(200000000000, 200000000000))
        with self.assertRaisesRegex(ValueError, 'Stale linked output'):
            self.run_check()

    def test_missing_depfile_rejected(self):
        Path(str(self.obj) + '.d').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing object/dependency'):
            self.run_check()

if __name__ == '__main__':
    unittest.main()
