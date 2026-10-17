#include "native_osc_bot_core.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>

using namespace webrc::native;

namespace {

constexpr std::uint32_t kSampleRate = 48000U;
constexpr double kPi = 3.141592653589793238462643383279502884;

[[nodiscard]] float sine(double frequency, std::size_t frame, float amplitude = 0.5f) {
    return amplitude * static_cast<float>(std::sin(
        (2.0 * kPi * frequency * static_cast<double>(frame)) /
        static_cast<double>(kSampleRate)));
}

template <std::size_t N>
void fillSine(std::array<float, N>& samples, double frequency = 220.0) {
    for (std::size_t frame = 0U; frame < N; ++frame) {
        samples[frame] = sine(frequency, frame);
    }
}

template <std::size_t N>
[[nodiscard]] double rms(const std::array<float, N>& samples,
                         std::size_t first, std::size_t end) {
    double sum = 0.0;
    for (std::size_t frame = first; frame < end; ++frame) {
        const double sample = static_cast<double>(samples[frame]);
        sum += sample * sample;
    }
    return std::sqrt(sum / static_cast<double>(end - first));
}

template <std::size_t N>
[[nodiscard]] double meanAbsoluteDifference(const std::array<float, N>& left,
                                             const std::array<float, N>& right,
                                             std::size_t first, std::size_t end) {
    double sum = 0.0;
    for (std::size_t frame = first; frame < end; ++frame) {
        sum += std::fabs(static_cast<double>(left[frame]) -
                         static_cast<double>(right[frame]));
    }
    return sum / static_cast<double>(end - first);
}

template <std::size_t N>
void render(const NativeOscBotConfig& config, const std::array<float, N>& input,
            std::array<float, N>& output) {
    NativeOscBotCore core;
    assert(core.setConfig(config));
    assert(core.prepare(kSampleRate));
    assert(core.processMono(input.data(), output.data(), output.size()));
}

void testBandBankCarrierAndWaveforms() {
    constexpr std::size_t frames = 8192U;
    std::array<float, frames> input{};
    std::array<float, frames> saw{};
    std::array<float, frames> square{};
    std::array<float, frames> triangle{};
    fillSine(input, 440.0);

    NativeOscBotConfig config;
    config.waveform = NativeOscBotWaveform::Saw;
    config.wetMix = 1.0f;
    config.toneCutoffHz = 16000.0f;
    NativeOscBotCore bankCore;
    assert(bankCore.setConfig(config));
    assert(bankCore.prepare(kSampleRate));
    assert(bankCore.filterBank().bandCount() == config.bands);
    float previousCenter = 0.0f;
    for (std::size_t band = 0U; band < config.bands; ++band) {
        const float center = bankCore.filterBank().centerFrequencyHz(band);
        assert(center > previousCenter);
        assert(center > 0.0f);
        previousCenter = center;
    }
    assert(bankCore.filterBank().centerFrequencyHz(config.bands) == 0.0f);
    assert(bankCore.processMono(input.data(), saw.data(), frames));
    assert(rms(saw, 2000U, frames) > 1.0e-4);

    config.waveform = NativeOscBotWaveform::Square;
    render(config, input, square);
    config.waveform = NativeOscBotWaveform::Triangle;
    render(config, input, triangle);
    assert(meanAbsoluteDifference(saw, square, 1000U, frames) > 1.0e-5);
    assert(meanAbsoluteDifference(square, triangle, 1000U, frames) > 1.0e-5);
}

void testPatternAndSampleClockedTempo() {
    constexpr std::size_t frames = 18000U;
    std::array<float, frames> input{};
    std::array<float, frames> patternZero{};
    std::array<float, frames> patternOne{};
    std::array<float, frames> fast{};
    std::array<float, frames> slow{};
    fillSine(input, 330.0);

    NativeOscBotConfig config;
    config.wetMix = 1.0f;
    config.toneCutoffHz = 16000.0f;
    config.pattern = 0;
    render(config, input, patternZero);
    config.pattern = 1;
    render(config, input, patternOne);
    assert(meanAbsoluteDifference(patternZero, patternOne, 6200U, 11000U) > 1.0e-5);

    NativeOscBotCore clock;
    assert(clock.setConfig(config));
    assert(clock.prepare(kSampleRate));
    assert(clock.stepFrames() == 6000U);
    std::array<float, 5999U> beforeBoundary{};
    std::array<float, 5999U> beforeOutput{};
    beforeBoundary.fill(0.25f);
    assert(clock.processMono(beforeBoundary.data(), beforeOutput.data(), beforeBoundary.size()));
    assert(clock.stepIndex() == 0U);
    const float lastFirstStep = clock.processSample(0.25f);
    assert(std::isfinite(lastFirstStep));
    assert(clock.currentFrame() == 6000U);
    const float firstSecondStep = clock.processSample(0.25f);
    assert(std::isfinite(firstSecondStep));
    assert(clock.stepIndex() == 1U);

    config.tempoBpm = 120.0f;
    render(config, input, fast);
    config.tempoBpm = 60.0f;
    render(config, input, slow);
    assert(meanAbsoluteDifference(fast, slow, 6100U, 11000U) > 1.0e-5);
}

void testToneResponseAndMix() {
    constexpr std::size_t frames = 16384U;
    std::array<float, frames> input{};
    std::array<float, frames> lowTone{};
    std::array<float, frames> highTone{};
    fillSine(input, 880.0);

    NativeOscBotConfig config;
    config.wetMix = 1.0f;
    config.pattern = 1;
    config.tempoBpm = 70.0f;
    config.toneCutoffHz = 250.0f;
    render(config, input, lowTone);
    config.toneCutoffHz = 12000.0f;
    render(config, input, highTone);
    assert(meanAbsoluteDifference(lowTone, highTone, 2000U, frames) > 1.0e-4);
    assert(rms(highTone, 2000U, frames) > rms(lowTone, 2000U, frames));

    config.wetMix = 0.0f;
    NativeOscBotCore dry;
    assert(dry.setConfig(config));
    assert(dry.prepare(kSampleRate));
    std::array<float, frames> dryOutput{};
    assert(dry.processMono(input.data(), dryOutput.data(), frames));
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        assert(std::fabs(dryOutput[frame] - input[frame]) < 1.0e-7f);
    }
}

