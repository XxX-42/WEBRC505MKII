#include "native_distortion_processor.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <vector>

using namespace webrc::native;

static std::uint32_t noise(std::uint32_t& state) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state;
}

static std::uint32_t bits(float value) {
    std::uint32_t valueBits = 0U;
    std::memcpy(&valueBits, &value, sizeof(valueBits));
    return valueBits;
}

int main() {
    constexpr std::array<unsigned, 4> rates{{8000U, 44100U, 48000U, 192000U}};
    constexpr std::array<unsigned, 3> channelCounts{{1U, 2U, 3U}};
    constexpr std::array<float, 3> drives{{0.0f, 18.0f, 36.0f}};
    constexpr std::array<float, 3> mixes{{0.0f, 50.0f, 100.0f}};
    constexpr std::array<unsigned, 7> chunks{{1U, 17U, 63U, 64U, 255U, 511U, 1024U}};
    for (const unsigned rate : rates) {
        for (const unsigned channels : channelCounts) {
            for (const float drive : drives) {
                for (const float mix : mixes) {
                    constexpr unsigned frames = 12037U;
                    NativeDistortionProcessor processor;
                    if (!processor.prepare(rate) || !processor.setConfig({drive, mix}, 0U)) return 2;
                    std::vector<float> audio(static_cast<std::size_t>(frames) * channels);
                    std::uint32_t rng = 0x12345678U;
                    for (unsigned frame = 0U; frame < frames; ++frame) {
                        const double t = static_cast<double>(frame);
                        float sample = static_cast<float>(0.64 * std::sin(t * 0.071) + 0.21 * std::cos(t * 0.019));
                        sample += static_cast<float>((static_cast<int>(noise(rng) & 0xffffU) - 32768) / 65536.0 * 0.04);
                        if (frame == 0U) sample = 1.0f;
                        if (frame == 37U) sample = -16.0f;
                        if (frame == 64U) sample = std::numeric_limits<float>::max();
                        if (frame == 95U) sample = std::numeric_limits<float>::quiet_NaN();
                        if (frame == 127U) sample = std::numeric_limits<float>::infinity();
                        for (unsigned channel = 0U; channel < channels; ++channel) {
                            const float value = channel == 0U ? sample : static_cast<float>(sample * (channel == 1U ? -0.7 : 0.33));
                            audio[static_cast<std::size_t>(frame) * channels + channel] = value;
                        }
                    }
                    unsigned position = 0U;
                    unsigned chunkIndex = 0U;
                    while (position < frames) {
                        if (position == 4096U && !processor.setConfig({36.0f - drive, 100.0f - mix}, 777U)) return 3;
                        const unsigned count = std::min(chunks[chunkIndex % chunks.size()], frames - position);
                        const float peak = processor.processInPlace(audio.data() + static_cast<std::size_t>(position) * channels, count, channels);
                        const std::uint32_t peakBits = bits(peak);
                        if (std::fwrite(&peakBits, sizeof(peakBits), 1U, stdout) != 1U) return 4;
                        position += count;
                        ++chunkIndex;
                    }
                    for (const float value : audio) {
                        const std::uint32_t valueBits = bits(value);
                        if (std::fwrite(&valueBits, sizeof(valueBits), 1U, stdout) != 1U) return 5;
                    }
                }
            }
        }
    }
    return 0;
}
