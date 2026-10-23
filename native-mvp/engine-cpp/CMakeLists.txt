cmake_minimum_required(VERSION 3.21)

project(native_audio_core_mvp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(MSVC)
  add_compile_options(/utf-8 /Zc:lambda)
endif()

option(ENABLE_ASIO "Enable ASIO backend support when the local SDK is available" OFF)
set(ASIOSDK_DIR "" CACHE PATH "Path to the Steinberg ASIO SDK root")
option(NATIVE_PORTABLE_TESTS_ONLY "Build the device-free Native DSP/rhythm tests without fetching Windows audio or bridge dependencies" OFF)
option(NATIVE_BRIDGE_SIMULATION_ONLY "Build a test-only HTTP host with a fake no-audio RtAudio endpoint" OFF)
option(NATIVE_ENABLE_RUBBERBAND_HQ "Enable Native offline HQ_RENDER with Rubber Band R2/R3 (GPL-2.0-or-later dependency)" OFF)
option(NATIVE_PREAMP_EXPERIMENTAL_STABLE_ADAA "Enable the experimental constant-cancelled PREAMP ADAA arithmetic candidate (not quality accepted; default OFF)" OFF)
set(RUBBERBAND_INCLUDE_DIR "" CACHE PATH "Directory containing rubberband/RubberBandStretcher.h")
set(RUBBERBAND_LIBRARY "" CACHE FILEPATH "Rubber Band library to link when NATIVE_ENABLE_RUBBERBAND_HQ is ON")

set(PROJECT_GPL_LICENSE "${CMAKE_CURRENT_SOURCE_DIR}/../../LICENSE")
set(PROJECT_THIRD_PARTY_NOTICE_INDEX "${CMAKE_CURRENT_SOURCE_DIR}/../../THIRD_PARTY_NOTICES.md")
set(RUBBERBAND_COPYING_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/third_party/rubberband/COPYING")
set(RUBBERBAND_THIRD_PARTY_BUILD "${CMAKE_BINARY_DIR}/THIRD_PARTY/rubberband")

function(enable_rubberband_hq target_name)
  if(NOT NATIVE_ENABLE_RUBBERBAND_HQ)
    return()
  endif()

  if(NOT RUBBERBAND_INCLUDE_DIR)
    find_path(RUBBERBAND_INCLUDE_DIR NAMES rubberband/RubberBandStretcher.h REQUIRED)
  endif()
  if(NOT RUBBERBAND_LIBRARY)
    find_library(RUBBERBAND_LIBRARY NAMES rubberband REQUIRED)
  endif()
  if(NOT EXISTS "${RUBBERBAND_INCLUDE_DIR}/rubberband/RubberBandStretcher.h")
    message(FATAL_ERROR "NATIVE_ENABLE_RUBBERBAND_HQ requires rubberband/RubberBandStretcher.h in RUBBERBAND_INCLUDE_DIR")
  endif()
  if(NOT EXISTS "${RUBBERBAND_LIBRARY}")
    message(FATAL_ERROR "NATIVE_ENABLE_RUBBERBAND_HQ requires RUBBERBAND_LIBRARY to point to the matching library")
  endif()
  if(NOT EXISTS "${RUBBERBAND_COPYING_SOURCE}")
    message(FATAL_ERROR "Pinned Rubber Band GPL license is missing: ${RUBBERBAND_COPYING_SOURCE}")
  endif()

  find_package(Threads REQUIRED)
  target_sources(${target_name} PRIVATE src/native_rubberband_renderer.cpp)
  target_include_directories(${target_name} PUBLIC "${RUBBERBAND_INCLUDE_DIR}")
  target_link_libraries(${target_name} PUBLIC "${RUBBERBAND_LIBRARY}" Threads::Threads)
  target_compile_definitions(${target_name} PUBLIC NATIVE_RUBBERBAND_HQ_AVAILABLE=1)
  file(MAKE_DIRECTORY "${RUBBERBAND_THIRD_PARTY_BUILD}")
  configure_file("${RUBBERBAND_COPYING_SOURCE}" "${RUBBERBAND_THIRD_PARTY_BUILD}/COPYING" COPYONLY)
endfunction()

# Keep exact vendor notices beside every Native build and copy them next to the
# host executable below. These notices describe vendored Signalsmith Stretch
# and Linear; they do not license the repository as a whole.
set(SIGNALSMITH_NOTICE_FILES
  NOTICE.md
  SIGNALSMITH_STRETCH_LICENSE.txt
  SIGNALSMITH_LINEAR_LICENSE.txt
)
set(SIGNALSMITH_THIRD_PARTY_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/third_party/signalsmith")
set(SIGNALSMITH_THIRD_PARTY_BUILD "${CMAKE_BINARY_DIR}/THIRD_PARTY/signalsmith")
file(MAKE_DIRECTORY "${SIGNALSMITH_THIRD_PARTY_BUILD}")
foreach(notice_file IN LISTS SIGNALSMITH_NOTICE_FILES)
  configure_file(
    "${SIGNALSMITH_THIRD_PARTY_SOURCE}/${notice_file}"
    "${SIGNALSMITH_THIRD_PARTY_BUILD}/${notice_file}"
    COPYONLY
  )
endforeach()

function(copy_native_notices_next_to target_name)
  add_custom_command(TARGET ${target_name} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy
      "${PROJECT_GPL_LICENSE}"
      "$<TARGET_FILE_DIR:${target_name}>/LICENSE"
    COMMAND ${CMAKE_COMMAND} -E copy
      "${PROJECT_THIRD_PARTY_NOTICE_INDEX}"
      "$<TARGET_FILE_DIR:${target_name}>/THIRD_PARTY_NOTICES.md"
    COMMAND ${CMAKE_COMMAND} -E make_directory
      "$<TARGET_FILE_DIR:${target_name}>/THIRD_PARTY"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "${SIGNALSMITH_THIRD_PARTY_BUILD}"
      "$<TARGET_FILE_DIR:${target_name}>/THIRD_PARTY/signalsmith"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "${RTAUDIO_THIRD_PARTY_BUILD}"
      "$<TARGET_FILE_DIR:${target_name}>/THIRD_PARTY/rtaudio"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "${HTTPLIB_THIRD_PARTY_BUILD}"
      "$<TARGET_FILE_DIR:${target_name}>/THIRD_PARTY/cpp-httplib"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "${JSON_THIRD_PARTY_BUILD}"
      "$<TARGET_FILE_DIR:${target_name}>/THIRD_PARTY/nlohmann-json"
    VERBATIM
  )
  if(NATIVE_ENABLE_RUBBERBAND_HQ)
    add_custom_command(TARGET ${target_name} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${RUBBERBAND_THIRD_PARTY_BUILD}"
        "$<TARGET_FILE_DIR:${target_name}>/THIRD_PARTY/rubberband"
      VERBATIM
    )
  endif()
endfunction()

function(copy_signalsmith_notices_next_to target_name)
  add_custom_command(TARGET ${target_name} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "${SIGNALSMITH_THIRD_PARTY_BUILD}"
      "$<TARGET_FILE_DIR:${target_name}>/THIRD_PARTY/signalsmith"
    VERBATIM
  )
endfunction()

function(add_signalsmith_notice_test test_name output_dir)
  add_test(NAME ${test_name}
    COMMAND ${CMAKE_COMMAND}
      "-DSOURCE_DIR=${SIGNALSMITH_THIRD_PARTY_SOURCE}"
      "-DBUILD_DIR=${output_dir}"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/verify_third_party_notices.cmake"
  )
endfunction()

function(enable_strict_warnings target)
    if(MSVC)
      target_compile_options(${target} PRIVATE /W4 /WX /Zc:lambda)
    else()
      target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
    endif()
endfunction()

function(enable_native_preamp_experimental_adaa target)
  if(NATIVE_PREAMP_EXPERIMENTAL_STABLE_ADAA)
    target_compile_definitions(${target} PRIVATE NATIVE_PREAMP_EXPERIMENTAL_STABLE_ADAA=1)
  endif()
endfunction()

# Native tests use assert() for their checks. Release configurations define
# NDEBUG globally. Force an assertion header only into test executables rather
# than overriding /D with /U, which produces MSVC D9025 under /WX.
function(enable_assertions_for_test_executables)
  get_property(test_targets DIRECTORY PROPERTY BUILDSYSTEM_TARGETS)
  foreach(test_target IN LISTS test_targets)
    get_target_property(target_type ${test_target} TYPE)
    if(target_type STREQUAL "EXECUTABLE" AND test_target MATCHES "_tests$")
      if(MSVC)
        target_compile_options(${test_target} PRIVATE
          "/FI${CMAKE_CURRENT_SOURCE_DIR}/tests/support/enable_test_assertions.hpp")
        # The callback fixtures include several large fixed scratch arrays.
        # This is a test-process stack reservation, never an audio allocation.
        target_link_options(${test_target} PRIVATE /STACK:16777216)
      else()
        target_compile_options(${test_target} PRIVATE
          -include "${CMAKE_CURRENT_SOURCE_DIR}/tests/support/enable_test_assertions.hpp")
      endif()
    endif()
  endforeach()
endfunction()

# The archive codec is built in portable test mode too, so fetch its one
# header-only dependency before that mode's early return. Keep the same official
# upstream version pin used by the Native host build.
include(FetchContent)
FetchContent_Declare(
  json_src
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG v3.11.3
)
FetchContent_MakeAvailable(json_src)

# Keep the binary archive decoder independent of the host and DSP libraries so
# it can be validated in portable test builds and linked by either Native host.
add_library(native_project_archive_codec STATIC src/project_archive_codec.cpp)
target_include_directories(native_project_archive_codec PUBLIC include)
target_link_libraries(native_project_archive_codec PUBLIC nlohmann_json::nlohmann_json)
enable_strict_warnings(native_project_archive_codec)

if(NATIVE_PORTABLE_TESTS_ONLY)

  add_library(native_dsp_portable STATIC
    src/looper_core.cpp
    src/dsp_primitives.cpp
    src/native_output_stage.cpp
    src/native_fdn16_reverb_processor.cpp
    src/native_distortion_processor.cpp
    src/native_preamp_processor.cpp
    src/native_beat_repeat_processor.cpp
    src/native_roll_processor.cpp
    src/native_freeze_processor.cpp
    src/native_beat_scatter_processor.cpp
    src/native_tape_echo_processor.cpp
    src/native_reverse_delay_processor.cpp
    src/native_panning_delay_processor.cpp
    src/native_mod_delay_processor.cpp
    src/native_chorus_processor.cpp
    src/native_phaser_processor.cpp
    src/native_autopan_processor.cpp
    src/native_vinyl_flick_processor.cpp
    src/native_dynamics_processor.cpp
    src/native_flanger_processor.cpp
    src/native_stereo_enhance_processor.cpp
    src/native_fx_catalog.cpp
    src/native_electric_processor.cpp
    src/native_g2b_processor.cpp
    src/native_rhythm_engine.cpp
    src/native_pitch_processor.cpp
    src/native_poly_pitch_processor.cpp
    src/native_auto_riff_core.cpp
    src/native_hrm_auto_core.cpp
    src/native_hrm_auto_processor.cpp
    src/native_robot_core.cpp
    src/native_vocoder_core.cpp
    src/native_osc_voc_core.cpp
    src/native_osc_voc_processor.cpp
    src/native_osc_bot_core.cpp
    src/native_osc_bot_processor.cpp
  )
  target_include_directories(native_dsp_portable PUBLIC include)
  target_include_directories(native_dsp_portable SYSTEM PUBLIC third_party/signalsmith/include)
  enable_native_preamp_experimental_adaa(native_dsp_portable)
  enable_rubberband_hq(native_dsp_portable)
  enable_strict_warnings(native_dsp_portable)

  add_executable(looper_core_tests tests/looper_core_tests.cpp)
  target_link_libraries(looper_core_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(looper_core_tests)

  add_executable(dsp_primitives_tests tests/dsp_primitives_tests.cpp)
  target_link_libraries(dsp_primitives_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(dsp_primitives_tests)

  add_executable(native_official_fx_parameters_tests
    tests/native_official_fx_parameters_tests.cpp tests/native_alloc_tracker.cpp)
  target_link_libraries(native_official_fx_parameters_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_official_fx_parameters_tests)
  if(NOT MSVC)
    target_compile_options(native_official_fx_parameters_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_test(NAME native_official_fx_parameters_tests COMMAND native_official_fx_parameters_tests)
  add_executable(native_official_vocoder_controls_tests
    tests/native_official_vocoder_controls_tests.cpp tests/native_alloc_tracker.cpp)
  target_link_libraries(native_official_vocoder_controls_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_official_vocoder_controls_tests)
  if(NOT MSVC)
    target_compile_options(native_official_vocoder_controls_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_test(NAME native_official_vocoder_controls_tests COMMAND native_official_vocoder_controls_tests)
  add_executable(native_official_amp_dynamics_tests
    tests/native_official_amp_dynamics_tests.cpp tests/native_alloc_tracker.cpp)
  target_link_libraries(native_official_amp_dynamics_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_official_amp_dynamics_tests)
  if(NOT MSVC)
    target_compile_options(native_official_amp_dynamics_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_test(NAME native_official_amp_dynamics_tests COMMAND native_official_amp_dynamics_tests)
  add_executable(native_official_slicer_controls_tests tests/native_official_slicer_controls_tests.cpp tests/native_alloc_tracker.cpp)
  target_link_libraries(native_official_slicer_controls_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_official_slicer_controls_tests)
  if(NOT MSVC)
    target_compile_options(native_official_slicer_controls_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_test(NAME native_official_slicer_controls_tests COMMAND native_official_slicer_controls_tests)
  add_executable(native_official_tape_roll_tests tests/native_official_tape_roll_tests.cpp tests/native_alloc_tracker.cpp)
  target_link_libraries(native_official_tape_roll_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_official_tape_roll_tests)
  if(NOT MSVC)
    target_compile_options(native_official_tape_roll_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_test(NAME native_official_tape_roll_tests COMMAND native_official_tape_roll_tests)
  add_executable(native_official_pitch_controls_tests
    tests/native_official_pitch_controls_tests.cpp tests/native_alloc_tracker.cpp)
  target_link_libraries(native_official_pitch_controls_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_official_pitch_controls_tests)
  if(NOT MSVC)
    target_compile_options(native_official_pitch_controls_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_test(NAME native_official_pitch_controls_tests COMMAND native_official_pitch_controls_tests)

  add_executable(native_audio_pipeline_tests tests/native_audio_pipeline_tests.cpp)
  target_link_libraries(native_audio_pipeline_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_audio_pipeline_tests)

  add_executable(project_archive_codec_tests tests/project_archive_codec_tests.cpp)
  target_link_libraries(project_archive_codec_tests PRIVATE native_project_archive_codec)
  enable_strict_warnings(project_archive_codec_tests)

  add_executable(native_fx_catalog_tests
    tests/native_fx_catalog_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_fx_catalog_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_fx_catalog_tests)

  add_executable(native_vocoder_core_tests
    tests/native_vocoder_core_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_vocoder_core_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_vocoder_core_tests)
  if(MSVC)
  else()
    target_compile_options(native_vocoder_core_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_auto_riff_core_tests
    tests/native_auto_riff_core_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_auto_riff_core_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_auto_riff_core_tests)
  if(MSVC)
  else()
    target_compile_options(native_auto_riff_core_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_osc_voc_core_tests
    tests/native_osc_voc_core_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_osc_voc_core_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_osc_voc_core_tests)
  if(MSVC)
  else()
    target_compile_options(native_osc_voc_core_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_osc_voc_processor_tests
    tests/native_osc_voc_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_osc_voc_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_osc_voc_processor_tests)
  if(MSVC)
  else()
    target_compile_options(native_osc_voc_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_hrm_auto_processor_tests
    tests/native_hrm_auto_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_hrm_auto_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_hrm_auto_processor_tests)
  if(MSVC)
  else()
    target_compile_options(native_hrm_auto_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_hrm_auto_core_tests
    tests/native_hrm_auto_core_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_hrm_auto_core_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_hrm_auto_core_tests)
  if(MSVC)
  else()
    target_compile_options(native_hrm_auto_core_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_robot_core_tests
    tests/native_robot_core_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_robot_core_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_robot_core_tests)
  if(MSVC)
  else()
    target_compile_options(native_robot_core_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_osc_bot_core_tests
    tests/native_osc_bot_core_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_osc_bot_core_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_osc_bot_core_tests)
  if(MSVC)
  else()
    target_compile_options(native_osc_bot_core_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_osc_bot_processor_tests
    tests/native_osc_bot_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_osc_bot_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_osc_bot_processor_tests)
  if(MSVC)
  else()
    target_compile_options(native_osc_bot_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_g2b_processor_tests
    tests/native_g2b_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_g2b_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_g2b_processor_tests)
  if(MSVC)
  else()
    target_compile_options(native_g2b_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_synth_processor_tests
    tests/native_synth_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_synth_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_synth_processor_tests)
  if(MSVC)
  else()
    target_compile_options(native_synth_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_manual_pan_processor_tests
    tests/native_manual_pan_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_manual_pan_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_manual_pan_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_manual_pan_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_isolator_processor_tests
    tests/native_isolator_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_isolator_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_isolator_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_isolator_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_slow_gear_processor_tests
    tests/native_slow_gear_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_slow_gear_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_slow_gear_processor_tests)
  if(MSVC)
  else()
    target_compile_options(native_slow_gear_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_library(native_audio_core_test_support STATIC src/native_audio_core.cpp)
  target_include_directories(native_audio_core_test_support BEFORE PUBLIC tests/support include)
  target_link_libraries(native_audio_core_test_support PUBLIC native_dsp_portable)
  enable_strict_warnings(native_audio_core_test_support)

  add_executable(native_catalog_ack_tests tests/native_catalog_ack_tests.cpp)
  target_link_libraries(native_catalog_ack_tests PRIVATE native_audio_core_test_support)
  enable_strict_warnings(native_catalog_ack_tests)
  add_executable(native_audio_callback_tests tests/native_audio_callback_tests.cpp)
  target_link_libraries(native_audio_callback_tests PRIVATE native_audio_core_test_support)
  enable_strict_warnings(native_audio_callback_tests)
  # Callback assertions are the actual acceptance checks (including the
  # allocation guard), so keep them enabled in Release configurations too.
  # This test intentionally overrides global new/delete with malloc/free to
  # count callback allocations. GCC's mismatched-new-delete heuristic cannot
  # see through that test allocator and otherwise rejects std::map fixtures.
  if(NOT MSVC)
    target_compile_options(native_audio_callback_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_freeze_processor_tests
    tests/native_freeze_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_freeze_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_freeze_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_freeze_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_catalog_route_tests tests/native_catalog_route_tests.cpp tests/native_alloc_tracker.cpp)
  target_link_libraries(native_catalog_route_tests PRIVATE native_audio_core_test_support)
  enable_strict_warnings(native_catalog_route_tests)

  add_executable(native_pitch_processor_tests
    tests/native_pitch_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_pitch_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_pitch_processor_tests)

  add_executable(native_poly_pitch_processor_tests
    tests/native_poly_pitch_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_poly_pitch_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_poly_pitch_processor_tests)

  add_executable(native_chorus_processor_tests
    tests/native_chorus_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_chorus_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_chorus_processor_tests)

  add_executable(native_phaser_processor_tests
    tests/native_phaser_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_phaser_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_phaser_processor_tests)

  add_executable(native_autopan_processor_tests
    tests/native_autopan_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_autopan_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_autopan_processor_tests)

  add_executable(native_vinyl_flick_processor_tests
    tests/native_vinyl_flick_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_vinyl_flick_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_vinyl_flick_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_vinyl_flick_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_flanger_processor_tests
    tests/native_flanger_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_flanger_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_flanger_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_flanger_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_dynamics_processor_tests
    tests/native_dynamics_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_dynamics_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_dynamics_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_dynamics_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_fdn16_reverb_processor_tests
    tests/native_fdn16_reverb_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_fdn16_reverb_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_fdn16_reverb_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_fdn16_reverb_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_executable(native_distortion_processor_tests
    tests/native_distortion_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_distortion_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_distortion_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_distortion_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_executable(native_preamp_processor_tests
    tests/native_preamp_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_preamp_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_preamp_processor_tests)
  if(MSVC)
  else()
    target_compile_options(native_preamp_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_executable(native_beat_repeat_processor_tests
    tests/native_beat_repeat_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_beat_repeat_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_beat_repeat_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_beat_repeat_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_executable(native_beat_scatter_processor_tests
    tests/native_beat_scatter_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_beat_scatter_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_beat_scatter_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_beat_scatter_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_executable(native_roll_processor_tests
    tests/native_roll_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_roll_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_roll_processor_tests)
  if(MSVC)
  else()
    target_compile_options(native_roll_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_executable(native_tape_echo_processor_tests
    tests/native_tape_echo_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_tape_echo_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_tape_echo_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_tape_echo_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_executable(native_reverse_delay_processor_tests
    tests/native_reverse_delay_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_reverse_delay_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_reverse_delay_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_reverse_delay_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_executable(native_panning_delay_processor_tests
    tests/native_panning_delay_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_panning_delay_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_panning_delay_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_panning_delay_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_mod_delay_processor_tests
    tests/native_mod_delay_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_mod_delay_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_mod_delay_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_mod_delay_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_stereo_enhance_processor_tests
    tests/native_stereo_enhance_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_stereo_enhance_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_stereo_enhance_processor_tests)

  add_executable(native_radio_processor_tests
    tests/native_radio_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_radio_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_radio_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_radio_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_sustainer_processor_tests
    tests/native_sustainer_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_sustainer_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_sustainer_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_sustainer_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_vibrato_processor_tests
    tests/native_vibrato_processor_tests.cpp
    tests/native_alloc_tracker.cpp
  )
  target_link_libraries(native_vibrato_processor_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_vibrato_processor_tests)
  if(NOT MSVC)
    target_compile_options(native_vibrato_processor_tests PRIVATE -Wno-mismatched-new-delete)
  endif()

  add_executable(native_rhythm_tests tests/native_rhythm_tests.cpp)
  target_link_libraries(native_rhythm_tests PRIVATE native_dsp_portable)
  enable_strict_warnings(native_rhythm_tests)

  add_executable(native_rhythm_event_dump EXCLUDE_FROM_ALL tests/native_rhythm_event_dump.cpp)
  target_link_libraries(native_rhythm_event_dump PRIVATE native_dsp_portable)
  enable_strict_warnings(native_rhythm_event_dump)

  if(NATIVE_ENABLE_RUBBERBAND_HQ)
    add_executable(native_rubberband_renderer_tests tests/native_rubberband_renderer_tests.cpp)
    target_link_libraries(native_rubberband_renderer_tests PRIVATE native_dsp_portable)
    enable_strict_warnings(native_rubberband_renderer_tests)
  endif()

  add_executable(native_audio_bench EXCLUDE_FROM_ALL tests/native_audio_bench.cpp)
  target_link_libraries(native_audio_bench PRIVATE native_dsp_portable)
  enable_strict_warnings(native_audio_bench)

  add_executable(native_performance_soak EXCLUDE_FROM_ALL tests/native_performance_soak.cpp tests/native_alloc_tracker.cpp)
  target_link_libraries(native_performance_soak PRIVATE native_audio_core_test_support)
  add_executable(native_catalog_sanity_sweep EXCLUDE_FROM_ALL tests/native_catalog_sanity_sweep.cpp)
  target_link_libraries(native_catalog_sanity_sweep PRIVATE native_dsp_portable)
  add_executable(native_catalog_ab_probe EXCLUDE_FROM_ALL tests/native_catalog_ab_probe.cpp)
  target_link_libraries(native_catalog_ab_probe PRIVATE native_dsp_portable)
  add_executable(native_preamp_ab_probe EXCLUDE_FROM_ALL tests/native_preamp_ab_probe.cpp)
  target_link_libraries(native_preamp_ab_probe PRIVATE native_dsp_portable)
  add_executable(native_performance_matrix EXCLUDE_FROM_ALL tests/native_performance_matrix.cpp tests/native_alloc_tracker.cpp)
  target_link_libraries(native_performance_matrix PRIVATE native_audio_core_test_support)
  add_executable(native_per_track_fx_bench EXCLUDE_FROM_ALL tests/native_per_track_fx_bench.cpp)
  target_link_libraries(native_per_track_fx_bench PRIVATE native_audio_core_test_support)
  enable_strict_warnings(native_per_track_fx_bench)

  enable_testing()
  add_test(NAME looper_core_tests COMMAND looper_core_tests)
  add_test(NAME dsp_primitives_tests COMMAND dsp_primitives_tests)
  add_test(NAME native_audio_pipeline_tests COMMAND native_audio_pipeline_tests)
  add_test(NAME project_archive_codec_tests COMMAND project_archive_codec_tests)
  add_test(NAME native_fx_catalog_tests COMMAND native_fx_catalog_tests)
  add_test(NAME native_auto_riff_core_tests COMMAND native_auto_riff_core_tests)
  add_test(NAME native_vocoder_core_tests COMMAND native_vocoder_core_tests)
  add_test(NAME native_osc_voc_core_tests COMMAND native_osc_voc_core_tests)
  add_test(NAME native_osc_voc_processor_tests COMMAND native_osc_voc_processor_tests)
  add_test(NAME native_hrm_auto_core_tests COMMAND native_hrm_auto_core_tests)

  add_test(NAME native_robot_core_tests COMMAND native_robot_core_tests)
  add_test(NAME native_hrm_auto_processor_tests COMMAND native_hrm_auto_processor_tests)
  add_test(NAME native_osc_bot_core_tests COMMAND native_osc_bot_core_tests)
  add_test(NAME native_osc_bot_processor_tests COMMAND native_osc_bot_processor_tests)
  add_test(NAME native_synth_processor_tests COMMAND native_synth_processor_tests)
  add_test(NAME native_g2b_processor_tests COMMAND native_g2b_processor_tests)
  add_test(NAME native_manual_pan_processor_tests COMMAND native_manual_pan_processor_tests)
  add_test(NAME native_isolator_processor_tests COMMAND native_isolator_processor_tests)
  add_test(NAME native_slow_gear_processor_tests COMMAND native_slow_gear_processor_tests)
  add_test(NAME native_catalog_ack_tests COMMAND native_catalog_ack_tests)
  add_test(NAME native_audio_callback_tests COMMAND native_audio_callback_tests)
  add_test(NAME native_freeze_processor_tests COMMAND native_freeze_processor_tests)
  add_test(NAME native_catalog_route_tests COMMAND native_catalog_route_tests)
  add_test(NAME native_pitch_processor_tests COMMAND native_pitch_processor_tests)
  add_test(NAME native_poly_pitch_processor_tests COMMAND native_poly_pitch_processor_tests)
  add_test(NAME native_chorus_processor_tests COMMAND native_chorus_processor_tests)
  add_test(NAME native_phaser_processor_tests COMMAND native_phaser_processor_tests)
  add_test(NAME native_autopan_processor_tests COMMAND native_autopan_processor_tests)
  add_test(NAME native_vinyl_flick_processor_tests COMMAND native_vinyl_flick_processor_tests)
  add_test(NAME native_flanger_processor_tests COMMAND native_flanger_processor_tests)
  add_test(NAME native_dynamics_processor_tests COMMAND native_dynamics_processor_tests)
  add_test(NAME native_fdn16_reverb_processor_tests COMMAND native_fdn16_reverb_processor_tests)
  add_test(NAME native_distortion_processor_tests COMMAND native_distortion_processor_tests)
  add_test(NAME native_preamp_processor_tests COMMAND native_preamp_processor_tests)
  add_test(NAME native_beat_repeat_processor_tests COMMAND native_beat_repeat_processor_tests)
  add_test(NAME native_roll_processor_tests COMMAND native_roll_processor_tests)
  add_test(NAME native_beat_scatter_processor_tests COMMAND native_beat_scatter_processor_tests)
  add_test(NAME native_tape_echo_processor_tests COMMAND native_tape_echo_processor_tests)
  add_test(NAME native_reverse_delay_processor_tests COMMAND native_reverse_delay_processor_tests)
  add_test(NAME native_panning_delay_processor_tests COMMAND native_panning_delay_processor_tests)
  add_test(NAME native_mod_delay_processor_tests COMMAND native_mod_delay_processor_tests)
  add_test(NAME native_stereo_enhance_processor_tests COMMAND native_stereo_enhance_processor_tests)
  add_test(NAME native_radio_processor_tests COMMAND native_radio_processor_tests)
  add_test(NAME native_sustainer_processor_tests COMMAND native_sustainer_processor_tests)
  add_test(NAME native_vibrato_processor_tests COMMAND native_vibrato_processor_tests)
  add_test(NAME native_rhythm_tests COMMAND native_rhythm_tests)
  add_signalsmith_notice_test(native_third_party_notices "${SIGNALSMITH_THIRD_PARTY_BUILD}")
  if(NATIVE_ENABLE_RUBBERBAND_HQ)
    add_test(NAME native_rubberband_renderer_tests COMMAND native_rubberband_renderer_tests)
    add_test(NAME native_rubberband_license_notice
      COMMAND ${CMAKE_COMMAND}
        "-DSOURCE=${RUBBERBAND_COPYING_SOURCE}"
        "-DBUILD=${RUBBERBAND_THIRD_PARTY_BUILD}/COPYING"
        -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/verify_exact_copy.cmake"
    )
  endif()
  enable_assertions_for_test_executables()
  return()
endif()

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

set(RTAUDIO_BUILD_STATIC_LIBS ON CACHE BOOL "" FORCE)
set(RTAUDIO_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

FetchContent_MakeAvailable(rtaudio_src httplib_src)

# Copy the exact upstream license files used by this configure into a single
# build-tree bundle. Executable post-build rules place this bundle next to the
# resulting Native host, so static linking retains the required notices.
set(RTAUDIO_THIRD_PARTY_BUILD "${CMAKE_BINARY_DIR}/THIRD_PARTY/rtaudio")
set(HTTPLIB_THIRD_PARTY_BUILD "${CMAKE_BINARY_DIR}/THIRD_PARTY/cpp-httplib")
set(JSON_THIRD_PARTY_BUILD "${CMAKE_BINARY_DIR}/THIRD_PARTY/nlohmann-json")
file(MAKE_DIRECTORY "${RTAUDIO_THIRD_PARTY_BUILD}" "${HTTPLIB_THIRD_PARTY_BUILD}" "${JSON_THIRD_PARTY_BUILD}")
configure_file("${rtaudio_src_SOURCE_DIR}/LICENSE" "${RTAUDIO_THIRD_PARTY_BUILD}/LICENSE" COPYONLY)
configure_file("${httplib_src_SOURCE_DIR}/LICENSE" "${HTTPLIB_THIRD_PARTY_BUILD}/LICENSE" COPYONLY)
configure_file("${json_src_SOURCE_DIR}/LICENSE.MIT" "${JSON_THIRD_PARTY_BUILD}/LICENSE.MIT" COPYONLY)
configure_file("${PROJECT_GPL_LICENSE}" "${CMAKE_BINARY_DIR}/LICENSE" COPYONLY)
configure_file("${PROJECT_THIRD_PARTY_NOTICE_INDEX}" "${CMAKE_BINARY_DIR}/THIRD_PARTY_NOTICES.md" COPYONLY)

if(NATIVE_BRIDGE_SIMULATION_ONLY)
  if(WIN32)
    message(STATUS "NATIVE_BRIDGE_SIMULATION_ONLY is a headless test adapter; use the regular host target for Windows audio")
  endif()

  add_library(native_audio_core_simulation STATIC
    src/looper_core.cpp
    src/dsp_primitives.cpp
    src/native_output_stage.cpp
    src/native_fdn16_reverb_processor.cpp
    src/native_distortion_processor.cpp
    src/native_preamp_processor.cpp
    src/native_beat_repeat_processor.cpp
    src/native_roll_processor.cpp
    src/native_freeze_processor.cpp
    src/native_beat_scatter_processor.cpp
    src/native_tape_echo_processor.cpp
    src/native_reverse_delay_processor.cpp
    src/native_panning_delay_processor.cpp
    src/native_mod_delay_processor.cpp
    src/native_chorus_processor.cpp
    src/native_phaser_processor.cpp
    src/native_autopan_processor.cpp
    src/native_vinyl_flick_processor.cpp
    src/native_dynamics_processor.cpp
    src/native_flanger_processor.cpp
    src/native_stereo_enhance_processor.cpp
    src/native_fx_catalog.cpp
    src/native_electric_processor.cpp
    src/native_g2b_processor.cpp
    src/native_rhythm_engine.cpp
    src/native_pitch_processor.cpp
    src/native_poly_pitch_processor.cpp
    src/native_auto_riff_core.cpp
    src/native_hrm_auto_core.cpp
    src/native_hrm_auto_processor.cpp
    src/native_robot_core.cpp
    src/native_vocoder_core.cpp
    src/native_osc_voc_core.cpp
    src/native_osc_voc_processor.cpp
    src/native_osc_bot_core.cpp
    src/native_osc_bot_processor.cpp
    src/native_audio_core.cpp
  )
  target_include_directories(native_audio_core_simulation BEFORE PUBLIC tests/simulation_support include)
  target_include_directories(native_audio_core_simulation SYSTEM PUBLIC third_party/signalsmith/include)
  target_link_libraries(native_audio_core_simulation PUBLIC native_project_archive_codec)
  enable_native_preamp_experimental_adaa(native_audio_core_simulation)
  enable_rubberband_hq(native_audio_core_simulation)

  add_executable(project_archive_codec_tests tests/project_archive_codec_tests.cpp)
  target_link_libraries(project_archive_codec_tests PRIVATE native_project_archive_codec)
  enable_strict_warnings(project_archive_codec_tests)

  add_executable(native_catalog_ack_tests tests/native_catalog_ack_tests.cpp)
  target_link_libraries(native_catalog_ack_tests PRIVATE native_audio_core_simulation)
  enable_strict_warnings(native_catalog_ack_tests)
  add_executable(native_track_mark_tests tests/native_audio_callback_tests.cpp)
  target_link_libraries(native_track_mark_tests PRIVATE native_audio_core_simulation)
  target_compile_definitions(native_track_mark_tests PRIVATE NATIVE_TRACK_MARK_TESTS_ONLY=1)
  if(MSVC)
  else()
    target_compile_options(native_track_mark_tests PRIVATE -Wno-mismatched-new-delete)
  endif()
  add_executable(native_bridge_host_simulation src/native_bridge_host.cpp)
  target_link_libraries(native_bridge_host_simulation PRIVATE
    native_audio_core_simulation
    httplib::httplib
    nlohmann_json::nlohmann_json
  )
  target_compile_definitions(native_bridge_host_simulation PRIVATE NATIVE_BRIDGE_SIMULATION_ONLY=1)
  copy_native_notices_next_to(native_bridge_host_simulation)

  find_package(Python3 COMPONENTS Interpreter REQUIRED)
  enable_testing()
  add_test(NAME native_catalog_ack_tests COMMAND native_catalog_ack_tests)
  add_test(NAME native_track_mark_tests COMMAND native_track_mark_tests)
  add_test(NAME project_archive_codec_tests COMMAND project_archive_codec_tests)
  add_test(
    NAME native_bridge_http_simulation
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native_bridge_http_simulation_test.py
      $<TARGET_FILE:native_bridge_host_simulation>
  )
  add_test(NAME native_official_fx_http_simulation
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/native_official_fx_http_simulation_test.py
      $<TARGET_FILE:native_bridge_host_simulation>)
  set_tests_properties(native_bridge_http_simulation native_official_fx_http_simulation PROPERTIES RUN_SERIAL TRUE)
  add_test(NAME native_third_party_notices
    COMMAND ${CMAKE_COMMAND}
      "-DSIGNALSMITH_SOURCE_DIR=${SIGNALSMITH_THIRD_PARTY_SOURCE}"
      "-DRTAUDIO_SOURCE_DIR=${rtaudio_src_SOURCE_DIR}"
      "-DHTTPLIB_SOURCE_DIR=${httplib_src_SOURCE_DIR}"
      "-DJSON_SOURCE_DIR=${json_src_SOURCE_DIR}"
      "-DPROJECT_LICENSE_SOURCE=${PROJECT_GPL_LICENSE}"
      "-DOUTPUT_DIR=$<TARGET_FILE_DIR:native_bridge_host_simulation>"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/verify_native_distribution_notices.cmake"
  )
  if(NATIVE_ENABLE_RUBBERBAND_HQ)
    add_test(NAME native_rubberband_license_notice
      COMMAND ${CMAKE_COMMAND}
        "-DSOURCE=${RUBBERBAND_COPYING_SOURCE}"
        "-DBUILD=$<TARGET_FILE_DIR:native_bridge_host_simulation>/THIRD_PARTY/rubberband/COPYING"
        -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/verify_exact_copy.cmake"
    )
  endif()
  enable_assertions_for_test_executables()
  return()
endif()

if(WIN32)
  target_compile_definitions(rtaudio PUBLIC RTAUDIO_API_WASAPI)
  target_link_libraries(rtaudio ole32 winmm ksuser avrt uuid user32)
endif()

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
  src/dsp_primitives.cpp
  src/native_output_stage.cpp
  src/native_fdn16_reverb_processor.cpp
  src/native_distortion_processor.cpp
  src/native_preamp_processor.cpp
  src/native_beat_repeat_processor.cpp
  src/native_roll_processor.cpp
  src/native_freeze_processor.cpp
  src/native_beat_scatter_processor.cpp
  src/native_tape_echo_processor.cpp
  src/native_reverse_delay_processor.cpp
  src/native_panning_delay_processor.cpp
  src/native_mod_delay_processor.cpp
  src/native_chorus_processor.cpp
  src/native_phaser_processor.cpp
  src/native_autopan_processor.cpp
  src/native_vinyl_flick_processor.cpp
  src/native_dynamics_processor.cpp
  src/native_flanger_processor.cpp
  src/native_stereo_enhance_processor.cpp
  src/native_fx_catalog.cpp
  src/native_electric_processor.cpp
  src/native_g2b_processor.cpp
  src/native_rhythm_engine.cpp
  src/native_pitch_processor.cpp
  src/native_poly_pitch_processor.cpp
  src/native_auto_riff_core.cpp
  src/native_hrm_auto_core.cpp
  src/native_hrm_auto_processor.cpp
  src/native_robot_core.cpp
  src/native_vocoder_core.cpp
  src/native_osc_voc_core.cpp
  src/native_osc_voc_processor.cpp
  src/native_osc_bot_core.cpp
  src/native_osc_bot_processor.cpp
  src/native_audio_core.cpp
)
target_include_directories(native_audio_core PUBLIC include)
target_include_directories(native_audio_core SYSTEM PUBLIC third_party/signalsmith/include)
target_link_libraries(native_audio_core PUBLIC rtaudio nlohmann_json::nlohmann_json native_project_archive_codec)
enable_native_preamp_experimental_adaa(native_audio_core)
enable_rubberband_hq(native_audio_core)

add_executable(native_bridge_host src/native_bridge_host.cpp)
target_link_libraries(native_bridge_host PRIVATE native_audio_core httplib::httplib nlohmann_json::nlohmann_json)
copy_native_notices_next_to(native_bridge_host)
if(WIN32)
  target_link_libraries(native_bridge_host PRIVATE ws2_32)
endif()

add_executable(looper_core_tests
  tests/looper_core_tests.cpp
  src/looper_core.cpp
  src/dsp_primitives.cpp
)
target_include_directories(looper_core_tests PRIVATE include)

add_executable(dsp_primitives_tests tests/dsp_primitives_tests.cpp src/dsp_primitives.cpp)
target_include_directories(dsp_primitives_tests PRIVATE include)

add_executable(native_official_fx_parameters_tests
  tests/native_official_fx_parameters_tests.cpp tests/native_alloc_tracker.cpp)
target_link_libraries(native_official_fx_parameters_tests PRIVATE native_audio_core)
enable_strict_warnings(native_official_fx_parameters_tests)
if(NOT MSVC)
  target_compile_options(native_official_fx_parameters_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_official_fx_parameters_tests COMMAND native_official_fx_parameters_tests)
add_executable(native_official_vocoder_controls_tests
  tests/native_official_vocoder_controls_tests.cpp tests/native_alloc_tracker.cpp)
target_link_libraries(native_official_vocoder_controls_tests PRIVATE native_audio_core)
enable_strict_warnings(native_official_vocoder_controls_tests)
if(NOT MSVC)
  target_compile_options(native_official_vocoder_controls_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_official_vocoder_controls_tests COMMAND native_official_vocoder_controls_tests)
add_executable(native_official_amp_dynamics_tests
  tests/native_official_amp_dynamics_tests.cpp tests/native_alloc_tracker.cpp)
target_link_libraries(native_official_amp_dynamics_tests PRIVATE native_audio_core)
enable_strict_warnings(native_official_amp_dynamics_tests)
if(NOT MSVC)
  target_compile_options(native_official_amp_dynamics_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_official_amp_dynamics_tests COMMAND native_official_amp_dynamics_tests)
add_executable(native_official_pitch_controls_tests
  tests/native_official_pitch_controls_tests.cpp tests/native_alloc_tracker.cpp)
target_link_libraries(native_official_pitch_controls_tests PRIVATE native_audio_core)
enable_strict_warnings(native_official_pitch_controls_tests)
if(NOT MSVC)
  target_compile_options(native_official_pitch_controls_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_official_pitch_controls_tests COMMAND native_official_pitch_controls_tests)

add_executable(native_audio_pipeline_tests
  tests/native_audio_pipeline_tests.cpp
  src/looper_core.cpp
  src/dsp_primitives.cpp
  src/native_output_stage.cpp
  src/native_fdn16_reverb_processor.cpp
  src/native_distortion_processor.cpp
  src/native_preamp_processor.cpp
  src/native_beat_repeat_processor.cpp
  src/native_roll_processor.cpp
  src/native_freeze_processor.cpp
  src/native_beat_scatter_processor.cpp
  src/native_tape_echo_processor.cpp
  src/native_reverse_delay_processor.cpp
  src/native_panning_delay_processor.cpp
  src/native_mod_delay_processor.cpp
  src/native_chorus_processor.cpp
  src/native_phaser_processor.cpp
  src/native_autopan_processor.cpp
  src/native_vinyl_flick_processor.cpp
  src/native_dynamics_processor.cpp
  src/native_flanger_processor.cpp
  src/native_stereo_enhance_processor.cpp
  src/native_fx_catalog.cpp
  src/native_electric_processor.cpp
  src/native_g2b_processor.cpp
  src/native_rhythm_engine.cpp
  src/native_pitch_processor.cpp
  src/native_poly_pitch_processor.cpp
  src/native_auto_riff_core.cpp
  src/native_hrm_auto_core.cpp
  src/native_hrm_auto_processor.cpp
  src/native_robot_core.cpp
  src/native_vocoder_core.cpp
  src/native_osc_voc_core.cpp
  src/native_osc_voc_processor.cpp
  src/native_osc_bot_core.cpp
  src/native_osc_bot_processor.cpp
)
target_include_directories(native_audio_pipeline_tests PRIVATE include)
target_include_directories(native_audio_pipeline_tests SYSTEM PRIVATE third_party/signalsmith/include)
enable_native_preamp_experimental_adaa(native_audio_pipeline_tests)

add_executable(native_rhythm_tests tests/native_rhythm_tests.cpp src/native_rhythm_engine.cpp)
target_include_directories(native_rhythm_tests PRIVATE include)

add_executable(native_rhythm_event_dump EXCLUDE_FROM_ALL tests/native_rhythm_event_dump.cpp src/native_rhythm_engine.cpp)
target_include_directories(native_rhythm_event_dump PRIVATE include)
enable_strict_warnings(native_rhythm_event_dump)

add_executable(native_pitch_processor_tests
  tests/native_pitch_processor_tests.cpp
  tests/native_alloc_tracker.cpp
  src/native_pitch_processor.cpp
)
target_include_directories(native_pitch_processor_tests PRIVATE include)

add_executable(native_poly_pitch_processor_tests
  tests/native_poly_pitch_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_poly_pitch_processor_tests PRIVATE native_audio_core)
if(NOT MSVC)
  target_compile_options(native_poly_pitch_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()

add_executable(native_vocoder_core_tests
  tests/native_vocoder_core_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_vocoder_core_tests PRIVATE native_audio_core)
if(MSVC)
else()
  target_compile_options(native_vocoder_core_tests PRIVATE -Wno-mismatched-new-delete)
endif()

add_executable(native_osc_voc_core_tests
  tests/native_osc_voc_core_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_osc_voc_core_tests PRIVATE native_audio_core)
if(MSVC)
else()
  target_compile_options(native_osc_voc_core_tests PRIVATE -Wno-mismatched-new-delete)
endif()

add_executable(native_osc_voc_processor_tests
  tests/native_osc_voc_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_osc_voc_processor_tests PRIVATE native_audio_core)
if(MSVC)
else()
  target_compile_options(native_osc_voc_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()

add_executable(native_osc_bot_core_tests
  tests/native_osc_bot_core_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_osc_bot_core_tests PRIVATE native_audio_core)
if(MSVC)
else()
  target_compile_options(native_osc_bot_core_tests PRIVATE -Wno-mismatched-new-delete)
endif()

add_executable(native_osc_bot_processor_tests
  tests/native_osc_bot_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_osc_bot_processor_tests PRIVATE native_audio_core)
if(MSVC)
else()
  target_compile_options(native_osc_bot_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()

add_executable(native_audio_callback_tests tests/native_audio_callback_tests.cpp)
target_link_libraries(native_audio_callback_tests PRIVATE native_audio_core)
if(NOT MSVC)
  target_compile_options(native_audio_callback_tests PRIVATE -Wno-mismatched-new-delete)
endif()

add_executable(native_track_mark_tests tests/native_audio_callback_tests.cpp)
target_link_libraries(native_track_mark_tests PRIVATE native_audio_core)
target_compile_definitions(native_track_mark_tests PRIVATE NATIVE_TRACK_MARK_TESTS_ONLY=1)
if(MSVC)
else()
  target_compile_options(native_track_mark_tests PRIVATE -Wno-mismatched-new-delete)
endif()

add_executable(native_isolator_processor_tests
  tests/native_isolator_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_isolator_processor_tests PRIVATE native_audio_core)
if(MSVC)
  target_compile_options(native_isolator_processor_tests PRIVATE /W4 /WX)
else()
  target_compile_options(native_isolator_processor_tests PRIVATE -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete)
endif()
add_test(NAME native_isolator_processor_tests COMMAND native_isolator_processor_tests)

add_executable(dsp_primitives_bench EXCLUDE_FROM_ALL tests/dsp_primitives_bench.cpp src/dsp_primitives.cpp)
target_include_directories(dsp_primitives_bench PRIVATE include)

add_executable(native_audio_bench EXCLUDE_FROM_ALL tests/native_audio_bench.cpp)
target_link_libraries(native_audio_bench PRIVATE native_audio_core)

add_executable(native_per_track_fx_bench EXCLUDE_FROM_ALL tests/native_per_track_fx_bench.cpp)
target_link_libraries(native_per_track_fx_bench PRIVATE native_audio_core)
enable_strict_warnings(native_per_track_fx_bench)

enable_testing()
add_test(NAME looper_core_tests COMMAND looper_core_tests)
add_test(NAME dsp_primitives_tests COMMAND dsp_primitives_tests)
add_test(NAME native_audio_pipeline_tests COMMAND native_audio_pipeline_tests)
add_executable(project_archive_codec_tests tests/project_archive_codec_tests.cpp)
target_link_libraries(project_archive_codec_tests PRIVATE native_project_archive_codec)
enable_strict_warnings(project_archive_codec_tests)
add_test(NAME project_archive_codec_tests COMMAND project_archive_codec_tests)
add_test(NAME native_audio_callback_tests COMMAND native_audio_callback_tests)
add_test(NAME native_track_mark_tests COMMAND native_track_mark_tests)
add_executable(native_chorus_processor_tests
  tests/native_chorus_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_chorus_processor_tests PRIVATE native_audio_core)
add_test(NAME native_chorus_processor_tests COMMAND native_chorus_processor_tests)
add_executable(native_phaser_processor_tests
  tests/native_phaser_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_phaser_processor_tests PRIVATE native_audio_core)
add_test(NAME native_phaser_processor_tests COMMAND native_phaser_processor_tests)
add_executable(native_autopan_processor_tests
  tests/native_autopan_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_autopan_processor_tests PRIVATE native_audio_core)
add_test(NAME native_autopan_processor_tests COMMAND native_autopan_processor_tests)
add_executable(native_flanger_processor_tests
  tests/native_flanger_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_flanger_processor_tests PRIVATE native_audio_core)
if(NOT MSVC)
  target_compile_options(native_flanger_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_flanger_processor_tests COMMAND native_flanger_processor_tests)
add_executable(native_dynamics_processor_tests
  tests/native_dynamics_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_dynamics_processor_tests PRIVATE native_audio_core)
if(NOT MSVC)
  target_compile_options(native_dynamics_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_dynamics_processor_tests COMMAND native_dynamics_processor_tests)
add_executable(native_fdn16_reverb_processor_tests
  tests/native_fdn16_reverb_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_fdn16_reverb_processor_tests PRIVATE native_audio_core)
if(NOT MSVC)
  target_compile_options(native_fdn16_reverb_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_fdn16_reverb_processor_tests COMMAND native_fdn16_reverb_processor_tests)
add_executable(native_distortion_processor_tests
  tests/native_distortion_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_distortion_processor_tests PRIVATE native_audio_core)
if(NOT MSVC)
  target_compile_options(native_distortion_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_distortion_processor_tests COMMAND native_distortion_processor_tests)
add_executable(native_preamp_processor_tests
  tests/native_preamp_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_preamp_processor_tests PRIVATE native_audio_core)
if(MSVC)
else()
  target_compile_options(native_preamp_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_preamp_processor_tests COMMAND native_preamp_processor_tests)
add_executable(native_beat_repeat_processor_tests
  tests/native_beat_repeat_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_beat_repeat_processor_tests PRIVATE native_audio_core)
if(NOT MSVC)
  target_compile_options(native_beat_repeat_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_beat_repeat_processor_tests COMMAND native_beat_repeat_processor_tests)
add_executable(native_roll_processor_tests
  tests/native_roll_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_roll_processor_tests PRIVATE native_audio_core)
if(MSVC)
  target_compile_options(native_roll_processor_tests PRIVATE /W4 /WX)
else()
  target_compile_options(native_roll_processor_tests PRIVATE
    -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete
  )
endif()
add_test(NAME native_roll_processor_tests COMMAND native_roll_processor_tests)
add_executable(native_freeze_processor_tests
  tests/native_freeze_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_freeze_processor_tests PRIVATE native_audio_core)
if(MSVC)
  target_compile_options(native_freeze_processor_tests PRIVATE /W4 /WX)
else()
  target_compile_options(native_freeze_processor_tests PRIVATE
    -Wall -Wextra -Wpedantic -Werror -Wno-mismatched-new-delete
  )
endif()
add_test(NAME native_freeze_processor_tests COMMAND native_freeze_processor_tests)
add_executable(native_beat_scatter_processor_tests
  tests/native_beat_scatter_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_beat_scatter_processor_tests PRIVATE native_audio_core)
if(NOT MSVC)
  target_compile_options(native_beat_scatter_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_beat_scatter_processor_tests COMMAND native_beat_scatter_processor_tests)
add_executable(native_tape_echo_processor_tests
  tests/native_tape_echo_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_tape_echo_processor_tests PRIVATE native_audio_core)
if(NOT MSVC)
  target_compile_options(native_tape_echo_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_tape_echo_processor_tests COMMAND native_tape_echo_processor_tests)
add_executable(native_reverse_delay_processor_tests
  tests/native_reverse_delay_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_reverse_delay_processor_tests PRIVATE native_audio_core)
if(NOT MSVC)
  target_compile_options(native_reverse_delay_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_reverse_delay_processor_tests COMMAND native_reverse_delay_processor_tests)
add_executable(native_panning_delay_processor_tests
  tests/native_panning_delay_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_panning_delay_processor_tests PRIVATE native_audio_core)
if(NOT MSVC)
  target_compile_options(native_panning_delay_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_panning_delay_processor_tests COMMAND native_panning_delay_processor_tests)
add_executable(native_mod_delay_processor_tests
  tests/native_mod_delay_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_mod_delay_processor_tests PRIVATE native_audio_core)
if(NOT MSVC)
  target_compile_options(native_mod_delay_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_mod_delay_processor_tests COMMAND native_mod_delay_processor_tests)
add_executable(native_vibrato_processor_tests
  tests/native_vibrato_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_vibrato_processor_tests PRIVATE native_audio_core)
if(NOT MSVC)
  target_compile_options(native_vibrato_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_vibrato_processor_tests COMMAND native_vibrato_processor_tests)
add_executable(native_slow_gear_processor_tests
  tests/native_slow_gear_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_slow_gear_processor_tests PRIVATE native_audio_core)
if(MSVC)
else()
  target_compile_options(native_slow_gear_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_slow_gear_processor_tests COMMAND native_slow_gear_processor_tests)
add_test(NAME native_rhythm_tests COMMAND native_rhythm_tests)
add_test(NAME native_pitch_processor_tests COMMAND native_pitch_processor_tests)
add_test(NAME native_poly_pitch_processor_tests COMMAND native_poly_pitch_processor_tests)
add_test(NAME native_vocoder_core_tests COMMAND native_vocoder_core_tests)
add_test(NAME native_osc_voc_core_tests COMMAND native_osc_voc_core_tests)
add_test(NAME native_osc_voc_processor_tests COMMAND native_osc_voc_processor_tests)
add_test(NAME native_osc_bot_core_tests COMMAND native_osc_bot_core_tests)
add_test(NAME native_osc_bot_processor_tests COMMAND native_osc_bot_processor_tests)
add_executable(native_auto_riff_core_tests
  tests/native_auto_riff_core_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_auto_riff_core_tests PRIVATE native_audio_core)
if(MSVC)
else()
  target_compile_options(native_auto_riff_core_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_auto_riff_core_tests COMMAND native_auto_riff_core_tests)

add_executable(native_hrm_auto_processor_tests
  tests/native_hrm_auto_processor_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_hrm_auto_processor_tests PRIVATE native_audio_core)
if(MSVC)
else()
  target_compile_options(native_hrm_auto_processor_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_hrm_auto_processor_tests COMMAND native_hrm_auto_processor_tests)

add_executable(native_hrm_auto_core_tests
  tests/native_hrm_auto_core_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_hrm_auto_core_tests PRIVATE native_audio_core)
if(MSVC)
else()
  target_compile_options(native_hrm_auto_core_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_hrm_auto_core_tests COMMAND native_hrm_auto_core_tests)
add_executable(native_robot_core_tests
  tests/native_robot_core_tests.cpp
  tests/native_alloc_tracker.cpp
)
target_link_libraries(native_robot_core_tests PRIVATE native_audio_core)
if(MSVC)
else()
  target_compile_options(native_robot_core_tests PRIVATE -Wno-mismatched-new-delete)
endif()
add_test(NAME native_robot_core_tests COMMAND native_robot_core_tests)
add_test(NAME native_third_party_notices
  COMMAND ${CMAKE_COMMAND}
    "-DSIGNALSMITH_SOURCE_DIR=${SIGNALSMITH_THIRD_PARTY_SOURCE}"
    "-DRTAUDIO_SOURCE_DIR=${rtaudio_src_SOURCE_DIR}"
    "-DHTTPLIB_SOURCE_DIR=${httplib_src_SOURCE_DIR}"
    "-DJSON_SOURCE_DIR=${json_src_SOURCE_DIR}"
    "-DPROJECT_LICENSE_SOURCE=${PROJECT_GPL_LICENSE}"
    "-DOUTPUT_DIR=$<TARGET_FILE_DIR:native_bridge_host>"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/verify_native_distribution_notices.cmake"
)
if(NATIVE_ENABLE_RUBBERBAND_HQ)
  add_executable(native_rubberband_renderer_tests
    tests/native_rubberband_renderer_tests.cpp
  )
  target_link_libraries(native_rubberband_renderer_tests PRIVATE native_audio_core)
  if(MSVC)
    target_compile_options(native_rubberband_renderer_tests PRIVATE /W4 /WX)
  else()
    target_compile_options(native_rubberband_renderer_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  endif()
  add_test(NAME native_rubberband_renderer_tests COMMAND native_rubberband_renderer_tests)
  add_test(NAME native_rubberband_license_notice
    COMMAND ${CMAKE_COMMAND}
      "-DSOURCE=${RUBBERBAND_COPYING_SOURCE}"
      "-DBUILD=$<TARGET_FILE_DIR:native_bridge_host>/THIRD_PARTY/rubberband/COPYING"
      -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/verify_exact_copy.cmake"
  )
endif()

enable_assertions_for_test_executables()