void testVariableBlocksStereoAndFiniteBounds() {
    constexpr std::size_t frames = 4096U;
    std::array<float, frames> input{};
    std::array<float, frames> wholeOutput{};
    std::array<float, frames> chunkedOutput{};
    fillSine(input, 700.0);

    NativeOscBotCore whole;
    NativeOscBotCore chunked;
    NativeOscBotCore samplewise;
    NativeOscBotConfig config;
    config.pattern = 7;
    config.tempoBpm = 137.0f;
    config.waveform = NativeOscBotWaveform::Triangle;
    assert(whole.setConfig(config));
    assert(chunked.setConfig(config));
    assert(samplewise.setConfig(config));
    assert(whole.prepare(kSampleRate, 123U));
    assert(chunked.prepare(kSampleRate, 123U));
    assert(samplewise.prepare(kSampleRate, 123U));
    assert(whole.processMono(input.data(), wholeOutput.data(), frames));

    constexpr std::array<std::size_t, 7U> chunks{{1U, 17U, 64U, 3U, 255U, 511U, 32U}};
    std::size_t cursor = 0U;
    std::size_t chunkIndex = 0U;
    while (cursor < frames) {
        const std::size_t count = std::min(chunks[chunkIndex % chunks.size()], frames - cursor);
        assert(chunked.processMono(input.data() + cursor, chunkedOutput.data() + cursor, count));
        cursor += count;
        ++chunkIndex;
    }
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        assert(std::fabs(wholeOutput[frame] - chunkedOutput[frame]) < 1.0e-7f);
        assert(std::fabs(wholeOutput[frame] - samplewise.processSample(input[frame])) < 1.0e-7f);
    }
    assert(whole.currentFrame() == 123U + frames);
    assert(chunked.currentFrame() == 123U + frames);
    assert(samplewise.currentFrame() == 123U + frames);

    NativeOscBotCore stereoCore;
    assert(stereoCore.prepare(kSampleRate));
    std::array<float, frames * 2U> stereo{};
    std::array<float, frames * 2U> stereoOutput{};
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        stereo[2U * frame] = 0.25f;
        stereo[(2U * frame) + 1U] = -0.10f;
    }
    assert(stereoCore.processStereo(stereo.data(), stereoOutput.data(), frames));
    bool channelDifferenceSeen = false;
    for (const float value : stereoOutput) {
        assert(std::isfinite(value));
        assert(std::fabs(value) <= 4.0f);
    }
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        channelDifferenceSeen = channelDifferenceSeen ||
            std::fabs(stereoOutput[2U * frame] - stereoOutput[(2U * frame) + 1U]) > 1.0e-4f;
    }
    assert(channelDifferenceSeen);
    assert(stereoCore.processInPlace(stereo.data(), frames, 2U));
    assert(!stereoCore.processInPlace(stereo.data(), frames, 3U));

    NativeOscBotCore bounded;
    assert(bounded.prepare(kSampleRate));
    std::array<float, 5U> pathological{{std::numeric_limits<float>::quiet_NaN(),
        std::numeric_limits<float>::infinity(), -std::numeric_limits<float>::infinity(),
        1.0e30f, -1.0e30f}};
    std::array<float, 5U> boundedOutput{};
    assert(bounded.processMono(pathological.data(), boundedOutput.data(), pathological.size()));
    for (const float value : boundedOutput) {
        assert(std::isfinite(value));
        assert(std::fabs(value) <= 4.0f);
    }
}

