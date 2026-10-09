cmake_minimum_required(VERSION 3.16)
project(webrc_shared_dsp LANGUAGES CXX)

add_library(webrc_dsp STATIC
  src/primitives.cpp
  src/control_dynamics.cpp
  src/nonlinear.cpp
)

target_include_directories(webrc_dsp PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_compile_features(webrc_dsp PUBLIC cxx_std_17)

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
endif()

add_executable(native_dsp_primitives_bench benchmarks/native_dsp_primitives_bench.cpp)
target_link_libraries(native_dsp_primitives_bench PRIVATE webrc_dsp)

add_executable(dsp_primitives_golden benchmarks/native_dsp_primitives_golden.cpp)
target_link_libraries(dsp_primitives_golden PRIVATE webrc_dsp)
