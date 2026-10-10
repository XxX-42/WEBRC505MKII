#include "native_audio_asset_codec.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <new>
#include <utility>

namespace webrc::native {
namespace {

static_assert(sizeof(float) == sizeof(std::uint32_t),
              "WAVE IEEE float support requires 32-bit float storage");
static_assert(std::numeric_limits<float>::is_iec559,
              "WAVE IEEE float support requires IEEE-754 float");

constexpr std::uint32_t kPcmFormat = 1U;
constexpr std::uint32_t kFloatFormat = 3U;
constexpr std::size_t kRiffHeaderBytes = 12U;
constexpr std::size_t kChunkHeaderBytes = 8U;

std::uint16_t readU16(const std::uint8_t* bytes) noexcept {
    return static_cast<std::uint16_t>(bytes[0]) |
           static_cast<std::uint16_t>(static_cast<std::uint16_t>(bytes[1]) << 8U);
}

std::uint32_t readU32(const std::uint8_t* bytes) noexcept {
    return static_cast<std::uint32_t>(bytes[0]) |
           (static_cast<std::uint32_t>(bytes[1]) << 8U) |
           (static_cast<std::uint32_t>(bytes[2]) << 16U) |
           (static_cast<std::uint32_t>(bytes[3]) << 24U);
}

void writeU16(std::uint8_t* bytes, std::uint16_t value) noexcept {
    bytes[0] = static_cast<std::uint8_t>(value & 0xffU);
    bytes[1] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
}

void writeU32(std::uint8_t* bytes, std::uint32_t value) noexcept {
    bytes[0] = static_cast<std::uint8_t>(value & 0xffU);
    bytes[1] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
    bytes[2] = static_cast<std::uint8_t>((value >> 16U) & 0xffU);
    bytes[3] = static_cast<std::uint8_t>((value >> 24U) & 0xffU);
}

bool hasId(const std::uint8_t* bytes, const char (&id)[5]) noexcept {
    return std::memcmp(bytes, id, 4U) == 0;
}

struct ParsedFormat {
    std::uint16_t channels = 0U;
    std::uint32_t sampleRateHz = 0U;
    std::uint32_t byteRate = 0U;
    std::uint16_t blockAlign = 0U;
    std::uint16_t bitsPerSample = 0U;
    NativeWavEncoding encoding = NativeWavEncoding::PcmInteger;
};

struct ParsedWav {
    ParsedFormat format{};
    const std::uint8_t* audioData = nullptr;
    std::size_t audioSize = 0U;
    std::uint64_t frameCount = 0U;
    std::uint64_t sampleCount = 0U;
    std::uint64_t decodedSampleBytes = 0U;
};

NativeWavCodecStatus parseFormat(const std::uint8_t* data, std::size_t size,
                                 ParsedFormat& format) noexcept {
    if (size < 16U) return NativeWavCodecStatus::InvalidFormat;
    const auto tag = readU16(data);
    format.channels = readU16(data + 2U);
    format.sampleRateHz = readU32(data + 4U);
    format.byteRate = readU32(data + 8U);
    format.blockAlign = readU16(data + 12U);
    format.bitsPerSample = readU16(data + 14U);

    if (tag == kPcmFormat) {
        format.encoding = NativeWavEncoding::PcmInteger;
    } else if (tag == kFloatFormat) {
        format.encoding = NativeWavEncoding::IeeeFloat;
    } else {
        return NativeWavCodecStatus::UnsupportedEncoding;
    }

    // Classic WAVEFORMAT is 16 bytes. If an extension length is present, it
    // must fit inside fmt; unrelated extension bytes are ignored.
    if (size != 16U) {
        if (size < 18U) return NativeWavCodecStatus::InvalidFormat;
        const auto extensionBytes = readU16(data + 16U);
        if (static_cast<std::uint64_t>(18U) + extensionBytes > size)
            return NativeWavCodecStatus::InvalidFormat;
    }

    if (format.channels != 1U && format.channels != 2U)
        return NativeWavCodecStatus::InvalidChannelLayout;
    if (format.sampleRateHz == 0U) return NativeWavCodecStatus::InvalidFormat;

    if (format.encoding == NativeWavEncoding::PcmInteger) {
        if (format.bitsPerSample != 16U && format.bitsPerSample != 24U &&
            format.bitsPerSample != 32U)
            return NativeWavCodecStatus::UnsupportedEncoding;
    } else if (format.bitsPerSample != 32U) {
        return NativeWavCodecStatus::UnsupportedEncoding;
    }

    const std::uint32_t bytesPerSample = format.bitsPerSample / 8U;
    const std::uint32_t expectedAlign =
        static_cast<std::uint32_t>(format.channels) * bytesPerSample;
    const std::uint64_t expectedByteRate =
        static_cast<std::uint64_t>(format.sampleRateHz) * expectedAlign;
    if (expectedAlign > std::numeric_limits<std::uint16_t>::max() ||
        format.blockAlign != expectedAlign ||
        expectedByteRate > std::numeric_limits<std::uint32_t>::max() ||
        format.byteRate != expectedByteRate)
        return NativeWavCodecStatus::InvalidFormat;

    return NativeWavCodecStatus::Ok;
}

std::int64_t decodePcmInteger(const std::uint8_t* sample,
                              std::uint16_t bits) noexcept {
    if (bits == 16U) {
        const auto raw = readU16(sample);
        return (raw & 0x8000U) != 0U
                   ? static_cast<std::int64_t>(raw) - 0x10000LL
                   : static_cast<std::int64_t>(raw);
    }
    if (bits == 24U) {
        std::uint32_t raw = static_cast<std::uint32_t>(sample[0]) |
                           (static_cast<std::uint32_t>(sample[1]) << 8U) |
                           (static_cast<std::uint32_t>(sample[2]) << 16U);
        return (raw & 0x00800000U) != 0U
                   ? static_cast<std::int64_t>(raw) - 0x01000000LL
                   : static_cast<std::int64_t>(raw);
    }
    const std::uint32_t raw = readU32(sample);
    return (raw & 0x80000000U) != 0U
               ? static_cast<std::int64_t>(raw) - 0x100000000LL
               : static_cast<std::int64_t>(raw);
}

double pcmScale(std::uint16_t bits) noexcept {
    return std::ldexp(1.0, static_cast<int>(bits) - 1);
}

std::uint16_t bitsForOutput(NativeWavOutputFormat format) noexcept {
    switch (format) {
    case NativeWavOutputFormat::Pcm16: return 16U;
    case NativeWavOutputFormat::Pcm24: return 24U;
    case NativeWavOutputFormat::Pcm32: return 32U;
    case NativeWavOutputFormat::Float32: return 32U;
    }
    return 0U;
}

std::uint32_t tagForOutput(NativeWavOutputFormat format) noexcept {
    return format == NativeWavOutputFormat::Float32 ? kFloatFormat : kPcmFormat;
}

std::int64_t quantizePcm(double sample, std::uint16_t bits) noexcept {
    const double negativeScale = pcmScale(bits);
    const double positiveScale = negativeScale - 1.0;
    const double scaled = sample < 0.0 ? sample * negativeScale : sample * positiveScale;
    return static_cast<std::int64_t>(std::llround(scaled));
}

void writeSignedSample(std::uint8_t* output, std::int64_t value,
                       std::uint16_t bits) noexcept {
    const auto raw = static_cast<std::uint64_t>(value);
    if (bits == 16U) {
        writeU16(output, static_cast<std::uint16_t>(raw));
    } else if (bits == 24U) {
        output[0] = static_cast<std::uint8_t>(raw & 0xffU);
        output[1] = static_cast<std::uint8_t>((raw >> 8U) & 0xffU);
        output[2] = static_cast<std::uint8_t>((raw >> 16U) & 0xffU);
    } else {
        writeU32(output, static_cast<std::uint32_t>(raw));
    }
}

NativeWavCodecResult resultWith(NativeWavCodecStatus status) noexcept {
    NativeWavCodecResult result{};
    result.status = status;
    return result;
}

NativeWavCodecStatus parseWavLayout(const std::uint8_t* bytes,
                                    std::size_t byteCount,
                                    ParsedWav& parsed) noexcept {
    if (bytes == nullptr) return NativeWavCodecStatus::InvalidArgument;
    if (byteCount < kRiffHeaderBytes) return NativeWavCodecStatus::TruncatedInput;
    if (!hasId(bytes, "RIFF") || !hasId(bytes + 8U, "WAVE"))
        return NativeWavCodecStatus::InvalidContainer;

    const std::uint64_t riffEnd64 = 8ULL + readU32(bytes + 4U);
    if (riffEnd64 < kRiffHeaderBytes || riffEnd64 > byteCount)
        return NativeWavCodecStatus::TruncatedInput;
    const auto riffEnd = static_cast<std::size_t>(riffEnd64);

    const std::uint8_t* fmtData = nullptr;
    std::size_t fmtSize = 0U;
    std::size_t cursor = kRiffHeaderBytes;
    while (cursor < riffEnd) {
        if (riffEnd - cursor < kChunkHeaderBytes)
            return NativeWavCodecStatus::InvalidChunk;
        const auto* chunk = bytes + cursor;
        const std::uint32_t chunkSize32 = readU32(chunk + 4U);
        const std::uint64_t payloadBegin64 =
            static_cast<std::uint64_t>(cursor) + kChunkHeaderBytes;
        const std::uint64_t payloadEnd64 = payloadBegin64 + chunkSize32;
        const std::uint64_t paddedEnd64 = payloadEnd64 + (chunkSize32 & 1U);
        if (payloadEnd64 > riffEnd64 || paddedEnd64 > riffEnd64)
            return NativeWavCodecStatus::InvalidChunk;
        const auto* payload = bytes + static_cast<std::size_t>(payloadBegin64);
        const auto chunkSize = static_cast<std::size_t>(chunkSize32);
        if (hasId(chunk, "fmt ")) {
            if (fmtData != nullptr) return NativeWavCodecStatus::DuplicateChunk;
            fmtData = payload;
            fmtSize = chunkSize;
        } else if (hasId(chunk, "data")) {
            if (parsed.audioData != nullptr) return NativeWavCodecStatus::DuplicateChunk;
            parsed.audioData = payload;
            parsed.audioSize = chunkSize;
        }
        cursor = static_cast<std::size_t>(paddedEnd64);
    }

    if (fmtData == nullptr || parsed.audioData == nullptr)
        return NativeWavCodecStatus::InvalidChunk;

    const auto formatStatus = parseFormat(fmtData, fmtSize, parsed.format);
    if (formatStatus != NativeWavCodecStatus::Ok) return formatStatus;
    if (parsed.audioSize % parsed.format.blockAlign != 0U)
        return NativeWavCodecStatus::InvalidSampleData;

    parsed.frameCount = parsed.audioSize / parsed.format.blockAlign;
    if (parsed.frameCount > std::numeric_limits<std::uint64_t>::max() /
                                parsed.format.channels)
        return NativeWavCodecStatus::SizeOverflow;
    parsed.sampleCount = parsed.frameCount * parsed.format.channels;
    if (parsed.sampleCount > std::numeric_limits<std::uint64_t>::max() / sizeof(float))
        return NativeWavCodecStatus::SizeOverflow;
    parsed.decodedSampleBytes = parsed.sampleCount * sizeof(float);
    if (parsed.sampleCount > std::numeric_limits<std::size_t>::max() ||
        parsed.decodedSampleBytes > std::numeric_limits<std::size_t>::max() ||
        parsed.sampleCount > std::vector<float>().max_size())
        return NativeWavCodecStatus::SizeOverflow;
    return NativeWavCodecStatus::Ok;
}

NativeWavCodecResult resultForParsed(const ParsedWav& parsed) noexcept {
    NativeWavCodecResult result{};
    result.status = NativeWavCodecStatus::Ok;
    result.sampleRateHz = parsed.format.sampleRateHz;
    result.channels = parsed.format.channels;
    result.bitsPerSample = parsed.format.bitsPerSample;
    result.encoding = parsed.format.encoding;
    result.frames = parsed.frameCount;
    result.decodedSampleBytes = parsed.decodedSampleBytes;
    return result;
}

} // namespace

NativeWavCodecResult NativeAudioAssetCodec::inspectWav(
    const std::uint8_t* bytes, std::size_t byteCount) noexcept {
    ParsedWav parsed{};
    const auto status = parseWavLayout(bytes, byteCount, parsed);
    if (status != NativeWavCodecStatus::Ok) return resultWith(status);
    return resultForParsed(parsed);
}

NativeWavCodecResult NativeAudioAssetCodec::decodeWav(
    const std::uint8_t* bytes, std::size_t byteCount,
    NativeAudioAsset& destination, NativeWavDecodeLimits limits) noexcept {
    ParsedWav parsed{};
    const auto layoutStatus = parseWavLayout(bytes, byteCount, parsed);
    if (layoutStatus != NativeWavCodecStatus::Ok) return resultWith(layoutStatus);
    auto result = resultForParsed(parsed);
    if (parsed.frameCount > limits.maxFrames ||
        parsed.decodedSampleBytes > limits.maxDecodedBytes) {
        result.status = NativeWavCodecStatus::DecodeLimitExceeded;
        return result;
    }

    NativeAudioAsset candidate{};
    candidate.sampleRateHz = parsed.format.sampleRateHz;
    candidate.channels = parsed.format.channels;
    candidate.sourceEncoding = parsed.format.encoding;
    candidate.sourceBitsPerSample = parsed.format.bitsPerSample;

    try {
        candidate.interleavedSamples.resize(static_cast<std::size_t>(parsed.sampleCount));
    } catch (const std::bad_alloc&) {
        return resultWith(NativeWavCodecStatus::AllocationFailed);
    } catch (...) {
        return resultWith(NativeWavCodecStatus::AllocationFailed);
    }

    const std::size_t bytesPerSample = parsed.format.bitsPerSample / 8U;
    const double scale = pcmScale(parsed.format.bitsPerSample);
    for (std::size_t index = 0; index < candidate.interleavedSamples.size(); ++index) {
        const auto* encoded = parsed.audioData + index * bytesPerSample;
        float value = 0.0f;
        if (parsed.format.encoding == NativeWavEncoding::PcmInteger) {
            value = static_cast<float>(static_cast<double>(
                decodePcmInteger(encoded, parsed.format.bitsPerSample)) / scale);
        } else {
            const std::uint32_t raw = readU32(encoded);
            std::memcpy(&value, &raw, sizeof(value));
            if (!std::isfinite(value)) return resultWith(NativeWavCodecStatus::NonFiniteSample);
        }
        candidate.interleavedSamples[index] = value;
    }

    destination = std::move(candidate);
    return result;
}

NativeWavCodecResult NativeAudioAssetCodec::encodeWav(
    const NativeAudioAsset& source, NativeWavOutputFormat outputFormat,
    std::vector<std::uint8_t>& destination) noexcept {
    if (source.sampleRateHz == 0U || (source.channels != 1U && source.channels != 2U) ||
        source.interleavedSamples.size() % source.channels != 0U)
        return resultWith(NativeWavCodecStatus::InvalidArgument);

    const auto bits = bitsForOutput(outputFormat);
    if (bits == 0U) return resultWith(NativeWavCodecStatus::UnsupportedEncoding);
    for (const float sample : source.interleavedSamples) {
        if (!std::isfinite(sample)) return resultWith(NativeWavCodecStatus::NonFiniteSample);
    }

    const std::uint64_t frames = source.interleavedSamples.size() / source.channels;
    const std::uint64_t bytesPerSample = bits / 8U;
    const std::uint64_t sampleCount = source.interleavedSamples.size();
    if (sampleCount > std::numeric_limits<std::uint64_t>::max() / bytesPerSample)
        return resultWith(NativeWavCodecStatus::SizeOverflow);
    const std::uint64_t dataBytes64 = sampleCount * bytesPerSample;
    const std::uint64_t dataPadding = dataBytes64 & 1ULL;
    if (dataBytes64 + dataPadding > std::numeric_limits<std::uint32_t>::max() - 36ULL)
        return resultWith(NativeWavCodecStatus::SizeOverflow);
    const std::uint64_t fileBytes64 = 44ULL + dataBytes64 + dataPadding;
    if (fileBytes64 > std::numeric_limits<std::size_t>::max() ||
        fileBytes64 > std::vector<std::uint8_t>().max_size())
        return resultWith(NativeWavCodecStatus::SizeOverflow);

    const std::uint64_t blockAlign64 = source.channels * bytesPerSample;
    const std::uint64_t byteRate64 = source.sampleRateHz * blockAlign64;
    if (blockAlign64 > std::numeric_limits<std::uint16_t>::max() ||
        byteRate64 > std::numeric_limits<std::uint32_t>::max())
        return resultWith(NativeWavCodecStatus::SizeOverflow);

    std::vector<std::uint8_t> candidate;
    try {
        candidate.resize(static_cast<std::size_t>(fileBytes64));
    } catch (const std::bad_alloc&) {
        return resultWith(NativeWavCodecStatus::AllocationFailed);
    } catch (...) {
        return resultWith(NativeWavCodecStatus::AllocationFailed);
    }

    std::memcpy(candidate.data(), "RIFF", 4U);
    writeU32(candidate.data() + 4U, static_cast<std::uint32_t>(fileBytes64 - 8ULL));
    std::memcpy(candidate.data() + 8U, "WAVE", 4U);
    std::memcpy(candidate.data() + 12U, "fmt ", 4U);
    writeU32(candidate.data() + 16U, 16U);
    writeU16(candidate.data() + 20U, static_cast<std::uint16_t>(tagForOutput(outputFormat)));
    writeU16(candidate.data() + 22U, source.channels);
    writeU32(candidate.data() + 24U, source.sampleRateHz);
    writeU32(candidate.data() + 28U, static_cast<std::uint32_t>(byteRate64));
    writeU16(candidate.data() + 32U, static_cast<std::uint16_t>(blockAlign64));
    writeU16(candidate.data() + 34U, bits);
    std::memcpy(candidate.data() + 36U, "data", 4U);
    writeU32(candidate.data() + 40U, static_cast<std::uint32_t>(dataBytes64));

    auto* payload = candidate.data() + 44U;
    const std::size_t stride = bits / 8U;
    for (std::size_t index = 0; index < source.interleavedSamples.size(); ++index) {
        const double sample = source.interleavedSamples[index];
        auto* encoded = payload + index * stride;
        if (outputFormat == NativeWavOutputFormat::Float32) {
            std::uint32_t raw = 0U;
            const float value = source.interleavedSamples[index];
            std::memcpy(&raw, &value, sizeof(raw));
            writeU32(encoded, raw);
            continue;
        }

        const auto quantized = quantizePcm(std::clamp(sample, -1.0, 1.0), bits);
        writeSignedSample(encoded, quantized, bits);
    }

    destination.swap(candidate);
    NativeWavCodecResult result{};
    result.status = NativeWavCodecStatus::Ok;
    result.sampleRateHz = source.sampleRateHz;
    result.channels = source.channels;
    result.bitsPerSample = bits;
    result.encoding = outputFormat == NativeWavOutputFormat::Float32
                          ? NativeWavEncoding::IeeeFloat
                          : NativeWavEncoding::PcmInteger;
    result.frames = frames;
    return result;
}

} // namespace webrc::native
