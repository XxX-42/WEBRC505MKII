#include "native_panning_delay_processor.hpp"
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

void expectNear(float actual, float expected, float tolerance = 1.0e-5f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

NativePanningDelayProcessorConfig wetConfig(float panPercent = 0.0f) {
    NativePanningDelayProcessorConfig config;
    config.timeMs = 10.0f;
    config.feedbackPercent = 0.0f;
    config.panPercent = panPercent;
    config.mixPercent = 100.0f;
    return config;
}

void testPreparationAndValidatedConfiguration() {
    NativePanningDelayProcessor processor;
    assert(!processor.prepare(7999U));
    assert(processor.prepare(48000U));
    assert(processor.sampleRate() == 48000U);
    assert(processor.delayCapacityFrames() >= 96004U);
    assert(processor.prepare(192000U));
    assert(processor.delayCapacityFrames() >= 384004U);
    assert(!processor.prepare(192001U));
    assert(processor.sampleRate() == 192000U);

    auto valid = wetConfig(-100.0f);
    valid.timeMs = 1.0f;
    valid.feedbackPercent = 95.0f;
    valid.mixPercent = 100.0f;
    assert(processor.setConfig(valid, 0U));
    const auto original = processor.config();
    auto invalid = valid;
    invalid.timeMs = 0.99f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.timeMs = 2000.01f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.feedbackPercent = 95.01f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.panPercent = -100.01f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.panPercent = 100.01f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.mixPercent = std::numeric_limits<float>::quiet_NaN();
    assert(!processor.setConfig(invalid));
    assert(processor.config().timeMs == original.timeMs);
    assert(processor.config().feedbackPercent == original.feedbackPercent);
    assert(processor.config().panPercent == original.panPercent);
    assert(processor.config().mixPercent == original.mixPercent);
}

void testFractionalDelayAndEqualPowerPan() {
    constexpr unsigned int rate = 48000U;
    constexpr std::size_t delayFrames = 480U;

    const auto runImpulse = [](float pan) {
        NativePanningDelayProcessor processor;
        assert(processor.prepare(rate));
        auto config = wetConfig(pan);
        config.timeMs = 10.0104167f; // 480.5 frames at 48 kHz exercises fractional reads.
        assert(processor.setConfig(config, 0U));
        constexpr std::size_t count = delayFrames + 8U;
        std::vector<float> samples(count * 2U, 0.0f);
        samples[0U] = 1.0f;
        (void)processor.processInPlace(samples.data(), static_cast<unsigned int>(count), 2U);
        return samples;
    };

    const auto hardLeft = runImpulse(-100.0f);
    const auto center = runImpulse(0.0f);
    const auto hardRight = runImpulse(100.0f);
    const float leftEarly = hardLeft[delayFrames * 2U];
    const float leftLate = hardLeft[(delayFrames + 1U) * 2U];
    assert(leftEarly > 0.1f && leftLate > 0.1f); // The impulse is split across fractional taps.
    expectNear(hardLeft[delayFrames * 2U + 1U], 0.0f);
    expectNear(hardLeft[(delayFrames + 1U) * 2U + 1U], 0.0f);
    expectNear(hardRight[delayFrames * 2U], 0.0f);
    expectNear(hardRight[delayFrames * 2U + 1U], leftEarly, 1.0e-6f);
    expectNear(center[delayFrames * 2U], center[delayFrames * 2U + 1U], 1.0e-6f);
    expectNear(center[(delayFrames + 1U) * 2U], center[(delayFrames + 1U) * 2U + 1U], 1.0e-6f);
}

void testCrossFeedbackTailAndMixControls() {
    constexpr unsigned int rate = 48000U;
    constexpr std::size_t delayFrames = rate / 1000U;
    constexpr std::size_t frames = delayFrames * 4U + 16U;
    NativePanningDelayProcessor processor;
    assert(processor.prepare(rate));
    auto config = wetConfig(-100.0f);
    config.timeMs = 1.0f;
    config.feedbackPercent = 50.0f;
    assert(processor.setConfig(config, 0U));

    std::vector<float> impulse(frames * 2U, 0.0f);
    impulse[0U] = 1.0f;
    (void)processor.processInPlace(impulse.data(), static_cast<unsigned int>(frames), 2U);
    const float firstRepeat = impulse[delayFrames * 2U];
    const float crossFeedbackRepeat = impulse[delayFrames * 4U];
    assert(firstRepeat > 0.5f);
    assert(crossFeedbackRepeat > 0.2f && crossFeedbackRepeat < firstRepeat);

    NativePanningDelayProcessor dryOnly;
    assert(dryOnly.prepare(rate));
    auto dryConfig = config;
    dryConfig.mixPercent = 0.0f;
    assert(dryOnly.setConfig(dryConfig, 0U));
    std::array<float, 6U> frame{{0.25f, -0.5f, 0.75f, -1.0f, 0.3f, 0.0f}};
    (void)dryOnly.processInPlace(frame.data(), 2U, 3U);
    expectNear(frame[0U], 0.25f);
    expectNear(frame[1U], -0.5f);
    expectNear(frame[2U], 0.75f);
    expectNear(frame[3U], -1.0f);
    expectNear(frame[4U], 0.3f);
    expectNear(frame[5U], 0.0f);
}

void testMonoSanitizationChunkInvarianceAndNoCallbackAllocations() {
    constexpr unsigned int rate = 48000U;
    constexpr std::size_t frames = 4097U;
    NativePanningDelayProcessor whole;
    NativePanningDelayProcessor chunked;
    assert(whole.prepare(rate));
    assert(chunked.prepare(rate));
    auto initial = wetConfig(35.0f);
    initial.timeMs = 21.375f;
    initial.feedbackPercent = 63.0f;
    initial.mixPercent = 57.0f;
    assert(whole.setConfig(initial, 0U));
    assert(chunked.setConfig(initial, 0U));
    auto target = initial;
    target.timeMs = 73.125f;
    target.feedbackPercent = 74.0f;
    target.panPercent = -67.0f;
    target.mixPercent = 82.0f;
    assert(whole.setConfig(target, 333U));
    assert(chunked.setConfig(target, 333U));

    std::vector<float> input(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        input[frame * 2U] = static_cast<float>(std::sin(static_cast<double>(frame) * 0.019) * 0.4);
        input[frame * 2U + 1U] = static_cast<float>(std::cos(static_cast<double>(frame) * 0.023) * 0.3);
    }
    auto wholeOutput = input;
    auto chunkedOutput = input;
    (void)whole.processInPlace(wholeOutput.data(), static_cast<unsigned int>(frames), 2U);

    std::size_t offset = 0U;
    for (const unsigned int chunk : {1U, 13U, 128U, 7U, 511U, 2U, 1024U}) {
        const unsigned int count = static_cast<unsigned int>(std::min<std::size_t>(chunk, frames - offset));
        if (count == 0U) break;
        (void)chunked.processInPlace(chunkedOutput.data() + offset * 2U, count, 2U);
        offset += count;
    }
    if (offset < frames) {
        (void)chunked.processInPlace(
            chunkedOutput.data() + offset * 2U,
            static_cast<unsigned int>(frames - offset),
            2U
        );
    }
    for (std::size_t index = 0U; index < wholeOutput.size(); ++index) {
        expectNear(chunkedOutput[index], wholeOutput[index], 1.0e-6f);
    }

    NativePanningDelayProcessor mono;
    assert(mono.prepare(rate));
    auto monoConfig = wetConfig(100.0f);
    monoConfig.timeMs = 1.0f;
    assert(mono.setConfig(monoConfig, 0U));
    std::array<float, 16U> monoInput{};
    monoInput[0U] = 0.6f;
    std::size_t allocationBaseline = 0U;
    test_alloc::beginTracking();
    allocationBaseline = test_alloc::count();
    const float peak = mono.processInPlace(monoInput.data(), static_cast<unsigned int>(monoInput.size()), 1U);
    const std::size_t allocationsDuringCallback = test_alloc::count() - allocationBaseline;
    test_alloc::endTracking();
    assert(allocationsDuringCallback == 0U);
    assert(peak >= 0.0f && std::isfinite(peak));
    for (const float sample : monoInput) assert(std::isfinite(sample) && std::fabs(sample) <= 8.0f);

    NativePanningDelayProcessor extraChannels;
    assert(extraChannels.prepare(rate));
    auto passConfig = wetConfig();
    passConfig.mixPercent = 0.0f;
    assert(extraChannels.setConfig(passConfig, 0U));
    std::array<float, 3U> threeChannel{{0.25f, -0.5f, std::numeric_limits<float>::quiet_NaN()}};
    (void)extraChannels.processInPlace(threeChannel.data(), 1U, 3U);
    expectNear(threeChannel[0U], 0.25f);
    expectNear(threeChannel[1U], -0.5f);
    expectNear(threeChannel[2U], 0.0f);
}

} // namespace

int main() {
    testPreparationAndValidatedConfiguration();
    testFractionalDelayAndEqualPowerPan();
    testCrossFeedbackTailAndMixControls();
    testMonoSanitizationChunkInvarianceAndNoCallbackAllocations();
}
