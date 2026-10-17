#include "native_freeze_processor.hpp"
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

NativeFreezeConfig microLoopConfig(float captureLengthMs = 20.0f) {
    NativeFreezeConfig config;
    config.captureLengthMs = captureLengthMs;
    config.mode = NativeFreezeMode::MicroLoop;
    config.pitchSemitones = 0.0f;
    config.wetMix = 1.0f;
    config.frozen = false;
    return config;
}

void fillStereoHistory(NativeFreezeProcessor& processor, unsigned int frames, bool bypassed = true) {
    std::vector<float> input(static_cast<std::size_t>(frames) * 2U, 0.0f);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float value = static_cast<float>(frame % 97U) / 100.0f;
        input[static_cast<std::size_t>(frame) * 2U] = value;
        input[static_cast<std::size_t>(frame) * 2U + 1U] = -value;
    }
    (void)processor.processInPlace(input.data(), frames, 2U, bypassed);
}

void processWithChunks(
    NativeFreezeProcessor& processor,
    std::vector<float>& samples,
    const std::vector<unsigned int>& blockFrames
) {
    std::size_t offsetFrames = 0U;
    std::size_t blockIndex = 0U;
    const auto totalFrames = samples.size() / 2U;
    while (offsetFrames < totalFrames) {
        const auto requested = blockFrames[blockIndex % blockFrames.size()];
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(
            totalFrames - offsetFrames, requested
        ));
        (void)processor.processInPlace(
            samples.data() + offsetFrames * 2U,
            count,
            2U,
            false
        );
        offsetFrames += count;
        ++blockIndex;
    }
}

void testPrepareBoundsAndModeRejection() {
    NativeFreezeProcessor processor;
    assert(!processor.prepare(7999U));
    assert(!processor.prepare(192001U));
    assert(processor.prepare(8000U));
    assert(processor.sampleRate() == 8000U);
    assert(processor.status().ringCapacityFrames == 16000U);

    auto config = microLoopConfig();
    config.captureLengthMs = 2.0f;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);
    assert(processor.status().requiredCaptureFrames == 16U);
    config.captureLengthMs = 2000.0f;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);
    assert(processor.status().requiredCaptureFrames == 16000U);

    config.captureLengthMs = 1.99f;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::InvalidConfig);
    config = microLoopConfig();
    config.captureLengthMs = 2000.01f;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::InvalidConfig);
    config = microLoopConfig();
    config.pitchSemitones = -24.0f;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);
    assert(processor.status().playbackRateRatio == 0.25f);
    config.pitchSemitones = 24.0f;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);
    assert(processor.status().playbackRateRatio == 4.0f);
    config.pitchSemitones = 24.01f;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::InvalidConfig);
    config.pitchSemitones = -24.01f;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::InvalidConfig);
    config = microLoopConfig();
    config.wetMix = -0.01f;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::InvalidConfig);
    config = microLoopConfig();
    config.wetMix = 1.01f;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::InvalidConfig);
    config.wetMix = 0.0f;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);
    config.wetMix = 1.0f;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);
    config = microLoopConfig();
    config.pitchSemitones = std::numeric_limits<float>::quiet_NaN();
    assert(processor.setConfig(config) == NativeFreezeConfigResult::InvalidConfig);

    config = microLoopConfig();
    config.mode = NativeFreezeMode::Spectral;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::UnsupportedMode);
    config.mode = static_cast<NativeFreezeMode>(42U);
    assert(processor.setConfig(config) == NativeFreezeConfigResult::InvalidConfig);
    assert(processor.activeConfig().mode == NativeFreezeMode::MicroLoop);
}