void testInvalidConfigurationAndNoAllocation() {
    NativeOscBotCore unprepared;
    assert(!unprepared.prepare(7999U));
    assert(!unprepared.prepare(kSampleRate, std::numeric_limits<std::uint64_t>::max()));

    NativeOscBotCore core;
    assert(core.prepare(kSampleRate));
    assert(!core.setParameter("bands", 7.0f));
    assert(!core.setParameter("bands", 24.5f));
    assert(!core.setParameter("waveform", 3.0f));
    assert(!core.setParameter("waveform", 1.5f));
    assert(!core.setParameter("pattern", -1.0f));
    assert(!core.setParameter("pattern", 8.0f));
    assert(!core.setParameter("tone", 99.0f));
    assert(!core.setParameter("tone", 16001.0f));
    assert(!core.setParameter("tone", std::numeric_limits<float>::quiet_NaN()));
    assert(!core.setParameter("tempo", 29.0f));
    assert(!core.setParameter("bpm", 301.0f));
    assert(!core.setParameter("mix", 100.1f));
    assert(!core.setParameter("unknown", 1.0f));
    assert(core.setParameter("pattern", 4.0f));
    assert(core.setParameter("tempo", 95.0f));
    assert(core.setParameter("tone", 1800.0f));
    assert(core.setParameter("mix", 25.0f, 32U));

    NativeOscBotCore lowSampleRate;
    assert(lowSampleRate.prepare(8000U));
    assert(!lowSampleRate.setParameter("tone", 3920.0f));

    constexpr std::size_t frames = 2048U;
    std::array<float, frames> input{};
    std::array<float, frames> output{};
    std::array<float, frames * 2U> stereo{};
    std::array<float, frames * 2U> stereoOutput{};
    fillSine(input);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        stereo[2U * frame] = input[frame];
        stereo[(2U * frame) + 1U] = -input[frame];
    }

    NativeOscBotCore allocationCore;
    assert(allocationCore.prepare(kSampleRate));
    test_alloc::beginTracking();
    assert(allocationCore.processMono(input.data(), output.data(), frames));
    assert(allocationCore.processStereo(stereo.data(), stereoOutput.data(), frames));
    test_alloc::endTracking();
    assert(test_alloc::count() == 0U);
}

} // namespace

int main() {
    testBandBankCarrierAndWaveforms();
    testPatternAndSampleClockedTempo();
    testToneResponseAndMix();
    testVariableBlocksStereoAndFiniteBounds();
    testInvalidConfigurationAndNoAllocation();
    return 0;
}
