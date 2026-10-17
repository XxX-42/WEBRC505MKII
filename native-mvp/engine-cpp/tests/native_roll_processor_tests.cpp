#include "native_roll_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <vector>

using namespace webrc::native;

namespace {

constexpr float kPi = 3.14159265358979323846f;

void expectNear(float actual, float expected, float tolerance = 1.0e-5f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

void setShortSliceConfig(NativeRollProcessor& processor, NativeRollConfig config = {}) {
    config.bpm = 300.0f;
    config.sliceBeats = 0.25f;
    config.decayPercent = 0.0f;
    config.pitchSemitones = 0.0f;
    config.direction = NativeRollDirection::Forward;
    config.wetMix = 1.0f;
    assert(processor.setConfig(config));
}

void processInBlocks(NativeRollProcessor& processor, std::vector<float>& samples,
    unsigned int channels, const std::vector<unsigned int>& blockFrames) {
    std::size_t offsetFrames = 0U;
    std::size_t nextSize = 0U;
    while (offsetFrames * static_cast<std::size_t>(channels) < samples.size()) {
        const std::size_t remaining = samples.size() / channels - offsetFrames;
        const unsigned int requested = blockFrames[nextSize % blockFrames.size()];
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(remaining, requested));
        assert(processor.processInPlace(
            samples.data() + offsetFrames * static_cast<std::size_t>(channels), count, channels
        ) >= 0.0f);
        offsetFrames += count;
        ++nextSize;
    }
}

void testPrepareAndSampleExactBoundaries() {
    NativeRollProcessor processor;
    assert(!processor.prepare(7999U));
    assert(!processor.prepare(192001U));
    assert(processor.prepare(8000U));
    assert(processor.sampleRate() == 8000U);
    assert(processor.maxSliceFrames() == 48002U);

    constexpr std::array<float, 5U> divisions{{0.25f, 0.5f, 1.0f, 2.0f, 4.0f}};
    constexpr std::array<unsigned int, 5U> expectedFrames{{1000U, 2000U, 4000U, 8000U, 16000U}};
    for (std::size_t option = 0U; option < divisions.size(); ++option) {
        processor.reset();
        NativeRollConfig config;
        config.bpm = 120.0f;
        config.sliceBeats = divisions[option];
        config.wetMix = 1.0f;
        assert(processor.setConfig(config));
        assert(processor.status().remainingFramesToBoundary == expectedFrames[option]);

        const auto beforeBoundary = expectedFrames[option] - 1U;
        std::vector<float> silence(static_cast<std::size_t>(beforeBoundary) * 2U, 0.0f);
        if (beforeBoundary > 7U) {
            (void)processor.processInPlace(silence.data(), beforeBoundary - 7U, 2U);
            (void)processor.processInPlace(silence.data() + static_cast<std::size_t>(beforeBoundary - 7U) * 2U, 7U, 2U);
        } else {
            (void)processor.processInPlace(silence.data(), beforeBoundary, 2U);
        }
        auto state = processor.status();
        assert(state.boundaryCount == 0U);
        assert(state.remainingFramesToBoundary == 1U);
        assert(state.lastBoundaryFrame == -1);

        std::array<float, 2U> boundary{{0.25f, -0.5f}};
        (void)processor.processInPlace(boundary.data(), 1U, 2U);
        state = processor.status();
        assert(state.boundaryCount == 1U);
        assert(state.framesProcessed == expectedFrames[option]);
        assert(state.lastBoundaryFrame == static_cast<std::int64_t>(expectedFrames[option] - 1U));
        assert(state.remainingFramesToBoundary == expectedFrames[option]);
    }
}

void testCaptureRetriggerAndStereoDryUntilFirstSlice() {
    NativeRollProcessor processor;
    assert(processor.prepare(8000U));
    setShortSliceConfig(processor);

    constexpr std::size_t frames = 402U;
    std::vector<float> audio(frames * 2U, 0.0f);
    for (std::size_t frame = 0U; frame < 400U; ++frame) {
        const float value = static_cast<float>(frame) / 400.0f;
        audio[frame * 2U] = value;
        audio[frame * 2U + 1U] = -value;
    }
    audio[400U * 2U] = 0.25f;
    audio[400U * 2U + 1U] = -0.5f;
    audio[401U * 2U] = 0.5f;
    audio[401U * 2U + 1U] = -0.75f;

    assert(processor.processInPlace(audio.data(), static_cast<unsigned int>(frames), 2U) > 0.96f);
    for (std::size_t frame = 0U; frame < 400U; ++frame) {
        const float value = static_cast<float>(frame) / 400.0f;
        expectNear(audio[frame * 2U], value, 0.0f);
        expectNear(audio[frame * 2U + 1U], -value, 0.0f);
    }
    // The first boundary promotes the captured stereo slice; wet audio starts
    // on the following sample, exactly at the start of that slice.
    expectNear(audio[400U * 2U], 0.0f, 0.0f);
    expectNear(audio[400U * 2U + 1U], 0.0f, 0.0f);
    expectNear(audio[401U * 2U], 1.0f / 400.0f);
    expectNear(audio[401U * 2U + 1U], -1.0f / 400.0f);
    const auto state = processor.status();
    assert(state.hasCapturedSlice);
    assert(state.playbackFrames == 400U);
    assert(state.boundaryCount == 1U);
    assert(state.lastBoundaryFrame == 399);
}

void testPlaybackRateReverseAlternateAndBoundaryCrossfade() {
    NativeRollProcessor pitched;
    assert(pitched.prepare(8000U));
    NativeRollConfig config;
    config.bpm = 300.0f;
    config.sliceBeats = 0.25f;
    config.decayPercent = 0.0f;
    config.pitchSemitones = 12.0f;
    config.wetMix = 1.0f;
    assert(pitched.setConfig(config));
    std::vector<float> ramp(402U, 0.0f);
    for (std::size_t i = 0U; i < 400U; ++i) ramp[i] = static_cast<float>(i) / 400.0f;
    (void)pitched.processInPlace(ramp.data(), static_cast<unsigned int>(ramp.size()), 1U);
    expectNear(ramp[400U], 0.0f, 0.0f);
    expectNear(ramp[401U], 2.0f / 400.0f);
    expectNear(pitched.status().playbackRateRatio, 2.0f, 1.0e-6f);

    NativeRollProcessor reverse;
    assert(reverse.prepare(8000U));
    config.pitchSemitones = 0.0f;
    config.direction = NativeRollDirection::Reverse;
    assert(reverse.setConfig(config));
    std::vector<float> reverseRamp(401U, 0.0f);
    for (std::size_t i = 0U; i < 400U; ++i) reverseRamp[i] = static_cast<float>(i) / 400.0f;
    (void)reverse.processInPlace(reverseRamp.data(), 401U, 1U);
    expectNear(reverseRamp[400U], 399.0f / 400.0f);
    assert(reverse.status().reversePlayback);

    NativeRollProcessor alternate;
    assert(alternate.prepare(8000U));
    config.direction = NativeRollDirection::Alternate;
    assert(alternate.setConfig(config));
    std::vector<float> alternating(801U, 0.2f);
    (void)alternate.processInPlace(alternating.data(), 400U, 1U);
    assert(alternate.status().boundaryCount == 1U);
    assert(!alternate.status().reversePlayback);
    (void)alternate.processInPlace(alternating.data() + 400U, 400U, 1U);
    assert(alternate.status().boundaryCount == 2U);
    assert(alternate.status().reversePlayback);
    assert(alternate.status().transitionFramesRemaining == 40U);

    NativeRollProcessor transition;
    assert(transition.prepare(8000U));
    config.direction = NativeRollDirection::Forward;
    assert(transition.setConfig(config));
    std::vector<float> slices(801U, 0.0f);
    std::fill(slices.begin(), slices.begin() + 400, 0.25f);
    std::fill(slices.begin() + 400, slices.begin() + 800, 0.5f);
    (void)transition.processInPlace(slices.data(), 801U, 1U);
    const float firstFade = std::cos(kPi / 80.0f) * 0.25f + std::sin(kPi / 80.0f) * 0.5f;
    expectNear(slices[800U], firstFade, 1.0e-5f);
}

void testPitchRangeAndPerRetriggerDecay() {
    NativeRollProcessor processor;
    assert(processor.prepare(8000U));
    NativeRollConfig config;
    config.pitchSemitones = 24.0f;
    assert(processor.setConfig(config));
    expectNear(processor.status().playbackRateRatio, 4.0f, 1.0e-6f);
    config.pitchSemitones = -24.0f;
    assert(processor.setConfig(config));
    expectNear(processor.status().playbackRateRatio, 0.25f, 1.0e-6f);

    NativeRollProcessor decay;
    assert(decay.prepare(8000U));
    config = {};
    config.bpm = 300.0f;
    config.sliceBeats = 0.25f;
    config.decayPercent = 20.0f;
    config.pitchSemitones = 24.0f;
    config.wetMix = 1.0f;
    assert(decay.setConfig(config));
    std::vector<float> constant(502U, 1.0f);
    (void)decay.processInPlace(constant.data(), static_cast<unsigned int>(constant.size()), 1U);
    expectNear(constant[400U], 1.0f);
    expectNear(constant[480U], 1.0f);
    expectNear(constant[500U], 0.8f);
    expectNear(decay.status().repeatGain, 0.8f);
}

void testBoundaryRetriggerDecaysOnlyOnce() {
    NativeRollProcessor processor;
    assert(processor.prepare(8000U));
    NativeRollConfig config;
    config.bpm = 120.0f;
    config.sliceBeats = 0.25f;
    config.decayPercent = 20.0f;
    config.wetMix = 1.0f;
    assert(processor.setConfig(config));

    std::array<float, 1000U> slice{};
    slice.fill(0.25f);
    (void)processor.processInPlace(slice.data(), static_cast<unsigned int>(slice.size()), 1U);
    expectNear(processor.status().repeatGain, 1.0f);
    slice.fill(0.0f);
    (void)processor.processInPlace(slice.data(), static_cast<unsigned int>(slice.size()), 1U);
    expectNear(processor.status().repeatGain, 0.8f);
    (void)processor.processInPlace(slice.data(), static_cast<unsigned int>(slice.size()), 1U);
    expectNear(processor.status().repeatGain, 0.64f);
}

void testConfigAndPrepareRollback() {
    NativeRollProcessor processor;
    assert(processor.prepare(8000U));
    NativeRollConfig good;
    good.bpm = 120.0f;
    good.sliceBeats = 0.25f;
    good.decayPercent = 5.0f;
    good.pitchSemitones = 3.0f;
    good.direction = NativeRollDirection::Forward;
    good.wetMix = 0.8f;
    assert(processor.setConfig(good));

    std::array<float, 8U> partial{};
    (void)processor.processInPlace(partial.data(), 4U, 2U);
    const NativeRollStatus before = processor.status();
    assert(!processor.prepare(7999U));
    assert(!processor.prepare(192001U));
    assert(processor.status().sampleRate == before.sampleRate);
    assert(processor.status().framesProcessed == before.framesProcessed);

    const auto expectRejectedWithoutMutation = [&processor, &good](NativeRollConfig bad) {
        assert(!processor.setConfig(bad));
        const auto after = processor.status();
        assert(after.pendingConfig.bpm == good.bpm);
        assert(after.pendingConfig.sliceBeats == good.sliceBeats);
        assert(after.pendingConfig.decayPercent == good.decayPercent);
        assert(after.pendingConfig.pitchSemitones == good.pitchSemitones);
        assert(after.pendingConfig.direction == good.direction);
        assert(after.pendingConfig.wetMix == good.wetMix);
    };

    auto bad = good;
    bad.bpm = 39.0f;
    expectRejectedWithoutMutation(bad);
    bad = good;
    bad.bpm = 300.1f;
    expectRejectedWithoutMutation(bad);
    bad = good;
    bad.sliceBeats = 0.75f;
    expectRejectedWithoutMutation(bad);
    bad = good;
    bad.decayPercent = 100.1f;
    expectRejectedWithoutMutation(bad);
    bad = good;
    bad.decayPercent = std::numeric_limits<float>::quiet_NaN();
    expectRejectedWithoutMutation(bad);
    bad = good;
    bad.pitchSemitones = 24.1f;
    expectRejectedWithoutMutation(bad);
    bad = good;
    bad.pitchSemitones = -24.1f;
    expectRejectedWithoutMutation(bad);
    bad = good;
    bad.direction = static_cast<NativeRollDirection>(99U);
    expectRejectedWithoutMutation(bad);
    bad = good;
    bad.wetMix = 1.01f;
    expectRejectedWithoutMutation(bad);
    bad = good;
    bad.wetMix = std::numeric_limits<float>::infinity();
    expectRejectedWithoutMutation(bad);

    std::vector<float> continuation(996U * 2U, 0.125f);
    (void)processor.processInPlace(continuation.data(), 996U, 2U);
    assert(processor.status().boundaryCount == 1U);
    assert(processor.status().hasCapturedSlice);
    assert(processor.pendingConfig().sliceBeats == good.sliceBeats);
}

void testFiniteBoundsResetSegmentationAndNoProcessAllocations() {
    NativeRollProcessor finite;
    assert(finite.prepare(8000U));
    setShortSliceConfig(finite);
    std::vector<float> dirty(43U * 3U, 0.0f);
    dirty[0] = std::numeric_limits<float>::quiet_NaN();
    dirty[1] = std::numeric_limits<float>::infinity();
    dirty[2] = -100000.0f;
    dirty[3] = -std::numeric_limits<float>::infinity();
    dirty[4] = 100000.0f;
    dirty[5] = std::numeric_limits<float>::quiet_NaN();
    assert(finite.processInPlace(dirty.data(), 43U, 3U) <= 64.0f);
    for (const float sample : dirty) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) <= 64.0f);
    }

    NativeRollProcessor whole;
    NativeRollProcessor segmented;
    assert(whole.prepare(8000U));
    assert(segmented.prepare(8000U));
    NativeRollConfig config;
    config.bpm = 120.0f;
    config.sliceBeats = 0.25f;
    config.decayPercent = 13.0f;
    config.pitchSemitones = 5.0f;
    config.direction = NativeRollDirection::Alternate;
    config.wetMix = 0.9f;
    assert(whole.setConfig(config));
    assert(segmented.setConfig(config));
    std::vector<float> input(2237U * 2U);
    for (std::size_t i = 0U; i < input.size(); ++i) {
        input[i] = static_cast<float>(static_cast<int>(i % 37U) - 18) / 30.0f;
    }
    auto chunked = input;
    (void)whole.processInPlace(input.data(), 2237U, 2U);
    processInBlocks(segmented, chunked, 2U, {1U, 7U, 23U, 2U, 31U, 3U, 64U});
    assert(input.size() == chunked.size());
    for (std::size_t i = 0U; i < input.size(); ++i) expectNear(input[i], chunked[i], 0.0f);
    assert(whole.status().framesProcessed == segmented.status().framesProcessed);
    assert(whole.status().boundaryCount == segmented.status().boundaryCount);
    assert(whole.status().remainingFramesToBoundary == segmented.status().remainingFramesToBoundary);
    assert(whole.status().reversePlayback == segmented.status().reversePlayback);

    auto mutableState = whole.status();
    assert(mutableState.hasCapturedSlice);
    whole.reset();
    assert(whole.status().boundaryCount == 0U);
    assert(whole.status().lastBoundaryFrame == -1);
    assert(!whole.status().hasCapturedSlice);
    assert(whole.status().remainingFramesToBoundary == 1000U);
    std::vector<float> dryAgain(20U * 2U, 0.25f);
    (void)whole.processInPlace(dryAgain.data(), 20U, 2U);
    for (const float sample : dryAgain) expectNear(sample, 0.25f, 0.0f);

    NativeRollProcessor allocationFree;
    assert(allocationFree.prepare(8000U));
    setShortSliceConfig(allocationFree);
    std::vector<float> work(820U * 2U, 0.125f);
    webrc::native::test_alloc::beginTracking();
    (void)allocationFree.processInPlace(work.data(), 399U, 2U);
    (void)allocationFree.processInPlace(work.data() + 399U * 2U, 421U, 2U);
    (void)allocationFree.status();
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == 0U);
}

} // namespace

int main() {
    testPrepareAndSampleExactBoundaries();
    testCaptureRetriggerAndStereoDryUntilFirstSlice();
    testPlaybackRateReverseAlternateAndBoundaryCrossfade();
    testPitchRangeAndPerRetriggerDecay();
    testBoundaryRetriggerDecaysOnlyOnce();
    testConfigAndPrepareRollback();
    testFiniteBoundsResetSegmentationAndNoProcessAllocations();
}