void testBypassedCaptureFreezeAndRelease() {
    constexpr unsigned int sampleRate = 8000U;
    constexpr unsigned int captureFrames = 16000U;
    NativeFreezeProcessor processor;
    assert(processor.prepare(sampleRate));
    auto config = microLoopConfig(2000.0f);
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);

    std::vector<float> history(static_cast<std::size_t>(captureFrames) * 2U, 0.0f);
    for (unsigned int frame = 0U; frame < captureFrames; ++frame) {
        const float value = (frame & 1U) == 0U ? 0.25f : 0.5f;
        history[static_cast<std::size_t>(frame) * 2U] = value;
        history[static_cast<std::size_t>(frame) * 2U + 1U] = -value;
    }
    const auto peak = processor.processInPlace(history.data(), captureFrames, 2U, true);
    assert(peak == 0.5f);
    assert(!processor.isFrozen());
    assert(processor.status().validCaptureFrames == captureFrames);

    config.frozen = true;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);
    auto state = processor.status();
    assert(state.frozen && state.hasCapturedLoop);
    assert(state.loopFrames == captureFrames);
    assert(state.crossfadeFrames == 40U);

    std::array<float, 8U> frozenInput{{0.1f, -0.2f, 0.1f, -0.2f,
        0.1f, -0.2f, 0.1f, -0.2f}};
    (void)processor.processInPlace(frozenInput.data(), 4U, 2U, false);
    expectNear(frozenInput[0U], 0.25f);
    expectNear(frozenInput[1U], -0.25f);
    expectNear(frozenInput[2U], 0.5f, 1.0e-3f);
    expectNear(frozenInput[3U], -0.5f, 1.0e-3f);

    config.frozen = false;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);
    state = processor.status();
    assert(!state.frozen && !state.hasCapturedLoop);
    assert(state.validCaptureFrames == 0U);
    std::array<float, 6U> live{{0.2f, -0.3f, 0.4f, -0.5f, 0.6f, -0.7f}};
    (void)processor.processInPlace(live.data(), 3U, 2U, false);
    expectNear(live[0U], frozenInput[6U]);
    expectNear(live[1U], frozenInput[7U]);
    state = processor.status();
    assert(state.validCaptureFrames == 3U);
}

void testReleaseFadesToLiveInputWithoutClick() {
    NativeFreezeProcessor processor;
    assert(processor.prepare(8000U));
    auto config = microLoopConfig(2.0f);
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);
    std::array<float, 16U> capture{};
    capture.fill(0.8f);
    (void)processor.processInPlace(capture.data(), 16U, 1U, true);

    config.frozen = true;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);
    std::array<float, 8U> frozen{};
    (void)processor.processInPlace(frozen.data(), 8U, 1U, false);
    for (const float sample : frozen) expectNear(sample, 0.8f);

    config.frozen = false;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);
    std::array<float, 40U> release{};
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)processor.processInPlace(release.data(), static_cast<unsigned int>(release.size()), 1U, false);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
    expectNear(release.front(), 0.8f);
    expectNear(release.back(), 0.0f);
    float largestStep = 0.0f;
    for (std::size_t index = 1U; index < release.size(); ++index) {
        assert(std::isfinite(release[index]));
        assert(release[index] <= release[index - 1U]);
        largestStep = std::max(largestStep, std::fabs(release[index] - release[index - 1U]));
    }
    assert(largestStep < 0.021f);
    assert(processor.status().validCaptureFrames == release.size());
}

void testInsufficientHistoryAndStereoPhaseLinkedPitch() {
    NativeFreezeProcessor shortHistory;
    assert(shortHistory.prepare(8000U));
    auto longConfig = microLoopConfig(20.0f);
    assert(shortHistory.setConfig(longConfig) == NativeFreezeConfigResult::Accepted);
    fillStereoHistory(shortHistory, 159U);
    longConfig.frozen = true;
    assert(shortHistory.setConfig(longConfig) == NativeFreezeConfigResult::InsufficientCaptureHistory);
    assert(!shortHistory.isFrozen());
    fillStereoHistory(shortHistory, 1U);
    assert(shortHistory.setConfig(longConfig) == NativeFreezeConfigResult::Accepted);
    assert(shortHistory.status().loopFrames == 160U);

    NativeFreezeProcessor pitched;
    assert(pitched.prepare(8000U));
    auto config = microLoopConfig(20.0f);
    config.pitchSemitones = 12.0f;
    assert(pitched.setConfig(config) == NativeFreezeConfigResult::Accepted);
    std::vector<float> history(200U * 2U, 0.0f);
    for (std::size_t frame = 0U; frame < 200U; ++frame) {
        const float sample = static_cast<float>(std::sin(static_cast<double>(frame) * 0.07));
        history[frame * 2U] = sample;
        history[frame * 2U + 1U] = -sample;
    }
    (void)pitched.processInPlace(history.data(), 200U, 2U, true);
    config.frozen = true;
    assert(pitched.setConfig(config) == NativeFreezeConfigResult::Accepted);
    std::array<float, 16U> output{};
    output.fill(0.0f);
    (void)pitched.processInPlace(output.data(), 8U, 2U, false);
    const auto state = pitched.status();
    assert(state.playbackRateRatio == 2.0f);
    expectNear(output[0U], history[40U * 2U], 1.0e-6f);
    for (std::size_t frame = 0U; frame < 8U; ++frame) {
        expectNear(output[frame * 2U + 1U], -output[frame * 2U], 1.0e-6f);
    }
    expectNear(static_cast<float>(state.playbackPosition), 15.9f, 1.0e-5f);
}

