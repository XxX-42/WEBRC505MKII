"""Build a strict device-free probe in an external Windows/MSVC or portable CMake directory."""
from __future__ import annotations
import argparse
import json
import re
import subprocess
from pathlib import Path
from engine_baseline import source_hashes
from parity_common import REPO_ROOT, ensure_external_path, sha256_file, write_json


def build(outdir: Path, generator: str | None = None, configure_only: bool = False, json_source: Path | None = None) -> dict:
    outdir=ensure_external_path(outdir, 'Native build')
    wrapper=outdir/'wrapper'; wrapper.mkdir(parents=True,exist_ok=True)
    root=REPO_ROOT.as_posix()
    (wrapper/'CMakeLists.txt').write_text(f'''cmake_minimum_required(VERSION 3.21)
project(WebRcSoftwareProbe LANGUAGES CXX)
set(NATIVE_PORTABLE_TESTS_ONLY ON CACHE BOOL "" FORCE)
add_subdirectory("{root}/native-mvp/engine-cpp" production EXCLUDE_FROM_ALL)
add_executable(native_software_probe "{root}/bench/audio-parity/native_software_probe.cpp" "{root}/native-mvp/engine-cpp/tests/native_alloc_tracker.cpp")
target_include_directories(native_software_probe PRIVATE "{root}/native-mvp/engine-cpp/tests")
target_link_libraries(native_software_probe PRIVATE native_audio_core_test_support)
target_compile_features(native_software_probe PRIVATE cxx_std_17)
if(MSVC)
 target_compile_options(native_software_probe PRIVATE /W4 /WX /utf-8 /EHsc)
else()
 target_compile_options(native_software_probe PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()
''',encoding='utf-8')
    build_dir=outdir/'build'
    command=['cmake','-S',str(wrapper),'-B',str(build_dir),'-DCMAKE_BUILD_TYPE=Release']
    if generator: command += ['-G',generator]
    if json_source: command += ['-DFETCHCONTENT_SOURCE_DIR_JSON_SRC='+str(json_source.resolve())]
    subprocess.run(command,check=True)
    if configure_only: return {'status':'PREPARED','wrapper':str(wrapper),'build_directory':str(build_dir)}
    before=source_hashes(REPO_ROOT)
    subprocess.run(['cmake','--build',str(build_dir),'--config','Release','--target','native_software_probe','--parallel','2'],check=True)
    if before != source_hashes(REPO_ROOT): raise RuntimeError('Sources changed during build')
    candidates=[build_dir/'Release/native_software_probe.exe',build_dir/'native_software_probe',build_dir/'native_software_probe.exe']
    binary=next((p for p in candidates if p.is_file()),None)
    if binary is None: raise RuntimeError('Native probe binary missing')
    compiler_files=list((build_dir/'CMakeFiles').glob('*/CMakeCXXCompiler.cmake'))
    compiler_text=compiler_files[0].read_text(encoding='utf-8') if compiler_files else ''
    compiler={key:next(iter(re.findall(r'set\('+key+r' "?([^"\)]+)',compiler_text)),None)
        for key in ('CMAKE_CXX_COMPILER_ID','CMAKE_CXX_COMPILER_VERSION','CMAKE_CXX_COMPILER_ARCHITECTURE_ID')}
    value={'status':'SOFTWARE_BASELINE_BUILD','binary':str(binary.resolve()),'binary_sha256':sha256_file(binary),
        'source_hashes':before,'cmake_cache_sha256':sha256_file(build_dir/'CMakeCache.txt'),
        'wrapper_sha256':sha256_file(wrapper/'CMakeLists.txt'),'compiler':compiler,
        'compiler_scope':'CMake-detected compiler; strict production warnings and probe /W4 /WX on MSVC',
        'hardware_capture':False,'source_root':str(REPO_ROOT),'generator':generator}
    write_json(outdir/'native-probe-build.json',value)
    return value


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--outdir',type=Path,required=True)
    parser.add_argument('--generator')
    parser.add_argument('--configure-only',action='store_true')
    parser.add_argument('--json-source',type=Path,help='Reuse an already downloaded nlohmann-json CMake source directory')
    args=parser.parse_args(); result=build(args.outdir,args.generator,args.configure_only,args.json_source)
    print(json.dumps({key:value for key,value in result.items() if key != 'source_hashes'}))
