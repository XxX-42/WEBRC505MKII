cmake_minimum_required(VERSION 3.21)
project(native_fx_reclaim_checkpoint LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(MSVC)
  add_compile_options(/W4 /permissive- /EHsc /utf-8)
else()
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

set(DSP_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/shared/dsp")
set(NATIVE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/native")
add_library(signalsmith-stretch INTERFACE)
target_include_directories(signalsmith-stretch INTERFACE
  "${CMAKE_CURRENT_SOURCE_DIR}/third_party/signalsmith-stretch/include"
  "${CMAKE_CURRENT_SOURCE_DIR}/third_party/signalsmith-linear/include")
add_library(webrc_dsp STATIC
  shared/dsp/src/primitives.cpp
  shared/dsp/src/control_dynamics.cpp
  shared/dsp/src/nonlinear.cpp
  shared/dsp/src/fft.cpp
  shared/dsp/src/spatial_temporal.cpp
  shared/dsp/src/pitch.cpp
  shared/dsp/src/signalsmith_adapter.cpp
  shared/dsp/src/streaming_yin.cpp
  shared/dsp/src/live_mono_pitch.cpp
  shared/dsp/src/fx_registry.cpp
  shared/dsp/src/performance_fx.cpp
  shared/dsp/src/modulation_fx.cpp
  shared/dsp/src/rhythm.cpp
  shared/dsp/src/cleanroom_rhythm_data.cpp
  shared/dsp/src/composite_fx.cpp
  shared/dsp/src/modulated_delay_fx.cpp
  shared/dsp/src/rhythmic_fx.cpp
  shared/dsp/src/spatial_fx_adapters.cpp)
target_include_directories(webrc_dsp PUBLIC "${DSP_ROOT}/include")
target_compile_features(webrc_dsp PUBLIC cxx_std_17)
target_link_libraries(webrc_dsp PUBLIC signalsmith-stretch)
add_library(native_multitrack_core STATIC native/src/multitrack_looper_core.cpp)
target_include_directories(native_multitrack_core PUBLIC "${NATIVE_ROOT}/include")
target_link_libraries(native_multitrack_core PUBLIC webrc_dsp)
add_library(native_track_host STATIC native/src/native_track_host.cpp native/src/native_fx_graph.cpp)
target_include_directories(native_track_host PUBLIC "${NATIVE_ROOT}/include")
target_link_libraries(native_track_host PUBLIC native_multitrack_core webrc_dsp)

include(CTest)
if(BUILD_TESTING)
  add_executable(native_fx_graph_tests native/tests/native_fx_graph_tests.cpp)
  target_link_libraries(native_fx_graph_tests PRIVATE native_track_host)
  add_test(NAME native_fx_graph_tests COMMAND native_fx_graph_tests)
  add_executable(native_track_host_tests native/tests/native_track_host_tests.cpp)
  target_link_libraries(native_track_host_tests PRIVATE native_track_host)
  add_test(NAME native_track_host_tests COMMAND native_track_host_tests)
  add_executable(native_multitrack_core_tests native/tests/multitrack_looper_core_tests.cpp)
  target_link_libraries(native_multitrack_core_tests PRIVATE native_multitrack_core)
  add_test(NAME native_multitrack_core_tests COMMAND native_multitrack_core_tests)
endif()