void testChunkInvarianceAndFiniteOutput() {
    NativeFreezeProcessor whole;
    NativeFreezeProcessor chunked;
    assert(whole.prepare(8000U));
    assert(chunked.prepare(8000U));
    auto config = microLoopConfig(20.0f);
    config.pitchSemitones = -7.0f;
    config.wetMix = 0.72f;
    assert(whole.setConfig(config) == NativeFreezeConfigResult::Accepted);
    assert(chunked.setConfig(config) == NativeFreezeConfigResult::Accepted);
    fillStereoHistory(whole, 230U);
    fillStereoHistory(chunked, 230U);
    config.frozen = true;
    assert(whole.setConfig(config) == NativeFreezeConfigResult::Accepted);
    assert(chunked.setConfig(config) == NativeFreezeConfigResult::Accepted);

    constexpr std::size_t frames = 1003U;
    std::vector<float> wholeOutput(frames * 2U, 0.0f);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const float value = static_cast<float>(std::sin(static_cast<double>(frame) * 0.031));
        wholeOutput[frame * 2U] = value;
        wholeOutput[frame * 2U + 1U] = value * 0.37f;
    }
    auto chunkedOutput = wholeOutput;
    (void)whole.processInPlace(wholeOutput.data(), static_cast<unsigned int>(frames), 2U, false);
    processWithChunks(chunked, chunkedOutput, {1U, 3U, 17U, 64U, 127U, 5U, 256U});
    for (std::size_t index = 0U; index < wholeOutput.size(); ++index) {
        expectNear(wholeOutput[index], chunkedOutput[index], 0.0f);
        assert(std::isfinite(wholeOutput[index]));
    }
    assert(whole.status().playbackPosition == chunked.status().playbackPosition);

    NativeFreezeProcessor sanitized;
    assert(sanitized.prepare(8000U));
    auto sanitizeConfig = microLoopConfig(2.0f);
    assert(sanitized.setConfig(sanitizeConfig) == NativeFreezeConfigResult::Accepted);
    std::array<float, 40U> badInput{};
    badInput[0U] = std::numeric_limits<float>::quiet_NaN();
    badInput[1U] = std::numeric_limits<float>::infinity();
    badInput[2U] = -std::numeric_limits<float>::infinity();
    (void)sanitized.processInPlace(badInput.data(), 20U, 2U, false);
    for (const float value : badInput) assert(std::isfinite(value));
    sanitizeConfig.frozen = true;
    assert(sanitized.setConfig(sanitizeConfig) == NativeFreezeConfigResult::Accepted);
    std::array<float, 40U> rendered{};
    rendered.fill(std::numeric_limits<float>::quiet_NaN());
    (void)sanitized.processInPlace(rendered.data(), 20U, 2U, false);
    for (const float value : rendered) assert(std::isfinite(value));
}

