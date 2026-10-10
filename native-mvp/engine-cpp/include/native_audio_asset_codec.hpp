#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>
#include <vector>

namespace webrc::native {

enum class NativeWavEncoding : std::uint8_t {
    PcmInteger,
    IeeeFloat,
};

enum class NativeWavOutputFormat : std::uint8_t {
    Pcm16,
    Pcm24,
    Pcm32,
    Float32,
};

enum class NativeWavCodecStatus : std::uint8_t {
    Ok,
    InvalidArgument,
    InvalidContainer,
    TruncatedInput,
    InvalidChunk,
    DuplicateChunk,
    UnsupportedEncoding,
    InvalidFormat,
    InvalidChannelLayout,
    InvalidSampleData,
    NonFiniteSample,
    DecodeLimitExceeded,
    SizeOverflow,
    AllocationFailed,
};

// Samples are interleaved in WAVE order. A one-channel asset remains mono;
// callers that need a stereo track must explicitly duplicate or route it.
// A two-channel asset is laid out left, right and is never downmixed here.
struct NativeAudioAsset {
    std::uint32_t sampleRateHz = 0U;
    std::uint16_t channels = 0U;
    NativeWavEncoding sourceEncoding = NativeWavEncoding::PcmInteger;
    std::uint16_t sourceBitsPerSample = 0U;
    std::vector<float> interleavedSamples;

    [[nodiscard]] std::size_t frames() const noexcept {
        return channels == 0U ? 0U : interleavedSamples.size() / channels;
    }
};

struct NativeWavCodecResult {
    NativeWavCodecStatus status = NativeWavCodecStatus::InvalidArgument;
    std::uint32_t sampleRateHz = 0U;
    std::uint16_t channels = 0U;
    std::uint16_t bitsPerSample = 0U;
    NativeWavEncoding encoding = NativeWavEncoding::PcmInteger;
    std::uint64_t frames = 0U;
    std::uint64_t decodedSampleBytes = 0U;

    [[nodiscard]] bool ok() const noexcept { return status == NativeWavCodecStatus::Ok; }
};

// Limits count decoded float32 sample storage only. Container metadata and
// vector bookkeeping are separate small fixed costs for caller accounting.
// Defaults impose no codec-specific cap beyond addressable/vector capacity.
struct NativeWavDecodeLimits {
    std::uint64_t maxFrames = std::numeric_limits<std::uint64_t>::max();
    std::uint64_t maxDecodedBytes = std::numeric_limits<std::uint64_t>::max();
};

// Offline/control-thread WAVE codec. These functions allocate output storage;
// they must never be called from an audio callback. Destination objects are
// replaced only after the complete input/output has been validated.
class NativeAudioAssetCodec {
public:
    // Parses and validates RIFF/chunk/format/frame layout without allocating or
    // decoding sample payload. Float payload finiteness is checked by decodeWav.
    [[nodiscard]] static NativeWavCodecResult inspectWav(
        const std::uint8_t* bytes, std::size_t byteCount) noexcept;

    [[nodiscard]] static NativeWavCodecResult decodeWav(
        const std::uint8_t* bytes, std::size_t byteCount,
        NativeAudioAsset& destination,
        NativeWavDecodeLimits limits = {}) noexcept;

    [[nodiscard]] static NativeWavCodecResult encodeWav(
        const NativeAudioAsset& source, NativeWavOutputFormat outputFormat,
        std::vector<std::uint8_t>& destination) noexcept;
};

} // namespace webrc::native
