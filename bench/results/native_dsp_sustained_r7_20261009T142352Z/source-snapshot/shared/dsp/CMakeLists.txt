cmake_minimum_required(VERSION 3.16)
project(webrc_shared_dsp LANGUAGES CXX)

get_filename_component(WEBRC_REPOSITORY_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
set(WEBRC_SIGNALSMITH_STRETCH_INCLUDE "${WEBRC_REPOSITORY_ROOT}/third_party/signalsmith-stretch/include")
set(WEBRC_SIGNALSMITH_LINEAR_INCLUDE "${WEBRC_REPOSITORY_ROOT}/third_party/signalsmith-linear/include")
if(NOT EXISTS "${WEBRC_SIGNALSMITH_STRETCH_INCLUDE}/signalsmith-stretch/signalsmith-stretch.h" OR
   NOT EXISTS "${WEBRC_SIGNALSMITH_LINEAR_INCLUDE}/signalsmith-linear/linear.h")
  message(FATAL_ERROR "Pinned Signalsmith Stretch/Linear headers are missing from third_party.")
endif()
add_library(signalsmith-stretch INTERFACE)
target_include_directories(signalsmith-stretch INTERFACE
  "${WEBRC_SIGNALSMITH_STRETCH_INCLUDE}"
  "${WEBRC_SIGNALSMITH_LINEAR_INCLUDE}"
)

add_library(webrc_dsp STATIC
  src/primitives.cpp
  src/control_dynamics.cpp
  src/nonlinear.cpp
  src/fft.cpp
  src/spatial_temporal.cpp
  src/pitch.cpp
  src/signalsmith_adapter.cpp
  src/fx_registry.cpp
  src/performance_fx.cpp
  src/rhythm.cpp
  src/cleanroom_rhythm_data.cpp
)

target_include_directories(webrc_dsp PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_compile_features(webrc_dsp PUBLIC cxx_std_17)
target_link_libraries(webrc_dsp PUBLIC signalsmith-stretch)

if(MSVC)
  target_compile_options(webrc_dsp PRIVATE /W4 /permissive-)
else()
  target_compile_options(webrc_dsp PRIVATE -Wall -Wextra -Wpedantic)
endif()

include(CTest)
if(BUILD_TESTING)
  add_executable(dsp_primitives_tests tests/dsp_primitives_tests.cpp)
  target_link_libraries(dsp_primitives_tests PRIVATE webrc_dsp)
  add_test(NAME dsp_primitives_tests COMMAND dsp_primitives_tests)

  add_executable(control_dynamics_tests tests/control_dynamics_tests.cpp)
  target_link_libraries(control_dynamics_tests PRIVATE webrc_dsp)
  add_test(NAME control_dynamics_tests COMMAND control_dynamics_tests)

  add_executable(nonlinear_tests tests/nonlinear_tests.cpp)
  target_link_libraries(nonlinear_tests PRIVATE webrc_dsp)
  add_test(NAME nonlinear_tests COMMAND nonlinear_tests)

  add_executable(spatial_temporal_tests tests/spatial_temporal_tests.cpp)
  target_link_libraries(spatial_temporal_tests PRIVATE webrc_dsp)
  add_test(NAME spatial_temporal_tests COMMAND spatial_temporal_tests)

  add_executable(pitch_tests tests/pitch_tests.cpp)
  target_link_libraries(pitch_tests PRIVATE webrc_dsp)
  add_test(NAME pitch_tests COMMAND pitch_tests)

  add_executable(fx_registry_tests tests/fx_registry_tests.cpp)
  target_link_libraries(fx_registry_tests PRIVATE webrc_dsp)
  add_test(NAME fx_registry_tests COMMAND fx_registry_tests)

  add_executable(performance_fx_tests tests/performance_fx_tests.cpp)
  target_link_libraries(performance_fx_tests PRIVATE webrc_dsp)
  add_test(NAME performance_fx_tests COMMAND performance_fx_tests)

  add_executable(rhythm_tests tests/rhythm_tests.cpp)
  target_link_libraries(rhythm_tests PRIVATE webrc_dsp)
  add_test(NAME rhythm_tests COMMAND rhythm_tests)
endif()

add_executable(native_dsp_primitives_bench benchmarks/native_dsp_primitives_bench.cpp)
target_link_libraries(native_dsp_primitives_bench PRIVATE webrc_dsp)

add_executable(dsp_primitives_golden benchmarks/native_dsp_primitives_golden.cpp)
target_link_libraries(dsp_primitives_golden PRIVATE webrc_dsp)

add_executable(native_dsp_pcm_fixture_generator benchmarks/native_dsp_pcm_fixture_generator.cpp)
target_link_libraries(native_dsp_pcm_fixture_generator PRIVATE webrc_dsp)

add_executable(native_dsp_parity_v21_generator benchmarks/native_dsp_parity_v21_generator.cpp)
target_link_libraries(native_dsp_parity_v21_generator PRIVATE webrc_dsp)

add_executable(native_rhythm_bench benchmarks/native_rhythm_bench.cpp)
target_link_libraries(native_rhythm_bench PRIVATE webrc_dsp)

add_executable(native_dsp_sustained_bench benchmarks/native_dsp_sustained_bench.cpp)
target_link_libraries(native_dsp_sustained_bench PRIVATE webrc_dsp)
