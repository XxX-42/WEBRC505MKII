#include "webrc/dsp/preamp_fx.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

extern "C" double gPreCabinetPeak = 0.0;
extern "C" std::uint64_t gPreCabinetSamplesOver16 = 0U;

namespace {
using namespace webrc::dsp;
constexpr double pi = 3.141592653589793238462643383279502884;
struct Case { const char* name; double frequency; };
struct Measurement { const char* name; double peak; std::uint64_t over16; double outputPeak; double outputRms; };

Measurement run(const Case& item) {
    constexpr std::uint32_t sr = 48000U;
    constexpr std::uint32_t frames = sr;
    constexpr std::uint32_t blockFrames = 64U;
    ProcessSpec spec{static_cast<float>(sr), blockFrames, 2U};
    std::array<float, 1U> ir{1.0f};
    PreampFxProcessor processor;
    PreampFxOptions options{};
    if (!processor.prepare(spec, options, {1U, ir.data(), ir.data()})) return {item.name, -1.0, 0U, -1.0, -1.0};
    const std::array<PreampFxEvent, 8U> events{{
        {0U, PreampFxControl::Active, 1.0f},
        {0U, PreampFxControl::Mix, 1.0f},
        {0U, PreampFxControl::Drive, 24.0f},
        {0U, PreampFxControl::BassDb, 12.0f},
        {0U, PreampFxControl::MidDb, 12.0f},
        {0U, PreampFxControl::TrebleDb, 12.0f},
        {0U, PreampFxControl::PresenceDb, 12.0f},
        {0U, PreampFxControl::OutputDb, 12.0f},
    }};
    std::vector<StereoFrame> audio(blockFrames);
    double outputPeak = 0.0;
    double outputSquares = 0.0;
    std::uint64_t absolute = 0U;
    while (absolute < frames) {
        const auto count = std::min(blockFrames, frames - static_cast<std::uint32_t>(absolute));
        for (std::uint32_t i = 0U; i < count; ++i) {
            const auto n = absolute + i;
            const double phase = 2.0 * pi * item.frequency * static_cast<double>(n) / sr;
            const float sample = static_cast<float>(0.72 * std::sin(phase));
            audio[i] = {sample, sample};
        }
        if (!processor.processBlock(absolute, audio.data(), count,
                                    absolute == 0U ? events.data() : nullptr,
                                    absolute == 0U ? static_cast<std::uint32_t>(events.size()) : 0U))
            return {item.name, -2.0, gPreCabinetSamplesOver16, -2.0, -2.0};
        for (std::uint32_t i = 0U; i < count; ++i) {
            outputPeak = std::max(outputPeak, static_cast<double>(std::max(std::fabs(audio[i].left), std::fabs(audio[i].right))));
            outputSquares += static_cast<double>(audio[i].left) * audio[i].left +
                             static_cast<double>(audio[i].right) * audio[i].right;
        }
        absolute += count;
    }
    return {item.name, gPreCabinetPeak, gPreCabinetSamplesOver16, outputPeak,
            std::sqrt(outputSquares / (2.0 * frames))};
}
}

int main() {
    const std::array<Case, 6U> cases{{
        {"100Hz", 100.0}, {"800Hz", 800.0}, {"3800Hz", 3800.0},
        {"5200Hz", 5200.0}, {"10000Hz", 10000.0}, {"5200Hz-warm-repeated", 5200.0},
    }};
    std::printf("{\"schemaVersion\":1,\"suite\":\"preamp-max-control-clamp-audit\",\"sampleRate\":48000,\"inputPeak\":0.72,\"settings\":{\"drive\":24,\"bassDb\":12,\"midDb\":12,\"trebleDb\":12,\"presenceDb\":12,\"outputDb\":12},\"cases\":[");
    bool good = true;
    for (std::size_t i = 0U; i < cases.size(); ++i) {
        gPreCabinetPeak = 0.0;
        gPreCabinetSamplesOver16 = 0U;
        const auto m = run(cases[i]);
        if (i != 0U) std::printf(",");
        std::printf("{\"name\":\"%s\",\"preCabinetPeak\":%.9g,\"samplesOver16\":%llu,\"postProcessorOutputPeak\":%.9g,\"postProcessorOutputRms\":%.9g}",
                    m.name, m.peak, static_cast<unsigned long long>(m.over16), m.outputPeak, m.outputRms);
        good = good && m.peak >= 0.0 && m.outputPeak >= 0.0;
    }
    std::printf("],\"failures\":%u}\n", good ? 0U : 1U);
    return good ? 0 : 1;
}
