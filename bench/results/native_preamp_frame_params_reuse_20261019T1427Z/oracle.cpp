#include "native_preamp_processor.hpp"
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <vector>
using namespace webrc::native;
namespace {
std::uint64_t fnv1a(const std::vector<float>& samples) {
    std::uint64_t hash = 14695981039346656037ULL;
    for (float sample : samples) {
        std::uint32_t bits = 0;
        std::memcpy(&bits, &sample, sizeof(bits));
        for (unsigned int byte = 0; byte < 4U; ++byte) {
            hash ^= static_cast<std::uint8_t>(bits >> (byte * 8U));
            hash *= 1099511628211ULL;
        }
    }
    return hash;
}
struct Change { std::size_t frame; NativePreampConfig config; std::uint64_t ramp; };
std::uint32_t nextRandom(std::uint32_t& state) {
    state ^= state << 13U; state ^= state >> 17U; state ^= state << 5U; return state;
}
void run(unsigned int sampleRate, unsigned int channels) {
    constexpr std::size_t frames = 8192U;
    constexpr std::array<unsigned int, 8U> chunks{{1U, 17U, 63U, 64U, 127U, 255U, 511U, 1024U}};
    constexpr std::array<Change, 5U> changes{{
        {0U, {0.0f, 3.0f, -12.0f, 12.0f, -6.0f, -24.0f}, 0U},
        {73U, {3.0f, 100.0f, 8.0f, -6.0f, 5.0f, 0.0f}, 511U},
        {1093U, {4.0f, 0.0f, -1.0f, 2.0f, -3.0f, 6.0f}, 0U},
        {4099U, {1.0f, 72.0f, -8.0f, 7.0f, 11.0f, -2.0f}, 1200U},
        {6111U, {2.0f, 41.0f, 0.0f, 0.0f, 0.0f, 0.0f}, 17U},
    }};
    NativePreampProcessor processor;
    if (!processor.prepare(sampleRate)) std::abort();
    std::vector<float> audio(frames * channels);
    std::uint32_t random = 0x4a3b2c1dU ^ sampleRate ^ channels;
    for (std::size_t frame = 0; frame < frames; ++frame) {
        const std::uint32_t r0 = nextRandom(random);
        const std::uint32_t r1 = nextRandom(random);
        const float n0 = static_cast<float>(static_cast<std::int32_t>(r0) / 2147483648.0);
        const float n1 = static_cast<float>(static_cast<std::int32_t>(r1) / 2147483648.0);
        const std::size_t block = frame % 1024U;
        const float scale = block < 256U ? 1.0e-6f : (block < 512U ? 0.015625f : (block < 768U ? 0.375f : 1.0f));
        audio[frame * channels] = n0 * scale;
        if (channels > 1U) audio[frame * channels + 1U] = n1 * scale;
        if (channels > 2U) audio[frame * channels + 2U] = static_cast<float>(frame % 127U) / 127.0f;
    }
    std::size_t frame = 0U, changeIndex = 0U, chunkIndex = 0U;
    while (frame < frames) {
        if (changeIndex < changes.size() && frame == changes[changeIndex].frame) {
            if (!processor.setConfig(changes[changeIndex].config, changes[changeIndex].ramp)) std::abort();
            ++changeIndex;
        }
        std::size_t nextEvent = changeIndex < changes.size() ? changes[changeIndex].frame : frames;
        const auto count = static_cast<unsigned int>(std::min<std::size_t>({chunks[chunkIndex % chunks.size()], frames - frame, nextEvent - frame}));
        if (count == 0U) std::abort();
        (void)processor.processInPlace(audio.data() + frame * channels, count, channels);
        frame += count;
        ++chunkIndex;
    }
    std::cout << sampleRate << ' ' << channels << ' ' << std::hex << fnv1a(audio) << std::dec << '\n';
}
}
int main() {
    for (const auto rate : {8000U, 22050U, 44100U, 48000U, 96000U, 192000U}) {
        for (const auto channels : {1U, 2U, 3U}) run(rate, channels);
    }
}
