#include "webrc/dsp/pitch.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <vector>

namespace {
constexpr std::uint32_t kSampleRate = 48000U;
constexpr std::uint32_t kFrames = 48000U;
constexpr std::uint32_t kQuantum = 128U;
constexpr std::uint32_t kWarmStart = 32000U;
constexpr std::uint32_t kWarmFrames = 12000U;
constexpr double kPi = 3.141592653589793238462643383279502884;

bool writeFloats(const char* path, const std::vector<float>& values) {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out.write(reinterpret_cast<const char*>(values.data()),
              static_cast<std::streamsize>(values.size() * sizeof(float)));
    return static_cast<bool>(out);
}

double rms(const std::vector<float>& values, std::uint32_t start, std::uint32_t count) {
    double sum = 0.0;
    for (std::uint32_t i = start; i < start + count; ++i)
        sum += static_cast<double>(values[i]) * values[i];
    return std::sqrt(sum / count);
}

double estimateFrequency(const std::vector<float>& values,
                         std::uint32_t start, std::uint32_t count,
                         std::uint32_t sampleRate, double minimumHz,
                         double maximumHz) {
    const auto minLag = static_cast<std::size_t>(std::floor(sampleRate / maximumHz));
    const auto maxLag = static_cast<std::size_t>(std::ceil(sampleRate / minimumHz));
    const std::size_t available = count / 2U;
    const auto lastLag = std::min(maxLag, available - 1U);
    std::size_t bestLag = minLag;
    double bestCorrelation = -std::numeric_limits<double>::infinity();
    const auto correlationAt = [&](std::size_t lag) {
        double correlation = 0.0;
        double energyA = 0.0;
        double energyB = 0.0;
        for (std::size_t i = 0U; i < count - lag; ++i) {
            const double a = values[start + i];
            const double b = values[start + i + lag];
            correlation += a * b;
            energyA += a * a;
            energyB += b * b;
        }
        return correlation / std::sqrt(std::max(1.0e-30, energyA * energyB));
    };
    for (std::size_t lag = minLag; lag <= lastLag; ++lag) {
        const double correlation = correlationAt(lag);
        if (correlation > bestCorrelation) {
            bestCorrelation = correlation;
            bestLag = lag;
        }
    }
    double fractionalLag = static_cast<double>(bestLag);
    if (bestLag > minLag && bestLag < lastLag) {
        const double lower = correlationAt(bestLag - 1U);
        const double center = correlationAt(bestLag);
        const double upper = correlationAt(bestLag + 1U);
        const double denominator = lower - 2.0 * center + upper;
        if (std::fabs(denominator) > 1.0e-12)
            fractionalLag += std::clamp(0.5 * (lower - upper) / denominator, -0.5, 0.5);
    }
    return static_cast<double>(sampleRate) / fractionalLag;
}
} // namespace

int main() {
    using namespace webrc::dsp;
    const ProcessSpec spec{static_cast<float>(kSampleRate), kQuantum, 1U};
    constexpr std::uint32_t maximumPitchPeriodSamples = 739U;
    const PitchEstimate f0{220.0f, static_cast<float>(kSampleRate) / 220.0f,
                           0.99f, 0.3f, true};
    StreamingTdPsolaPitchShifter shifter;
    if (!shifter.prepare(spec, maximumPitchPeriodSamples) ||
        !shifter.setPitchEstimate(f0, 2.0f)) return 2;

    std::vector<float> input(kFrames);
    std::vector<float> output(kFrames, 0.0f);
    for (std::uint32_t frame = 0U; frame < kFrames; ++frame)
        input[frame] = 0.3f * static_cast<float>(std::sin(
            2.0 * kPi * 220.0 * frame / static_cast<double>(kSampleRate)));
    for (std::uint32_t offset = 0U; offset < kFrames; offset += kQuantum) {
        if (!shifter.processBlock(input.data() + offset, output.data() + offset, kQuantum)) return 3;
    }
    if (!writeFloats("artifacts/input.f32le", input) ||
        !writeFloats("artifacts/output.f32le", output)) return 4;
    double peak = 0.0;
    std::uint64_t nonFinite = 0U;
    for (const auto sample : output) {
        if (!std::isfinite(sample)) ++nonFinite;
        else peak = std::max(peak, std::fabs(static_cast<double>(sample)));
    }
    const double warmRms = rms(output, kWarmStart, kWarmFrames);
    const double warmHz = estimateFrequency(output, kWarmStart, kWarmFrames,
        kSampleRate, 80.0, 1200.0);
    std::cout << std::setprecision(12)
              << "{\"schemaVersion\":1,\"suite\":\"streaming-psola-ratio2-reproduction\","
              << "\"status\":\"reproduced_failure\",\"sampleRate\":" << kSampleRate
              << ",\"inputFrames\":" << kFrames << ",\"quantumFrames\":" << kQuantum
              << ",\"inputFrequencyHz\":220,\"inputAmplitude\":0.3,\"pitchRatio\":2"
              << ",\"declaredExpectedFrequencyHz\":440,\"warmWindowStartFrame\":" << kWarmStart
              << ",\"warmWindowFrames\":" << kWarmFrames
              << ",\"warmOutputRms\":" << warmRms
              << ",\"warmOutputFrequencyHz\":" << warmHz
              << ",\"fullOutputPeak\":" << peak
              << ",\"nonFiniteSamples\":" << nonFinite
              << ",\"latencySamples\":" << shifter.latencySamples()
              << ",\"inputPcm\":\"artifacts/input.f32le\",\"outputPcm\":\"artifacts/output.f32le\"}\n";
    if (!std::isfinite(warmRms) || !std::isfinite(warmHz) || nonFinite != 0U) return 5;
    return 0;
}