void testWrapCrossfadeAvoidsHardLoopEdge() {
    NativeFreezeProcessor processor;
    assert(processor.prepare(48000U));
    auto config = microLoopConfig(20.0f);
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);

    constexpr unsigned int historyFrames = 1100U;
    std::vector<float> history(historyFrames, 0.0f);
    for (unsigned int frame = 0U; frame < historyFrames; ++frame) {
        history[frame] = static_cast<float>(frame) / static_cast<float>(historyFrames);
    }
    (void)processor.processInPlace(history.data(), historyFrames, 1U, true);
    config.frozen = true;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);
    assert(processor.status().crossfadeFrames == 9U);

    std::array<float, 1000U> output{};
    (void)processor.processInPlace(output.data(), static_cast<unsigned int>(output.size()), 1U, false);
    float largestStep = 0.0f;
    for (std::size_t frame = 1U; frame < output.size(); ++frame) {
        assert(std::isfinite(output[frame]));
        largestStep = std::max(largestStep, std::fabs(output[frame] - output[frame - 1U]));
    }
    // The uncrossfaded captured ramp would jump by roughly 0.8 at loop wrap.
    assert(largestStep < 0.12f);
}

void testShortLoopNeutralPitchPeriod() {
    NativeFreezeProcessor processor;
    assert(processor.prepare(48000U));
    auto config = microLoopConfig(20.0f);
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);

    constexpr unsigned int captureFrames = 960U;
    std::vector<float> history(static_cast<std::size_t>(captureFrames) * 2U, 0.0f);
    for (unsigned int frame = 0U; frame < captureFrames; ++frame) {
        const float value = static_cast<float>(std::sin(
            2.0 * 3.14159265358979323846 * 250.0 * static_cast<double>(frame) / 48000.0
        ));
        history[static_cast<std::size_t>(frame) * 2U] = value;
        history[static_cast<std::size_t>(frame) * 2U + 1U] = -value;
    }
    (void)processor.processInPlace(history.data(), captureFrames, 2U, true);
    config.frozen = true;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);
    assert(processor.status().crossfadeFrames == 9U);

    constexpr unsigned int renderFrames = 24000U;
    std::vector<float> output(static_cast<std::size_t>(renderFrames) * 2U, 0.0f);
    (void)processor.processInPlace(output.data(), renderFrames, 2U, false);
    const unsigned int firstFrame = 2000U;
    unsigned int risingCrossings = 0U;
    unsigned int firstCrossing = 0U;
    unsigned int lastCrossing = 0U;
    for (unsigned int frame = firstFrame + 1U; frame < renderFrames; ++frame) {
        const float previous = output[static_cast<std::size_t>(frame - 1U) * 2U];
        const float current = output[static_cast<std::size_t>(frame) * 2U];
        if (previous <= 0.0f && current > 0.0f) {
            if (risingCrossings == 0U) firstCrossing = frame;
            lastCrossing = frame;
            ++risingCrossings;
        }
    }
    assert(risingCrossings > 1U && lastCrossing > firstCrossing);
    const double measuredHz = static_cast<double>(risingCrossings - 1U) * 48000.0 /
        static_cast<double>(lastCrossing - firstCrossing);
    assert(std::fabs(measuredHz - 250.0) < 0.75);
}

void testCallbackDoesNotAllocate() {
    NativeFreezeProcessor processor;
    assert(processor.prepare(48000U));
    auto config = microLoopConfig(20.0f);
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);
    fillStereoHistory(processor, 1200U);
    config.frozen = true;
    assert(processor.setConfig(config) == NativeFreezeConfigResult::Accepted);

    std::array<float, 512U> audio{};
    for (std::size_t index = 0U; index < audio.size(); ++index) {
        audio[index] = (index & 1U) == 0U ? 0.1f : -0.1f;
    }
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)processor.processInPlace(audio.data(), 128U, 2U, false);
    (void)processor.processInPlace(audio.data(), 37U, 2U, true);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
}

} // namespace

int main() {
    testPrepareBoundsAndModeRejection();
    testBypassedCaptureFreezeAndRelease();
    testReleaseFadesToLiveInputWithoutClick();
    testInsufficientHistoryAndStereoPhaseLinkedPitch();
    testChunkInvarianceAndFiniteOutput();
    testWrapCrossfadeAvoidsHardLoopEdge();
    testShortLoopNeutralPitchPeriod();
    testCallbackDoesNotAllocate();
    return 0;
}
