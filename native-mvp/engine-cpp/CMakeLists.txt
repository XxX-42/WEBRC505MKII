cmake_minimum_required(VERSION 3.21)

project(native_audio_core_mvp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(ENABLE_ASIO "Enable ASIO backend support when the local SDK is available" OFF)
set(ASIOSDK_DIR "" CACHE PATH "Path to the Steinberg ASIO SDK root")

include(FetchContent)

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

add_library(native_audio_core STATIC
  src/looper_core.cpp
  src/native_audio_core.cpp
)
target_include_directories(native_audio_core PUBLIC include)
target_link_libraries(native_audio_core PUBLIC rtaudio nlohmann_json::nlohmann_json)

add_executable(native_bridge_host src/native_bridge_host.cpp)
target_link_libraries(native_bridge_host PRIVATE native_audio_core httplib::httplib nlohmann_json::nlohmann_json ws2_32)

add_executable(looper_core_tests tests/looper_core_tests.cpp src/looper_core.cpp)
target_include_directories(looper_core_tests PRIVATE include)

enable_testing()
add_test(NAME looper_core_tests COMMAND looper_core_tests)
