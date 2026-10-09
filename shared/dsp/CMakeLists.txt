cmake_minimum_required(VERSION 3.16)
project(webrc_shared_dsp LANGUAGES CXX)

add_library(webrc_dsp STATIC
  src/primitives.cpp
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
endif()

add_executable(native_dsp_primitives_bench benchmarks/native_dsp_primitives_bench.cpp)
target_link_libraries(native_dsp_primitives_bench PRIVATE webrc_dsp)

add_executable(dsp_primitives_golden benchmarks/native_dsp_primitives_golden.cpp)
target_link_libraries(dsp_primitives_golden PRIVATE webrc_dsp)
