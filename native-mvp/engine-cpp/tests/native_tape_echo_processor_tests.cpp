#include "native_tape_echo_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <limits>
#include <vector>

using namespace webrc::native;

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;

void expectNear(float actual, float expected, float tolerance = 1.0e-5f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

NativeTapeEchoProcessorConfig audibleConfig() {
    NativeTapeEchoProcessorConfig config;
    config.enabled = true;
    config.timeMs = 100.0f;
    config.feedbackPercent = 0.0f;
    config.wowFlutterPercent = 0.0f;
    config.saturationPercent = 0.0f;
    config.toneHz = 16000.0f;
    config.mixPercent = 100.0f;
    return config;
}

void testPreparationDescriptorBoundsAndTransactionalConfiguration() {
    for (const unsigned int rate : {44100U, 48000U, 96000U}) {
        NativeTapeEchoProcessor processor;
        assert(processor.prepare(rate));
        assert(processor.sampleRate() == rate);
        assert(processor.recordPathLatencyFrames() == 24U);
        assert(processor.delayCapacityFrames() >= static_cast<std::size_t>(rate) * 6U);

        const auto config = audibleConfig();
        assert(processor.setConfig(config, 0U));
        assert(processor.config().enabled);
        expectNear(processor.config().timeMs, 100.0f);
        expectNear(processor.config().mixPercent, 100.0f);
    }

    NativeTapeEchoProcessor processor;
    assert(!processor.prepare(7999U));
    assert(processor.prepare(48000U));
    assert(processor.prepare(192000U));
    assert(!processor.prepare(192001U));
    assert(processor.sampleRate() == 192000U); // Invalid re-prepare is non-destructive.

    auto valid = audibleConfig();
    valid.timeMs = 735.0f;
    valid.feedbackPercent = 70.0f;
    valid.wowFlutterPercent = 22.0f;
    valid.saturationPercent = 40.0f;
    valid.toneHz = 5100.0f;
    valid.mixPercent = 65.0f;
    assert(processor.setConfig(valid, 0U));

    auto invalid = valid;
    invalid.timeMs = 19.99f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.timeMs = 2000.01f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.feedbackPercent = 95.01f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.wowFlutterPercent = -0.01f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.saturationPercent = std::numeric_limits<float>::infinity();
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.toneHz = 499.0f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.mixPercent = std::numeric_limits<float>::quiet_NaN();
    assert(!processor.setConfig(invalid));

    assert(processor.config().timeMs == valid.timeMs);
    assert(processor.config().feedbackPercent == valid.feedbackPercent);
    assert(processor.config().wowFlutterPercent == valid.wowFlutterPercent);
    assert(processor.config().saturationPercent == valid.saturationPercent);
    assert(processor.config().toneHz == valid.toneHz);
    assert(processor.config().mixPercent == valid.mixPercent);
}

void testFractionalHeadTimingAndThreeDistinctPlaybackHeads() {
    for (const unsigned int rate : {44100U, 48000U, 96000U}) {
        NativeTapeEchoProcessor processor;
        assert(processor.prepare(rate));
        auto config = audibleConfig();
        config.timeMs = 100.0f;
        assert(processor.setConfig(config, 0U));

        const std::size_t delayFrames = static_cast<std::size_t>(rate / 10U);
        const std::size_t saturationLatency = processor.recordPathLatencyFrames();
        const std::size_t totalFrames = delayFrames * 3U + saturationLatency + 16U;
        std::vector<float> impulse(totalFrames * 2U, 0.0f);
        impulse[0U] = 0.5f;
        impulse[1U] = 0.5f;
        (void)processor.processInPlace(impulse.data(), static_cast<unsigned int>(totalFrames), 2U);

        // Saturation=0 uses the Native saturation processor's exactly aligned
        // dry path, so the first/second/third head arrivals are deterministic.
        const std::array<float, 3U> expected{{0.275f, 0.15f, 0.075f}};
        for (std::size_t head = 0U; head < expected.size(); ++head) {
            const std::size_t arrival = delayFrames * (head + 1U) + saturationLatency;
            expectNear(impulse[arrival * 2U], expected[head], 2.0e-5f);
            expectNear(impulse[arrival * 2U + 1U], expected[head], 2.0e-5f);
        }
        for (std::size_t frame = 0U; frame < delayFrames + saturationLatency; ++frame) {
            expectNear(impulse[frame * 2U], 0.0f, 1.0e-7f);
        }
    }
}

void testFeedbackTailDampsAndDecays() {
    constexpr unsigned int rate = 48000U;
    constexpr std::size_t totalFrames = static_cast<std::size_t>(rate) * 2U;
    NativeTapeEchoProcessor processor;
    assert(processor.prepare(rate));
    auto config = audibleConfig();
    config.timeMs = 100.0f;
    config.feedbackPercent = 88.0f;
    config.toneHz = 1200.0f;
    assert(processor.setConfig(config, 0U));

    std::vector<float> impulse(totalFrames * 2U, 0.0f);
    impulse[0U] = 0.7f;
    impulse[1U] = 0.7f;
    (void)processor.processInPlace(impulse.data(), static_cast<unsigned int>(totalFrames), 2U);

    double earlyEnergy = 0.0;
    double lateEnergy = 0.0;
    for (std::size_t frame = rate / 10U; frame < rate / 2U; ++frame) {
        earlyEnergy += static_cast<double>(impulse[frame * 2U]) * impulse[frame * 2U];
    }
    for (std::size_t frame = rate * 3U / 2U; frame < totalFrames; ++frame) {
        lateEnergy += static_cast<double>(impulse[frame * 2U]) * impulse[frame * 2U];
    }
    assert(earlyEnergy > 0.01);
    assert(lateEnergy > 0.0);
    assert(lateEnergy < earlyEnergy * 0.2);
    for (const float sample : impulse) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) <= 8.0f);
    }

    // A lower loss cutoff attenuates the high-frequency repeated tail more.
    NativeTapeEchoProcessor lowTone;
    NativeTapeEchoProcessor highTone;
    assert(lowTone.prepare(rate));
    assert(highTone.prepare(rate));
    auto lowConfig = audibleConfig();
    auto highConfig = lowConfig;
    lowConfig.timeMs = highConfig.timeMs = 100.0f;
    lowConfig.feedbackPercent = highConfig.feedbackPercent = 90.0f;
    lowConfig.toneHz = 500.0f;
    highConfig.toneHz = 16000.0f;
    assert(lowTone.setConfig(lowConfig, 0U));
    assert(highTone.setConfig(highConfig, 0U));
    std::vector<float> highFrequency(totalFrames * 2U, 0.0f);
    for (std::size_t frame = 0U; frame < 512U; ++frame) {
        const float sample = static_cast<float>(0.5 * std::sin(2.0 * kPi * 6000.0 * static_cast<double>(frame) / rate));
        highFrequency[frame * 2U] = sample;
        highFrequency[frame * 2U + 1U] = sample;
    }
    auto lowTail = highFrequency;
    auto highTail = highFrequency;
    (void)lowTone.processInPlace(lowTail.data(), static_cast<unsigned int>(totalFrames), 2U);
    (void)highTone.processInPlace(highTail.data(), static_cast<unsigned int>(totalFrames), 2U);
    double lowTailEnergy = 0.0;
    double highTailEnergy = 0.0;
    const std::size_t lateStart = rate / 2U;
    for (std::size_t frame = lateStart; frame < totalFrames; ++frame) {
        lowTailEnergy += static_cast<double>(lowTail[frame * 2U]) * lowTail[frame * 2U];
        highTailEnergy += static_cast<double>(highTail[frame * 2U]) * highTail[frame * 2U];
    }
    assert(highTailEnergy > lowTailEnergy * 1.15);

    // Even with the loudest saturation blend, the oversampled record path's
    // small-signal gain compensation keeps a 95% feedback setting contractive.
    NativeTapeEchoProcessor saturatedTail;
    assert(saturatedTail.prepare(rate));
    auto saturatedConfig = audibleConfig();
    saturatedConfig.timeMs = 100.0f;
    saturatedConfig.feedbackPercent = 95.0f;
    saturatedConfig.wowFlutterPercent = 0.0f;
    saturatedConfig.saturationPercent = 100.0f;
    saturatedConfig.toneHz = 16000.0f;
    assert(saturatedTail.setConfig(saturatedConfig, 0U));
    constexpr std::size_t saturatedFrames = static_cast<std::size_t>(rate) * 3U;
    std::vector<float> saturatedImpulse(saturatedFrames * 2U, 0.0f);
    saturatedImpulse[0U] = 0.6f;
    saturatedImpulse[1U] = 0.6f;
    (void)saturatedTail.processInPlace(saturatedImpulse.data(), static_cast<unsigned int>(saturatedFrames), 2U);
    double saturatedEarly = 0.0;
    double saturatedLate = 0.0;
    for (std::size_t frame = rate / 10U; frame < rate / 2U; ++frame) {
        saturatedEarly += static_cast<double>(saturatedImpulse[frame * 2U]) * saturatedImpulse[frame * 2U];
    }
    for (std::size_t frame = rate * 2U; frame < saturatedFrames; ++frame) {
        saturatedLate += static_cast<double>(saturatedImpulse[frame * 2U]) * saturatedImpulse[frame * 2U];
    }
    assert(saturatedEarly > 0.0);
    assert(saturatedLate < saturatedEarly * 0.05);
}

