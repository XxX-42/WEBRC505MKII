#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace webrc::native {

inline constexpr std::size_t kProjectArchiveTrackCount = 5U;
inline constexpr std::uint64_t kProjectArchiveMaxPayloadBytes = 768ULL * 1024ULL * 1024ULL;
inline constexpr std::uint64_t kProjectArchiveMaxManifestBytes = 64ULL * 1024ULL;
inline constexpr std::uint64_t kProjectArchiveHeaderBytes = 12ULL;
inline constexpr std::uint64_t kProjectArchiveMaxBytes =
    kProjectArchiveMaxPayloadBytes + kProjectArchiveMaxManifestBytes + kProjectArchiveHeaderBytes;

struct ProjectArchiveTransportMetadata {
    std::optional<std::uint8_t> masterTrackId;
    double measureLengthSeconds = 0.0;
    std::uint64_t masterLoopLengthSamples = 0U;
    std::uint8_t timeSignatureNumerator = 4U;
    std::uint8_t timeSignatureDenominator = 4U;
};

struct ProjectArchiveTrackData {
    std::uint32_t sampleRate = 0U;
    std::uint64_t frameCount = 0U;
    std::uint8_t channels = 0U;
    // Interleaved Float32 PCM in frame-major order. Mono tracks have one value
    // per frame; stereo tracks have left then right for each frame.
    std::vector<float> pcm;
};

struct DecodedProjectArchive {
    std::uint32_t version = 1U;
    std::string name;
    double bpm = 120.0;
    ProjectArchiveTransportMetadata transport{};
    std::array<std::optional<ProjectArchiveTrackData>, kProjectArchiveTrackCount> tracks{};
    std::uint64_t payloadByteLength = 0U;
};

struct ProjectArchiveDecodeResult {
    std::optional<DecodedProjectArchive> project;
    std::string error;

    [[nodiscard]] explicit operator bool() const noexcept { return project.has_value(); }
};

/**
 * Decode and validate the exact v1 binary format written by src/audio/projectArchive.ts.
 * Returned PCM is owned by the result. This codec does not resample or apply
 * Native engine-rate/duration admission policy.
 */
[[nodiscard]] ProjectArchiveDecodeResult decodeProjectArchive(
    const std::uint8_t* bytes,
    std::size_t byteLength
) noexcept;

[[nodiscard]] ProjectArchiveDecodeResult decodeProjectArchive(
    const std::vector<std::uint8_t>& bytes
) noexcept;

} // namespace webrc::native
