cmake_minimum_required(VERSION 3.21)

project(native_audio_core_mvp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(ENABLE_ASIO "Enable ASIO backend support when the local SDK is available" OFF)
set(ASIOSDK_DIR "" CACHE PATH "Path to the Steinberg ASIO SDK root")
set(NATIVE_BENCH_LOOPER_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/src/looper_core.cpp" CACHE FILEPATH "LooperCore source used by the standalone benchmark")

include(FetchContent)

add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../../shared/dsp shared_dsp)

FetchContent_Declare(
  rtaudio_src
  GIT_REPOSITORY https://github.com/thestk/rtaudio.git
  GIT_TAG 6.0.1
)

FetchContent_Declare(
  httplib_src
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG v0.16.3
)

FetchContent_Declare(
  json_src
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG v3.11.3
)

set(RTAUDIO_BUILD_STATIC_LIBS ON CACHE BOOL "" FORCE)
set(RTAUDIO_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

FetchContent_MakeAvailable(rtaudio_src httplib_src json_src)

target_compile_definitions(rtaudio PUBLIC RTAUDIO_API_WASAPI)
target_link_libraries(rtaudio ole32 winmm ksuser avrt uuid user32)

if(ENABLE_ASIO)
  if(NOT ASIOSDK_DIR)
    message(FATAL_ERROR "ENABLE_ASIO requires ASIOSDK_DIR.")
  endif()

  file(GLOB ASIO_COMMON_SOURCES "${ASIOSDK_DIR}/common/*.cpp")
  file(GLOB ASIO_HOST_SOURCES "${ASIOSDK_DIR}/host/*.cpp")

  if(NOT ASIO_COMMON_SOURCES OR NOT ASIO_HOST_SOURCES)
    message(FATAL_ERROR "ASIOSDK_DIR is missing ASIO SDK source files.")
  endif()

  target_sources(rtaudio PRIVATE ${ASIO_COMMON_SOURCES} ${ASIO_HOST_SOURCES})
  target_include_directories(rtaudio PUBLIC "${ASIOSDK_DIR}/common" "${ASIOSDK_DIR}/host")
  target_compile_definitions(rtaudio PUBLIC RTAUDIO_API_ASIO)
endif()

# Five-stereo-track software engine and RtAudio host adapter. Audio-device
# access still occurs only when the host is explicitly started.
add_library(native_multitrack_core STATIC
  src/multitrack_looper_core.cpp
)
target_include_directories(native_multitrack_core PUBLIC include)
target_link_libraries(native_multitrack_core PUBLIC webrc_dsp)

add_library(native_track_host STATIC
  src/native_track_host.cpp
  src/native_fx_graph.cpp
  src/native_fx_control.cpp
)
target_include_directories(native_track_host PUBLIC include)
target_link_libraries(native_track_host PUBLIC native_multitrack_core webrc_dsp)

add_library(native_audio_core STATIC
  src/looper_core.cpp
  src/native_audio_core.cpp
  src/native_audio_asset_codec.cpp
)
target_include_directories(native_audio_core PUBLIC include)
target_link_libraries(native_audio_core PUBLIC rtaudio nlohmann_json::nlohmann_json native_track_host)

add_executable(native_bridge_host src/native_bridge_host.cpp)
target_link_libraries(native_bridge_host PRIVATE native_audio_core httplib::httplib nlohmann_json::nlohmann_json ws2_32)

add_executable(looper_core_tests tests/looper_core_tests.cpp src/looper_core.cpp)
target_include_directories(looper_core_tests PRIVATE include)
target_link_libraries(looper_core_tests PRIVATE rtaudio native_track_host)

add_executable(native_multitrack_core_tests tests/multitrack_looper_core_tests.cpp)
target_include_directories(native_multitrack_core_tests PRIVATE include)
target_link_libraries(native_multitrack_core_tests PRIVATE native_multitrack_core)

# Offline stereo WAVE asset codec. This is a reusable building block for
# project/track I/O; the test does not imply that those host routes exist.
add_executable(native_audio_asset_codec_tests
  tests/native_audio_asset_codec_tests.cpp
  src/native_audio_asset_codec.cpp
)
target_include_directories(native_audio_asset_codec_tests PRIVATE include)

add_executable(native_track_host_tests tests/native_track_host_tests.cpp)
target_include_directories(native_track_host_tests PRIVATE include)
target_link_libraries(native_track_host_tests PRIVATE native_track_host)

add_executable(native_fx_graph_tests tests/native_fx_graph_tests.cpp)
target_include_directories(native_fx_graph_tests PRIVATE include)
target_link_libraries(native_fx_graph_tests PRIVATE native_track_host)

add_executable(native_fx_control_tests tests/native_fx_control_tests.cpp)
target_include_directories(native_fx_control_tests PRIVATE include)
target_link_libraries(native_fx_control_tests PRIVATE native_track_host)

add_executable(native_looper_bench benchmarks/native_looper_bench.cpp "${NATIVE_BENCH_LOOPER_SOURCE}")
target_include_directories(native_looper_bench PRIVATE include)

enable_testing()
add_test(NAME looper_core_tests COMMAND looper_core_tests)
add_test(NAME native_multitrack_core_tests COMMAND native_multitrack_core_tests)
add_test(NAME native_audio_asset_codec_tests COMMAND native_audio_asset_codec_tests)
add_test(NAME native_track_host_tests COMMAND native_track_host_tests)
add_test(NAME native_fx_graph_tests COMMAND native_fx_graph_tests)
add_test(NAME native_fx_control_tests COMMAND native_fx_control_tests)
if(WIN32)
  find_program(NATIVE_POWERSHELL_EXECUTABLE NAMES powershell.exe powershell)
  if(NATIVE_POWERSHELL_EXECUTABLE)
    add_test(NAME native_rhythm_http_software_smoke
      COMMAND "${NATIVE_POWERSHELL_EXECUTABLE}" -NoProfile -ExecutionPolicy Bypass
              -File "${CMAKE_CURRENT_SOURCE_DIR}/tests/native_rhythm_http_software_smoke.ps1"
              -ServerPath $<TARGET_FILE:native_bridge_host>)
    set_tests_properties(native_rhythm_http_software_smoke PROPERTIES TIMEOUT 120)
  endif()
endif()