void testWowFlutterAndControlRampsAreSmoothAndChunkInvariant() {
    constexpr unsigned int rate = 48000U;
    constexpr std::size_t frames = 24000U;
    NativeTapeEchoProcessor moving;
    NativeTapeEchoProcessor fixed;
    assert(moving.prepare(rate));
    assert(fixed.prepare(rate));
    auto movingConfig = audibleConfig();
    movingConfig.timeMs = 73.25f; // Exercise non-integral fractional-delay reads.
    movingConfig.wowFlutterPercent = 100.0f;
    auto fixedConfig = movingConfig;
    fixedConfig.wowFlutterPercent = 0.0f;
    assert(moving.setConfig(movingConfig, 0U));
    assert(fixed.setConfig(fixedConfig, 0U));

    std::vector<float> tone(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const float sample = static_cast<float>(0.45 * std::sin(
            2.0 * kPi * 440.0 * static_cast<double>(frame) / static_cast<double>(rate)));
        tone[frame * 2U] = sample;
        tone[frame * 2U + 1U] = sample;
    }
    auto movingOutput = tone;
    auto fixedOutput = tone;
    (void)moving.processInPlace(movingOutput.data(), static_cast<unsigned int>(frames), 2U);
    (void)fixed.processInPlace(fixedOutput.data(), static_cast<unsigned int>(frames), 2U);
    double differenceEnergy = 0.0;
    double referenceEnergy = 0.0;
    for (std::size_t frame = rate / 10U; frame < frames; ++frame) {
        const double difference = static_cast<double>(movingOutput[frame * 2U] - fixedOutput[frame * 2U]);
        differenceEnergy += difference * difference;
        referenceEnergy += static_cast<double>(fixedOutput[frame * 2U]) * fixedOutput[frame * 2U];
    }
    assert(differenceEnergy > referenceEnergy * 0.002);

    NativeTapeEchoProcessor wholeProcessor;
    NativeTapeEchoProcessor chunkedProcessor;
    assert(wholeProcessor.prepare(rate));
    assert(chunkedProcessor.prepare(rate));
    auto rampStart = audibleConfig();
    rampStart.timeMs = 87.5f;
    rampStart.feedbackPercent = 50.0f;
    rampStart.wowFlutterPercent = 25.0f;
    rampStart.saturationPercent = 35.0f;
    rampStart.toneHz = 8000.0f;
    rampStart.mixPercent = 60.0f;
    assert(wholeProcessor.setConfig(rampStart, 0U));
    assert(chunkedProcessor.setConfig(rampStart, 0U));
    auto rampTarget = rampStart;
    rampTarget.timeMs = 260.0f;
    rampTarget.feedbackPercent = 75.0f;
    rampTarget.wowFlutterPercent = 85.0f;
    rampTarget.saturationPercent = 72.0f;
    rampTarget.toneHz = 2400.0f;
    rampTarget.mixPercent = 82.0f;
    assert(wholeProcessor.setConfig(rampTarget, 333U));
    assert(chunkedProcessor.setConfig(rampTarget, 333U));

    constexpr std::size_t invariantFrames = 4097U;
    std::vector<float> input(invariantFrames * 2U);
    for (std::size_t frame = 0U; frame < invariantFrames; ++frame) {
        input[frame * 2U] = static_cast<float>(std::sin(static_cast<double>(frame) * 0.021) * 0.4);
        input[frame * 2U + 1U] = static_cast<float>(std::cos(static_cast<double>(frame) * 0.017) * 0.3);
    }
    auto whole = input;
    auto chunked = input;
    (void)wholeProcessor.processInPlace(whole.data(), static_cast<unsigned int>(invariantFrames), 2U);

    constexpr std::array<unsigned int, 7U> chunks{{1U, 63U, 64U, 255U, 511U, 1024U, 17U}};
    std::size_t offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < invariantFrames) {
        const auto count = std::min<std::size_t>(chunks[chunkIndex % chunks.size()], invariantFrames - offset);
        (void)chunkedProcessor.processInPlace(
            chunked.data() + offset * 2U,
            static_cast<unsigned int>(count),
            2U
        );
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t index = 0U; index < whole.size(); ++index) {
        expectNear(whole[index], chunked[index], 3.0e-6f);
    }
}

