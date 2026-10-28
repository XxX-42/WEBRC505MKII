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
    // Immutable original take tempo when known; nullopt means unknown. This is
    // archive metadata only and does not claim that Native captured it live.
    std::optional<double> originalTempoBpm;
    // Interleaved Float32 PCM in frame-major order. Mono tracks have one value
    // per frame; stereo tracks have left then right for each frame.
    std::vector<float> pcm;
};

struct DecodedProjectArchive {
    std::uint32_t version = 2U;
    std::string name;
    double bpm = 120.0;
    ProjectArchiveTransportMetadata transport{};
    std::array<std::optional<ProjectArchiveTrackData>, kProjectArchiveTrackCount> tracks{};
    std::uint64_t payloadByteLength = 0U;
};

/** Encode a validated v2 archive. Throws std::invalid_argument on invalid data. */
[[nodiscard]] std::vector<std::uint8_t> encodeProjectArchive(const DecodedProjectArchive& project);

struct ProjectArchiveDecodeResult {
    std::optional<DecodedProjectArchive> project;
    std::string error;

    [[nodiscard]] explicit operator bool() const noexcept { return project.has_value(); }
};

/**
 * Decode and validate exact v1/v2 binary formats written by src/audio/projectArchive.ts.
 * Returned PCM is owned by the result. This codec does not resample or apply
 * Native engine-rate/duration admission policy. V1 track tempo is unknown;
 * v2 carries nullable archive metadata but does not prove Native capture provenance.
 */
[[nodiscard]] ProjectArchiveDecodeResult decodeProjectArchive(
    const std::uint8_t* bytes,
    std::size_t byteLength
) noexcept;

[[nodiscard]] ProjectArchiveDecodeResult decodeProjectArchive(
    const std::vector<std::uint8_t>& bytes
) noexcept;

} // namespace webrc::native
