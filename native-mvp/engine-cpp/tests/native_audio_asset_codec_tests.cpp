#include "native_audio_asset_codec.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <new>
#include <string>
#include <vector>

namespace {
std::atomic<bool> countAllocations{false};
std::atomic<std::uint32_t> allocations{0U};
}

void* operator new(std::size_t size) {
    if (countAllocations.load(std::memory_order_relaxed))
        allocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (countAllocations.load(std::memory_order_relaxed))
        allocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

namespace {
using namespace webrc::native;

bool check(bool condition, const char* message) {
    if (!condition) std::cerr << "FAIL: " << message << '\n';
    return condition;
}

void putU16(std::vector<std::uint8_t>& bytes, std::size_t at, std::uint16_t value) {
    bytes[at] = static_cast<std::uint8_t>(value & 0xffU);
    bytes[at + 1U] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
}

void putU32(std::vector<std::uint8_t>& bytes, std::size_t at, std::uint32_t value) {
    bytes[at] = static_cast<std::uint8_t>(value & 0xffU);
    bytes[at + 1U] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
    bytes[at + 2U] = static_cast<std::uint8_t>((value >> 16U) & 0xffU);
    bytes[at + 3U] = static_cast<std::uint8_t>((value >> 24U) & 0xffU);
}

std::vector<std::uint8_t> makePcm16Stereo() {
    // 2-frame, 48 kHz L/R fixture: left and right intentionally differ.
    std::vector<std::uint8_t> bytes(52U, 0U);
    std::memcpy(bytes.data(), "RIFF", 4U);
    putU32(bytes, 4U, 44U);
    std::memcpy(bytes.data() + 8U, "WAVE", 4U);
    std::memcpy(bytes.data() + 12U, "fmt ", 4U);
    putU32(bytes, 16U, 16U);
    putU16(bytes, 20U, 1U);
    putU16(bytes, 22U, 2U);
    putU32(bytes, 24U, 48000U);
    putU32(bytes, 28U, 192000U);
    putU16(bytes, 32U, 4U);
    putU16(bytes, 34U, 16U);
    std::memcpy(bytes.data() + 36U, "data", 4U);
    putU32(bytes, 40U, 8U);
    putU16(bytes, 44U, 8192U);       // L = +0.25
    putU16(bytes, 46U, 0xe000U);     // R = -0.25
    putU16(bytes, 48U, 0xc000U);     // L = -0.5
    putU16(bytes, 50U, 0x4000U);     // R = +0.5
    return bytes;
}

bool near(float actual, float expected, float tolerance) {
    return std::fabs(actual - expected) <= tolerance;
}

template <typename Function>
std::uint32_t countNewCalls(Function&& function) {
    allocations.store(0U, std::memory_order_relaxed);
    countAllocations.store(true, std::memory_order_release);
    function();
    countAllocations.store(false, std::memory_order_release);
    return allocations.load(std::memory_order_relaxed);
}

bool testStereoRoundTripsAllFormats() {
    NativeAudioAsset input{};
    input.sampleRateHz = 44100U;
    input.channels = 2U;
    input.interleavedSamples = {0.25f, -0.75f, -0.5f, 0.125f,
                                1.25f, -1.25f, 0.0f, 0.875f};

    struct Case {
        NativeWavOutputFormat format;
        float tolerance;
        const char* name;
    };
    const std::array<Case, 4U> cases{{
        {NativeWavOutputFormat::Pcm16, 1.0f / 32768.0f + 1.0e-6f, "PCM16"},
        {NativeWavOutputFormat::Pcm24, 1.0f / 8388608.0f + 1.0e-6f, "PCM24"},
        {NativeWavOutputFormat::Pcm32, 1.0e-6f, "PCM32"},
        {NativeWavOutputFormat::Float32, 0.0f, "float32"},
    }};

    for (const auto& testCase : cases) {
        std::vector<std::uint8_t> encoded{0xaaU, 0xbbU};
        const auto encode = NativeAudioAssetCodec::encodeWav(
            input, testCase.format, encoded);
        if (!check(encode.ok(), "encode each supported sample format")) return false;
        NativeAudioAsset decoded{};
        const auto result = NativeAudioAssetCodec::decodeWav(
            encoded.data(), encoded.size(), decoded);
        if (!check(result.ok(), "decode each supported sample format")) return false;
        if (!check(decoded.channels == 2U && decoded.sampleRateHz == 44100U &&
                       decoded.frames() == 4U,
                   "round-trip retains stereo channel count, sample rate, and frames"))
            return false;

        for (std::size_t i = 0; i < input.interleavedSamples.size(); ++i) {
            const float expected = testCase.format == NativeWavOutputFormat::Float32
                                       ? input.interleavedSamples[i]
                                       : std::max(-1.0f, std::min(1.0f, input.interleavedSamples[i]));
            if (!near(decoded.interleavedSamples[i], expected, testCase.tolerance)) {
                std::cerr << "FAIL: " << testCase.name << " sample " << i
                          << " did not round-trip: " << decoded.interleavedSamples[i]
                          << " vs " << expected << '\n';
                return false;
            }
        }
        float expectedHigh = 1.0f;
        if (testCase.format == NativeWavOutputFormat::Pcm16)
            expectedHigh = 32767.0f / 32768.0f;
        else if (testCase.format == NativeWavOutputFormat::Pcm24)
            expectedHigh = 8388607.0f / 8388608.0f;
        else if (testCase.format == NativeWavOutputFormat::Float32)
            expectedHigh = 1.25f;
        const float expectedLow = testCase.format == NativeWavOutputFormat::Float32 ? -1.25f : -1.0f;
        if (!check(decoded.interleavedSamples[0] > 0.0f &&
                       decoded.interleavedSamples[1] < 0.0f &&
                       decoded.interleavedSamples[4] == expectedHigh &&
                       decoded.interleavedSamples[5] == expectedLow,
                   "independent L/R order and PCM saturation are preserved")) {
            std::cerr << "  format=" << testCase.name
                      << " L0=" << decoded.interleavedSamples[0]
                      << " R0=" << decoded.interleavedSamples[1]
                      << " L2=" << decoded.interleavedSamples[4]
                      << " R2=" << decoded.interleavedSamples[5]
                      << " expected=" << expectedHigh << ',' << expectedLow << '\n';
            return false;
        }
    }
    return true;
}

bool testMonoRemainsExplicitlyMono() {
    NativeAudioAsset input{};
    input.sampleRateHz = 32000U;
    input.channels = 1U;
    input.interleavedSamples = {-1.0f, -0.125f, 0.75f};
    std::vector<std::uint8_t> encoded{};
    const auto write = NativeAudioAssetCodec::encodeWav(
        input, NativeWavOutputFormat::Pcm24, encoded);
    if (!check(write.ok(), "encode mono PCM24")) return false;

    NativeAudioAsset decoded{};
    const auto read = NativeAudioAssetCodec::decodeWav(
        encoded.data(), encoded.size(), decoded);
    return check(read.ok() && decoded.channels == 1U && decoded.frames() == 3U &&
                     decoded.interleavedSamples.size() == 3U &&
                     near(decoded.interleavedSamples[0], -1.0f, 1.0e-6f),
                 "mono import stays one channel and is not silently duplicated");
}

bool testKnown24BitEncodingAndOddChunkPadding() {
    NativeAudioAsset input{};
    input.sampleRateHz = 48000U;
    input.channels = 1U;
    input.interleavedSamples = {-1.0f, 1.0f, -0.5f};
    std::vector<std::uint8_t> encoded{};
    if (!check(NativeAudioAssetCodec::encodeWav(
                   input, NativeWavOutputFormat::Pcm24, encoded).ok(),
               "encode 24-bit boundary fixture"))
        return false;
    if (!check(encoded[44U] == 0x00U && encoded[45U] == 0x00U && encoded[46U] == 0x80U &&
                   encoded[47U] == 0xffU && encoded[48U] == 0xffU && encoded[49U] == 0x7fU &&
                   encoded[50U] == 0x00U && encoded[51U] == 0x00U && encoded[52U] == 0xc0U,
               "24-bit PCM uses correct signed little-endian endpoints"))
        return false;

    // Insert an odd-sized JUNK chunk including its required pad byte. Its data
    // chunk is moved before fmt to prove both ordering and padding are parsed.
    auto withJunk = makePcm16Stereo();
    std::vector<std::uint8_t> rearranged;
    rearranged.insert(rearranged.end(), withJunk.begin(), withJunk.begin() + 12);
    rearranged.insert(rearranged.end(), withJunk.begin() + 36, withJunk.end());
    const std::array<std::uint8_t, 12U> junk{{'J','U','N','K',3,0,0,0,0x11,0x22,0x33,0}};
    rearranged.insert(rearranged.end(), junk.begin(), junk.end());
    rearranged.insert(rearranged.end(), withJunk.begin() + 12, withJunk.begin() + 36);
    putU32(rearranged, 4U, static_cast<std::uint32_t>(rearranged.size() - 8U));
    NativeAudioAsset decoded{};
    const auto result = NativeAudioAssetCodec::decodeWav(
        rearranged.data(), rearranged.size(), decoded);
    return check(result.ok() && decoded.channels == 2U && decoded.frames() == 2U &&
                     near(decoded.interleavedSamples[0], 0.25f, 1.0e-6f) &&
                     near(decoded.interleavedSamples[1], -0.25f, 1.0e-6f),
                 "unknown odd chunk padding and data-before-fmt ordering are handled");
}

bool testKnown16And32BitEndpoints() {
    NativeAudioAsset input{};
    input.sampleRateHz = 48000U;
    input.channels = 1U;
    input.interleavedSamples = {-1.0f, 1.0f};
    std::vector<std::uint8_t> pcm16{};
    std::vector<std::uint8_t> pcm32{};
    if (!check(NativeAudioAssetCodec::encodeWav(
                   input, NativeWavOutputFormat::Pcm16, pcm16).ok(),
               "encode known PCM16 endpoints")) return false;
    if (!check(NativeAudioAssetCodec::encodeWav(
                   input, NativeWavOutputFormat::Pcm32, pcm32).ok(),
               "encode known PCM32 endpoints")) return false;
    return check(pcm16[44U] == 0x00U && pcm16[45U] == 0x80U &&
                     pcm16[46U] == 0xffU && pcm16[47U] == 0x7fU &&
                     pcm32[44U] == 0x00U && pcm32[45U] == 0x00U &&
                     pcm32[46U] == 0x00U && pcm32[47U] == 0x80U &&
                     pcm32[48U] == 0xffU && pcm32[49U] == 0xffU &&
                     pcm32[50U] == 0xffU && pcm32[51U] == 0x7fU,
                 "integer PCM uses correct 16/32-bit endpoint byte patterns");
}

bool testMalformedInputIsTransactional() {
    NativeAudioAsset destination{};
    destination.sampleRateHz = 22050U;
    destination.channels = 2U;
    destination.interleavedSamples = {0.2f, -0.4f};
    const auto original = destination.interleavedSamples;
    const auto valid = makePcm16Stereo();

    auto expectRejectedUnchanged = [&](std::vector<std::uint8_t> bytes,
                                      NativeWavCodecStatus expected,
                                      const char* label) {
        const auto result = NativeAudioAssetCodec::decodeWav(
            bytes.data(), bytes.size(), destination);
        return check(result.status == expected && destination.sampleRateHz == 22050U &&
                         destination.channels == 2U &&
                         destination.interleavedSamples == original,
                     label);
    };

    auto badRiff = valid;
    badRiff[0] = 'X';
    if (!expectRejectedUnchanged(std::move(badRiff), NativeWavCodecStatus::InvalidContainer,
                                 "bad RIFF id rejects without replacing destination")) return false;

    auto oversizedChunk = valid;
    putU32(oversizedChunk, 40U, 0xffffffffU);
    if (!expectRejectedUnchanged(std::move(oversizedChunk), NativeWavCodecStatus::InvalidChunk,
                                 "oversized data chunk rejects before dereference")) return false;

    auto invalidChannels = valid;
    putU16(invalidChannels, 22U, 3U);
    if (!expectRejectedUnchanged(std::move(invalidChannels), NativeWavCodecStatus::InvalidChannelLayout,
                                 "unsupported multichannel WAVE rejects explicitly")) return false;

    auto invalidRate = valid;
    putU32(invalidRate, 28U, 1U);
    if (!expectRejectedUnchanged(std::move(invalidRate), NativeWavCodecStatus::InvalidFormat,
                                 "inconsistent WAVE byte rate rejects")) return false;

    auto partialFrame = valid;
    partialFrame.push_back(0U); // one extra sample byte
    partialFrame.push_back(0U); // WAVE chunk pad byte
    putU32(partialFrame, 4U, static_cast<std::uint32_t>(partialFrame.size() - 8U));
    putU32(partialFrame, 40U, 9U);
    if (!expectRejectedUnchanged(std::move(partialFrame), NativeWavCodecStatus::InvalidSampleData,
                                 "partial interleaved frame rejects transactionally")) return false;

    auto truncated = valid;
    truncated.pop_back();
    if (!expectRejectedUnchanged(std::move(truncated), NativeWavCodecStatus::TruncatedInput,
                                 "truncated container rejects transactionally")) return false;

    // Rebuild as float32 first so a NaN is meaningful under its declared format.
    NativeAudioAsset floats{};
    floats.sampleRateHz = 48000U;
    floats.channels = 1U;
    floats.interleavedSamples = {0.1f, 0.2f};
    std::vector<std::uint8_t> floatWave{};
    if (!check(NativeAudioAssetCodec::encodeWav(
                   floats, NativeWavOutputFormat::Float32, floatWave).ok(),
               "build float NaN rejection fixture")) return false;
    putU32(floatWave, 44U, 0x7fc00000U);
    if (!expectRejectedUnchanged(std::move(floatWave), NativeWavCodecStatus::NonFiniteSample,
                                 "non-finite float WAVE sample rejects transactionally")) return false;
    return true;
}

bool testEncodingValidationIsTransactional() {
    std::vector<std::uint8_t> destination{1U, 2U, 3U};
    NativeAudioAsset invalid{};
    invalid.sampleRateHz = 48000U;
    invalid.channels = 2U;
    invalid.interleavedSamples = {0.0f, std::numeric_limits<float>::infinity()};
    const auto result = NativeAudioAssetCodec::encodeWav(
        invalid, NativeWavOutputFormat::Float32, destination);
    return check(result.status == NativeWavCodecStatus::NonFiniteSample &&
                     destination == std::vector<std::uint8_t>({1U, 2U, 3U}),
                 "invalid float data cannot replace existing encoded output");
}

bool testPreflightLimitsRejectBeforeAllocation() {
    const auto wave = makePcm16Stereo();
    NativeAudioAsset destination{};
    destination.sampleRateHz = 22050U;
    destination.channels = 1U;
    destination.interleavedSamples = {0.125f};
    const auto originalSamples = destination.interleavedSamples;

    const auto layout = NativeAudioAssetCodec::inspectWav(wave.data(), wave.size());
    if (!check(layout.ok() && layout.sampleRateHz == 48000U && layout.channels == 2U &&
                   layout.frames == 2U && layout.decodedSampleBytes == 16U,
               "no-allocation layout inspection reports decoded float storage requirement"))
        return false;

    NativeWavCodecResult frameLimited{};
    NativeWavCodecResult byteLimited{};
    const auto frameAllocations = countNewCalls([&] {
        frameLimited = NativeAudioAssetCodec::decodeWav(
            wave.data(), wave.size(), destination, NativeWavDecodeLimits{1U, 1024U});
    });
    const auto byteAllocations = countNewCalls([&] {
        byteLimited = NativeAudioAssetCodec::decodeWav(
            wave.data(), wave.size(), destination, NativeWavDecodeLimits{10U, 15U});
    });
    return check(frameLimited.status == NativeWavCodecStatus::DecodeLimitExceeded &&
                     byteLimited.status == NativeWavCodecStatus::DecodeLimitExceeded &&
                     frameLimited.frames == 2U && byteLimited.decodedSampleBytes == 16U &&
                     frameAllocations == 0U && byteAllocations == 0U &&
                     destination.sampleRateHz == 22050U && destination.channels == 1U &&
                     destination.interleavedSamples == originalSamples,
                 "frame and decoded-byte limits reject before allocation and preserve destination");
}

} // namespace

int main() {
    bool passed = true;
    passed = testStereoRoundTripsAllFormats() && passed;
    passed = testMonoRemainsExplicitlyMono() && passed;
    passed = testKnown24BitEncodingAndOddChunkPadding() && passed;
    passed = testKnown16And32BitEndpoints() && passed;
    passed = testMalformedInputIsTransactional() && passed;
    passed = testEncodingValidationIsTransactional() && passed;
    passed = testPreflightLimitsRejectBeforeAllocation() && passed;
    if (!passed) return 1;
    std::cout << "PASS: native WAV asset codec tests\n";
    return 0;
}