void testFiniteBoundsResetAndAllocationFreeCallback() {
    constexpr unsigned int rate = 48000U;
    NativeTapeEchoProcessor processor;
    assert(processor.prepare(rate));
    auto config = audibleConfig();
    config.timeMs = 20.0f;
    config.feedbackPercent = 95.0f;
    config.wowFlutterPercent = 100.0f;
    config.saturationPercent = 100.0f;
    config.toneHz = 500.0f;
    assert(processor.setConfig(config, 0U));

    constexpr unsigned int frames = 8192U;
    std::vector<float> stress(static_cast<std::size_t>(frames) * 3U);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const std::size_t offset = static_cast<std::size_t>(frame) * 3U;
        stress[offset] = frame % 3U == 0U ? std::numeric_limits<float>::max() : 8.0f;
        stress[offset + 1U] = frame % 2U == 0U ? -8.0f : 8.0f;
        stress[offset + 2U] = static_cast<float>(frame) * 0.001f;
    }
    const auto extraChannel = stress;
    std::array<float, 32U> callback{};
    for (std::size_t index = 0U; index < callback.size(); ++index) {
        callback[index] = static_cast<float>(std::sin(static_cast<double>(index) * 0.13) * 0.4);
    }

    const std::size_t before = test_alloc::count();
    test_alloc::beginTracking();
    const float peak = processor.processInPlace(stress.data(), frames, 3U);
    (void)processor.processInPlace(callback.data(), 16U, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == before);
    assert(std::isfinite(peak));
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const std::size_t offset = static_cast<std::size_t>(frame) * 3U;
        assert(std::isfinite(stress[offset]));
        assert(std::isfinite(stress[offset + 1U]));
        assert(std::fabs(stress[offset]) <= 8.0f);
        assert(std::fabs(stress[offset + 1U]) <= 8.0f);
        expectNear(stress[offset + 2U], extraChannel[offset + 2U], 0.0f);
    }

    std::array<float, 4U> invalids{{
        std::numeric_limits<float>::quiet_NaN(),
        std::numeric_limits<float>::infinity(),
        -std::numeric_limits<float>::infinity(),
        std::numeric_limits<float>::max()
    }};
    (void)processor.processInPlace(invalids.data(), 2U, 2U);
    for (const float sample : invalids) assert(std::isfinite(sample));

    processor.reset();
    auto timingConfig = audibleConfig();
    timingConfig.timeMs = 20.0f;
    assert(processor.setConfig(timingConfig, 0U));
    std::array<float, 2048U> resetImpulse{};
    resetImpulse[0U] = 0.5f;
    resetImpulse[1U] = 0.5f;
    (void)processor.processInPlace(resetImpulse.data(), 1024U, 2U);
    const std::size_t arrival = rate / 50U + processor.recordPathLatencyFrames();
    expectNear(resetImpulse[arrival * 2U], 0.275f, 2.0e-5f);

    assert(processor.processInPlace(nullptr, 64U, 2U) == 0.0f);
    assert(processor.processInPlace(callback.data(), 0U, 2U) == 0.0f);
    assert(processor.processInPlace(callback.data(), 4U, 0U) == 0.0f);
}

} // namespace

int main() {
    testPreparationDescriptorBoundsAndTransactionalConfiguration();
    testFractionalHeadTimingAndThreeDistinctPlaybackHeads();
    testFeedbackTailDampsAndDecays();
    testWowFlutterAndControlRampsAreSmoothAndChunkInvariant();
    testFiniteBoundsResetAndAllocationFreeCallback();
    return 0;
}
