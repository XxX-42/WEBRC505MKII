#include "native_beat_repeat_processor.hpp"
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

void expectNear(float actual, float expected, float tolerance = 1.0e-5f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

void testPrepareAndParameterValidation() {
    NativeBeatRepeatProcessor processor;
    assert(!processor.prepare(7999U));
    assert(!processor.prepare(192001U));
    assert(processor.prepare(8000U));
    assert(processor.sampleRate() == 8000U);
    assert(processor.maxSliceFrames() == 48002U);
    assert(processor.remainingFramesToBoundary() == 2000U);

    NativeBeatRepeatConfig config;
    assert(processor.setConfig(config));
    config.bpm = 29.9f;
    assert(!processor.setConfig(config));
    config = {};
    config.bpm = 300.1f;
    assert(!processor.setConfig(config));
    config = {};
    config.division = 0.75f;
    assert(!processor.setConfig(config));
    config = {};
    config.decay = std::numeric_limits<float>::quiet_NaN();
    assert(!processor.setConfig(config));
    config = {};
    config.direction = static_cast<NativeBeatRepeatDirection>(99U);
    assert(!processor.setConfig(config));
    config = {};
    config.wetMix = 1.01f;
    assert(!processor.setConfig(config));
    config = {};
    config.wetMix = std::numeric_limits<float>::infinity();
    assert(!processor.setConfig(config));

    assert(processor.activeConfig().bpm == 120.0f);
    assert(processor.activeConfig().division == 0.5f);
    assert(processor.pendingConfig().division == 0.5f);
}

void testCaptureForwardRepeatAndBoundaryCrossfade() {
    constexpr unsigned int sampleRate = 8000U;
    constexpr std::size_t frames = 3000U;
    NativeBeatRepeatProcessor processor;
    assert(processor.prepare(sampleRate));
    NativeBeatRepeatConfig config;
    config.bpm = 120.0f;
    config.division = 0.25f;
    config.decay = 0.0f;
    config.direction = NativeBeatRepeatDirection::Forward;
    config.wetMix = 1.0f;
    assert(processor.setConfig(config, 0U));

    std::vector<float> samples(frames * 2U, 0.0f);
    for (std::size_t frame = 0U; frame < 1000U; ++frame) {
        samples[frame * 2U] = static_cast<float>(frame) / 1000.0f;
        samples[frame * 2U + 1U] = -static_cast<float>(frame) / 2000.0f;
    }
    for (std::size_t frame = 1000U; frame < 2000U; ++frame) {
        samples[frame * 2U] = 0.2f;
        samples[frame * 2U + 1U] = -0.3f;
    }
    for (std::size_t frame = 2000U; frame < frames; ++frame) {
        samples[frame * 2U] = 0.4f;
        samples[frame * 2U + 1U] = -0.5f;
    }

    const auto peak = processor.processInPlace(samples.data(), static_cast<unsigned int>(frames), 2U);
    assert(peak > 0.99f && peak < 1.01f);
    for (std::size_t frame = 0U; frame < 1000U; ++frame) {
        expectNear(samples[frame * 2U], static_cast<float>(frame) / 1000.0f, 0.0f);
        expectNear(samples[frame * 2U + 1U], -static_cast<float>(frame) / 2000.0f, 0.0f);
    }
    // The first boundary starts playback at the beginning of the captured
    // ramp; the next boundary replaces it with the second captured slice.
    expectNear(samples[1000U * 2U], 0.0f, 0.0f);
    expectNear(samples[1000U * 2U + 1U], 0.0f, 0.0f);
    // The outgoing forward tail fades into the incoming slice, and the new
    // slice begins at the matching crossfade offset on the next boundary.
    expectNear(samples[1999U * 2U], 0.2f, 1.0e-5f);
    expectNear(samples[1999U * 2U + 1U], -0.3f, 1.0e-5f);
    expectNear(samples[2000U * 2U], 0.2f, 1.0e-5f);
    expectNear(samples[2000U * 2U + 1U], -0.3f, 1.0e-5f);

    const auto state = processor.status();
    assert(state.hasCapturedSlice);
    assert(state.boundaryCount == 3U);
    assert(state.lastBoundaryFrame == 2999);
    assert(state.activeSliceFrames == 1000U);
    assert(state.remainingFramesToBoundary == 1000U);
}

void testReverseAlternateDecayAndMix() {
    NativeBeatRepeatProcessor reverse;
    assert(reverse.prepare(8000U));
    NativeBeatRepeatConfig reverseConfig;
    reverseConfig.division = 0.25f;
    reverseConfig.direction = NativeBeatRepeatDirection::Reverse;
    reverseConfig.decay = 0.0f;
    reverseConfig.wetMix = 1.0f;
    assert(reverse.setConfig(reverseConfig, 0U));
    reverse.reset();
    std::vector<float> ramp(1001U, 0.0f);
    for (std::size_t frame = 0U; frame < 1000U; ++frame) ramp[frame] = static_cast<float>(frame) / 1000.0f;
    assert(reverse.processInPlace(ramp.data(), 1001U, 1U) > 0.99f);
    expectNear(ramp[1000U], 0.999f, 1.0e-6f);
    assert(reverse.status().reversePlayback);

    NativeBeatRepeatProcessor alternate;
    assert(alternate.prepare(8000U));
    NativeBeatRepeatConfig alternateConfig;
    alternateConfig.division = 0.25f;
    alternateConfig.direction = NativeBeatRepeatDirection::Alternate;
    assert(alternate.setConfig(alternateConfig, 0U));
    alternate.reset();
    std::vector<float> silence(2000U, 0.0f);
    (void)alternate.processInPlace(silence.data(), 2000U, 1U);
    assert(alternate.status().boundaryCount == 2U);
    assert(alternate.status().reversePlayback);

    NativeBeatRepeatProcessor decay;
    assert(decay.prepare(8000U));
    NativeBeatRepeatConfig decayConfig;
    decayConfig.division = 0.25f;
    decayConfig.decay = 15.0f;
    decayConfig.wetMix = 1.0f;
    assert(decay.setConfig(decayConfig, 0U));
    decay.reset();
    std::vector<float> repeated(2001U, 0.0f);
    std::fill(repeated.begin(), repeated.begin() + 1000, 1.0f);
    std::fill(repeated.begin() + 1000, repeated.begin() + 2000, 0.5f);
    (void)decay.processInPlace(repeated.data(), 2001U, 1U);
    expectNear(repeated[2000U], 0.425f, 1.0e-5f);

    NativeBeatRepeatProcessor mix;
    assert(mix.prepare(8000U));
    NativeBeatRepeatConfig mixConfig;
    mixConfig.division = 0.25f;
    mixConfig.decay = 0.0f;
    mixConfig.wetMix = 0.0f;
    assert(mix.setConfig(mixConfig, 0U));
    mix.reset();
    std::vector<float> mutedWet(1001U, 0.75f);
    (void)mix.processInPlace(mutedWet.data(), 1001U, 1U);
    expectNear(mutedWet[1000U], 0.75f, 1.0e-6f);
}

void testBoundaryLatchingResetAndChannelSafety() {
    NativeBeatRepeatProcessor processor;
    assert(processor.prepare(8000U));
    NativeBeatRepeatConfig config;
    config.division = 0.25f;
    config.decay = 0.0f;
    config.wetMix = 1.0f;
    assert(processor.setConfig(config, 0U));
    processor.reset();

    std::vector<float> firstPart(400U * 2U, 0.0f);
    (void)processor.processInPlace(firstPart.data(), 400U, 2U);
    auto pending = config;
    pending.bpm = 60.0f;
    pending.division = 0.5f;
    pending.direction = NativeBeatRepeatDirection::Reverse;
    assert(processor.setConfig(pending, 0U));
    std::vector<float> beforeBoundary(599U * 2U, 0.0f);
    (void)processor.processInPlace(beforeBoundary.data(), 599U, 2U);
    assert(processor.status().boundaryCount == 0U);
    assert(processor.activeConfig().bpm == 120.0f);
    assert(processor.activeConfig().division == 0.25f);
    assert(processor.remainingFramesToBoundary() == 1U);

    std::array<float, 2U> boundaryFrame{{0.25f, -0.25f}};
    (void)processor.processInPlace(boundaryFrame.data(), 1U, 2U);
    assert(processor.status().lastBoundaryFrame == 999);
    assert(processor.activeConfig().bpm == 60.0f);
    assert(processor.activeConfig().division == 0.5f);
    assert(processor.activeConfig().direction == NativeBeatRepeatDirection::Reverse);
    assert(processor.remainingFramesToBoundary() == 4000U);

    processor.reset();
    assert(processor.status().boundaryCount == 0U);
    assert(processor.status().lastBoundaryFrame == -1);
    assert(!processor.hasCapturedSlice());
    assert(processor.remainingFramesToBoundary() == 4000U);

    NativeBeatRepeatProcessor mono;
    assert(mono.prepare(8000U));
    NativeBeatRepeatConfig monoConfig;
    monoConfig.division = 0.25f;
    monoConfig.wetMix = 1.0f;
    assert(mono.setConfig(monoConfig, 0U));
    mono.reset();
    std::vector<float> monoInput(1001U, 0.25f);
    (void)mono.processInPlace(monoInput.data(), 1001U, 1U);
    expectNear(monoInput[1000U], 0.25f, 1.0e-6f);

    std::array<float, 12U> threeChannels{{0.1f, -0.2f, 0.75f, 0.3f, -0.4f, -0.5f,
                                          0.2f, 0.1f, 0.8f, -0.2f, 0.4f, 0.6f}};
    const auto extraBefore = std::array<float, 4U>{{threeChannels[2], threeChannels[5], threeChannels[8], threeChannels[11]}};
    (void)mono.processInPlace(threeChannels.data(), 4U, 3U);
    assert(threeChannels[2] == extraBefore[0]);
    assert(threeChannels[5] == extraBefore[1]);
    assert(threeChannels[8] == extraBefore[2]);
    assert(threeChannels[11] == extraBefore[3]);
    const auto unchanged = threeChannels;
    assert(mono.processInPlace(threeChannels.data(), 4U, 0U) == 0.0f);
    assert(threeChannels == unchanged);
}

void testAllocationFreeProcessingAndSegmentationInvariance() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = 8192U;
    NativeBeatRepeatProcessor wholeProcessor;
    NativeBeatRepeatProcessor chunkedProcessor;
    assert(wholeProcessor.prepare(sampleRate));
    assert(chunkedProcessor.prepare(sampleRate));
    NativeBeatRepeatConfig config;
    config.bpm = 123.0f;
    config.division = 0.25f;
    config.decay = 7.0f;
    config.direction = NativeBeatRepeatDirection::Alternate;
    config.wetMix = 0.8f;
    assert(wholeProcessor.setConfig(config, 0U));
    assert(chunkedProcessor.setConfig(config, 0U));
    wholeProcessor.reset();
    chunkedProcessor.reset();

    std::vector<float> whole(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        whole[frame * 2U] = static_cast<float>(std::sin(static_cast<double>(frame) * 0.021) * 0.4);
        whole[frame * 2U + 1U] = static_cast<float>(std::cos(static_cast<double>(frame) * 0.017) * 0.3);
    }
    auto chunked = whole;

    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)wholeProcessor.processInPlace(whole.data(), static_cast<unsigned int>(frames), 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);

    constexpr std::array<unsigned int, 7U> chunks{{1U, 63U, 64U, 127U, 255U, 511U, 1024U}};
    std::size_t offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(chunks[chunkIndex % chunks.size()], frames - offset));
        (void)chunkedProcessor.processInPlace(chunked.data() + offset * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t sample = 0U; sample < whole.size(); ++sample) {
        expectNear(chunked[sample], whole[sample], 0.0f);
    }
    const auto wholeState = wholeProcessor.status();
    const auto chunkedState = chunkedProcessor.status();
    assert(wholeState.framesProcessed == chunkedState.framesProcessed);
    assert(wholeState.boundaryCount == chunkedState.boundaryCount);
    assert(wholeState.lastBoundaryFrame == chunkedState.lastBoundaryFrame);
    assert(wholeState.remainingFramesToBoundary == chunkedState.remainingFramesToBoundary);
    assert(wholeState.activeSliceFrames == chunkedState.activeSliceFrames);
    assert(wholeState.reversePlayback == chunkedState.reversePlayback);
}

} // namespace

int main() {
    testPrepareAndParameterValidation();
    testCaptureForwardRepeatAndBoundaryCrossfade();
    testReverseAlternateDecayAndMix();
    testBoundaryLatchingResetAndChannelSafety();
    testAllocationFreeProcessingAndSegmentationInvariance();
    return 0;
}
