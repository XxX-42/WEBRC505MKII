foreach(required_var IN ITEMS SIGNALSMITH_SOURCE_DIR RTAUDIO_SOURCE_DIR HTTPLIB_SOURCE_DIR JSON_SOURCE_DIR PROJECT_LICENSE_SOURCE OUTPUT_DIR)
  if(NOT DEFINED ${required_var})
    message(FATAL_ERROR "${required_var} is required")
  endif()
endforeach()

function(assert_exact_copy source built description)
  if(NOT EXISTS "${source}")
    message(FATAL_ERROR "Missing upstream/source license for ${description}: ${source}")
  endif()
  if(NOT EXISTS "${built}")
    message(FATAL_ERROR "Missing distributed license for ${description}: ${built}")
  endif()
  file(SHA256 "${source}" source_hash)
  file(SHA256 "${built}" built_hash)
  if(NOT source_hash STREQUAL built_hash)
    message(FATAL_ERROR "Distributed license differs from exact upstream/source text: ${description}")
  endif()
endfunction()

assert_exact_copy("${PROJECT_LICENSE_SOURCE}" "${OUTPUT_DIR}/LICENSE" "GPL-3.0-or-later project license")
assert_exact_copy(
  "${CMAKE_CURRENT_LIST_DIR}/../../../THIRD_PARTY_NOTICES.md"
  "${OUTPUT_DIR}/THIRD_PARTY_NOTICES.md"
  "third-party license index"
)

foreach(name IN ITEMS NOTICE.md SIGNALSMITH_STRETCH_LICENSE.txt SIGNALSMITH_LINEAR_LICENSE.txt)
  assert_exact_copy(
    "${SIGNALSMITH_SOURCE_DIR}/${name}"
    "${OUTPUT_DIR}/THIRD_PARTY/signalsmith/${name}"
    "Signalsmith ${name}"
  )
endforeach()

assert_exact_copy("${RTAUDIO_SOURCE_DIR}/LICENSE" "${OUTPUT_DIR}/THIRD_PARTY/rtaudio/LICENSE" "RtAudio")
assert_exact_copy("${HTTPLIB_SOURCE_DIR}/LICENSE" "${OUTPUT_DIR}/THIRD_PARTY/cpp-httplib/LICENSE" "cpp-httplib")
assert_exact_copy("${JSON_SOURCE_DIR}/LICENSE.MIT" "${OUTPUT_DIR}/THIRD_PARTY/nlohmann-json/LICENSE.MIT" "nlohmann/json")

message(STATUS "Verified GPL project license and exact Native dependency license files at ${OUTPUT_DIR}")
