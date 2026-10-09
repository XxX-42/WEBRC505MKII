cmake_minimum_required(VERSION 3.20)
project(webrc_native_rhythm_capture LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")
enable_testing()
set(WEBRC_SHARED_DSP "${CMAKE_CURRENT_SOURCE_DIR}/shared/dsp")
set(WEBRC_RHYTHM_COMMON
  "${WEBRC_SHARED_DSP}/src/rhythm.cpp"
  "${WEBRC_SHARED_DSP}/src/cleanroom_rhythm_data.cpp"
  "${WEBRC_SHARED_DSP}/src/primitives.cpp"
  "${WEBRC_SHARED_DSP}/src/fft.cpp"
  "${WEBRC_SHARED_DSP}/src/spatial_temporal.cpp")
add_executable(rhythm_tests "${WEBRC_SHARED_DSP}/tests/rhythm_tests.cpp" ${WEBRC_RHYTHM_COMMON})
target_include_directories(rhythm_tests PRIVATE "${WEBRC_SHARED_DSP}/include")
add_test(NAME rhythm_tests COMMAND rhythm_tests)
add_executable(native_rhythm_bench "${WEBRC_SHARED_DSP}/benchmarks/native_rhythm_bench.cpp" ${WEBRC_RHYTHM_COMMON})
target_include_directories(native_rhythm_bench PRIVATE "${WEBRC_SHARED_DSP}/include")
if(MSVC)
  target_compile_options(rhythm_tests PRIVATE /W4)
  target_compile_options(native_rhythm_bench PRIVATE /W4)
endif()
