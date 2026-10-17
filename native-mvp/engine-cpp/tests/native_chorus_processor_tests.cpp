#include "native_chorus_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <vector>

using namespace webrc::native;

namespace {

void expectNear(float actual, float expected, float tolerance = 1.0e-6f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

void testPrepareAndDryBypass() {
    NativeChorusProcessor chorus;
    assert(!chorus.prepare(0U));
    assert(chorus.prepare(48000U));
    assert(chorus.sampleRate() == 48000U);
    assert(!chorus.enabled());

    ChorusProcessorConfig bypassConfig;
    bypassConfig.enabled = false;
    bypassConfig.rateHz = 1.4f;
    bypassConfig.depthMs = 20.0f;
    bypassConfig.feedback = 0.8f;
    bypassConfig.wetMix = 1.0f;
    assert(chorus.setConfig(bypassConfig, 0U));
    std::array<float, 8> samples{{1.25f, -1.5f, 0.8f, -0.7f, 0.1f, 0.2f, -0.3f, 0.4f}};
    const auto original = samples;
    const auto peak = chorus.processInPlace(samples.data(), 4U, 2U);
    expectNear(peak, 1.5f);
    for (std::size_t sample = 0; sample < samples.size(); ++sample) {
        expectNear(samples[sample], original[sample], 0.0f);
    }
}

void testStereoLfoMotionAndFeedbackTailStability() {
    constexpr unsigned int sampleRate = 48000U;
    NativeChorusProcessor chorus;
    assert(chorus.prepare(sampleRate));
    ChorusProcessorConfig config;
    config.enabled = true;
    config.rateHz = 0.8f;
    config.depthMs = 10.0f;
    config.feedback = 0.2f;
    config.wetMix = 1.0f;
    assert(chorus.setConfig(config, 0U));

    constexpr std::size_t frames = sampleRate;
    std::vector<float> tone(frames * 2U);
    for (std::size_t frame = 0; frame < frames; ++frame) {
        const float sample = static_cast<float>(0.7 * std::sin(2.0 * 3.14159265358979323846 * 440.0 * static_cast<double>(frame) / sampleRate));
        tone[frame * 2U] = sample;
        tone[frame * 2U + 1U] = sample;
    }
    (void)chorus.processInPlace(tone.data(), static_cast<unsigned int>(frames), 2U);
    double stereoDifferenceEnergy = 0.0;
    for (std::size_t frame = sampleRate / 4U; frame < sampleRate * 3U / 4U; ++frame) {
        const double difference = static_cast<double>(tone[frame * 2U] - tone[frame * 2U + 1U]);
        stereoDifferenceEnergy += difference * difference;
    }
    assert(stereoDifferenceEnergy > 1.0);
    for (const float sample : tone) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) < 2.0f);
    }

    for (const unsigned int rate : {44100U, 48000U, 96000U}) {
        NativeChorusProcessor tailProcessor;
        assert(tailProcessor.prepare(rate));
        config.rateHz = 0.7f;
        config.depthMs = 15.0f;
        config.feedback = 0.95f;
        assert(tailProcessor.setConfig(config, 0U));
        const auto tailFrames = static_cast<std::size_t>(rate) * 2U;
        std::vector<float> impulse(tailFrames * 2U, 0.0f);
        impulse[0] = 0.7f;
        impulse[1] = 0.7f;
        (void)tailProcessor.processInPlace(impulse.data(), static_cast<unsigned int>(tailFrames), 2U);
        double earlyEnergy = 0.0;
        double lateEnergy = 0.0;
        for (std::size_t frame = rate / 10U; frame < rate / 2U; ++frame) {
            earlyEnergy += static_cast<double>(impulse[frame * 2U]) * impulse[frame * 2U];
            earlyEnergy += static_cast<double>(impulse[frame * 2U + 1U]) * impulse[frame * 2U + 1U];
        }
        for (std::size_t frame = rate * 3U / 2U; frame < tailFrames; ++frame) {
            lateEnergy += static_cast<double>(impulse[frame * 2U]) * impulse[frame * 2U];
            lateEnergy += static_cast<double>(impulse[frame * 2U + 1U]) * impulse[frame * 2U + 1U];
        }
        assert(earlyEnergy > 0.0);
        assert(lateEnergy < earlyEnergy);
        for (const float sample : impulse) {
            assert(std::isfinite(sample));
            assert(std::fabs(sample) < 2.0f);
        }
    }
}

void testBlockSegmentationAndAllocationFreeProcessing() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = 4096U;
    NativeChorusProcessor wholeProcessor;
    NativeChorusProcessor chunkedProcessor;
    assert(wholeProcessor.prepare(sampleRate));
    assert(chunkedProcessor.prepare(sampleRate));
    ChorusProcessorConfig config;
    config.enabled = true;
    config.rateHz = 1.8f;
    config.depthMs = 7.5f;
    config.feedback = 0.35f;
    config.wetMix = 0.6f;
    assert(wholeProcessor.setConfig(config, 257U));
    assert(chunkedProcessor.setConfig(config, 257U));

    std::vector<float> input(frames * 2U);
    for (std::size_t frame = 0; frame < frames; ++frame) {
        input[frame * 2U] = static_cast<float>(std::sin(static_cast<double>(frame) * 0.021) * 0.4);
        input[frame * 2U + 1U] = static_cast<float>(std::cos(static_cast<double>(frame) * 0.017) * 0.3);
    }
    auto whole = input;
    auto chunked = input;
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)wholeProcessor.processInPlace(whole.data(), static_cast<unsigned int>(frames), 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);

    constexpr std::array<unsigned int, 6> chunks{{1U, 63U, 64U, 255U, 511U, 1024U}};
    std::size_t offset = 0;
    std::size_t chunkIndex = 0;
    while (offset < frames) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(chunks[chunkIndex % chunks.size()], frames - offset));
        (void)chunkedProcessor.processInPlace(chunked.data() + offset * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t sample = 0; sample < whole.size(); ++sample) {
        expectNear(chunked[sample], whole[sample]);
    }

    NativeChorusProcessor callbackSizedProcessor;
    assert(callbackSizedProcessor.prepare(sampleRate));
    assert(callbackSizedProcessor.setConfig(config, 64U));
    std::array<float, 128> callbackSizedBlock{};
    callbackSizedBlock.fill(0.25f);
    const auto callbackAllocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)callbackSizedProcessor.processInPlace(callbackSizedBlock.data(), 64U, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == callbackAllocationsBefore);
}

void testConfigurationValidationAndExtraChannelPassThrough() {
    NativeChorusProcessor chorus;
    assert(chorus.prepare(44100U));
    ChorusProcessorConfig config;
    config.rateHz = 8.1f;
    assert(!chorus.setConfig(config));
    config.rateHz = 1.0f;
    config.depthMs = 25.1f;
    assert(!chorus.setConfig(config));
    config.depthMs = 25.0f;
    config.feedback = 0.951f;
    assert(!chorus.setConfig(config));

    std::array<float, 6> threeChannel{{0.1f, -0.2f, 0.3f, -0.4f, 0.5f, 0.6f}};
    const auto extraBefore = std::array<float, 2>{{threeChannel[2], threeChannel[5]}};
    (void)chorus.processInPlace(threeChannel.data(), 2U, 3U);
    expectNear(threeChannel[2], extraBefore[0], 0.0f);
    expectNear(threeChannel[5], extraBefore[1], 0.0f);
}

} // namespace

int main() {
    testPrepareAndDryBypass();
    testStereoLfoMotionAndFeedbackTailStability();
    testBlockSegmentationAndAllocationFreeProcessing();
    testConfigurationValidationAndExtraChannelPassThrough();
    return 0;
}
