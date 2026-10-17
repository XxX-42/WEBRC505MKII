#include "native_beat_scatter_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <limits>
#include <vector>

using namespace webrc::native;

namespace {

void expectNear(float actual, float expected, float tolerance = 1.0e-5f) {
    assert(std::isfinite(actual));
    if (std::fabs(actual - expected) > tolerance) {
        std::fprintf(stderr, "expected %.9f +/- %.9f, got %.9f\n", expected, tolerance, actual);
    }
    assert(std::fabs(actual - expected) <= tolerance);
}

void fillStereoSignal(std::vector<float>& samples) {
    const std::size_t frames = samples.size() / 2U;
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        samples[frame * 2U] = static_cast<float>(std::sin(static_cast<double>(frame) * 0.021) * 0.4);
        samples[frame * 2U + 1U] = static_cast<float>(std::cos(static_cast<double>(frame) * 0.017) * 0.3);
    }
}

void testPrepareConfigRangesAndTempoBoundaries() {
    NativeBeatScatterProcessor processor;
    assert(!processor.prepare(7999U));
    assert(!processor.prepare(NativeBeatScatterProcessor::kMaximumSampleRate + 1U));
    assert(processor.prepare(8000U));
    assert(processor.maxSliceFrames() == 48002U);
    assert(processor.remainingFramesToBoundary() == 1000U);

    const auto defaults = processor.activeConfig();
    expectNear(defaults.bpm, 120.0f);
    expectNear(defaults.sliceBeats, 0.25f);
    expectNear(defaults.scatterPercent, 50.0f);
    expectNear(defaults.pitchSemitones, 0.0f);
    assert(defaults.repeats == 4U);
    expectNear(defaults.wetMix, 0.5f);

    auto invalid = defaults;
    invalid.bpm = std::numeric_limits<float>::quiet_NaN();
    assert(!processor.setConfig(invalid));
    invalid = defaults;
    invalid.bpm = 39.99f;
    assert(!processor.setConfig(invalid));
    invalid = defaults;
    invalid.sliceBeats = 0.75f;
    assert(!processor.setConfig(invalid));
    invalid = defaults;
    invalid.scatterPercent = 100.1f;
    assert(!processor.setConfig(invalid));
    invalid = defaults;
    invalid.pitchSemitones = -24.1f;
    assert(!processor.setConfig(invalid));
    invalid = defaults;
    invalid.repeats = 0U;
    assert(!processor.setConfig(invalid));
    invalid = defaults;
    invalid.wetMix = 1.01f;
    assert(!processor.setConfig(invalid));

    auto maximum = defaults;
    maximum.bpm = 300.0f;
    maximum.sliceBeats = 4.0f;
    maximum.scatterPercent = 100.0f;
    maximum.pitchSemitones = 24.0f;
    maximum.repeats = 16U;
    maximum.wetMix = 1.0f;
    assert(processor.setConfig(maximum, 0U));
    assert(processor.activeConfig().bpm == 300.0f);
    assert(processor.activeConfig().sliceBeats == 4.0f);
    assert(processor.remainingFramesToBoundary() == 6400U);
}

void testSliceCaptureAndRepeatSegmentsChangeAudio() {
    NativeBeatScatterProcessor processor;
    assert(processor.prepare(8000U));
    NativeBeatScatterConfig config;
    config.bpm = 120.0f;
    config.sliceBeats = 0.25f;
    config.scatterPercent = 0.0f;
    config.pitchSemitones = 0.0f;
    config.repeats = 4U;
    config.wetMix = 1.0f;
    assert(processor.setConfig(config, 0U));

    std::vector<float> ramp(2001U * 2U, 0.0f);
    for (std::size_t frame = 0U; frame < 1000U; ++frame) {
        ramp[frame * 2U] = static_cast<float>(frame) / 1000.0f;
        ramp[frame * 2U + 1U] = -static_cast<float>(frame) / 2000.0f;
    }
    std::fill(ramp.begin() + 2000U, ramp.begin() + 4000U, 0.4f);
    std::fill(ramp.begin() + 4000U, ramp.end(), -0.25f);

    const auto peak = processor.processInPlace(ramp.data(), 2001U, 2U);
    assert(peak <= 1.0f);
    // The first full slice is a deliberate dry pass-through while it is filled.
    for (std::size_t frame = 0U; frame < 1000U; ++frame) {
        expectNear(ramp[frame * 2U], static_cast<float>(frame) / 1000.0f, 0.0f);
        expectNear(ramp[frame * 2U + 1U], -static_cast<float>(frame) / 2000.0f, 0.0f);
    }
    expectNear(ramp[2000U], 0.0f, 1.0e-6f);
    expectNear(ramp[1249U * 2U], 0.249f, 0.002f);
    expectNear(ramp[1249U * 2U + 1U], -0.1245f, 0.002f);

    // Scatter reorders the slice deterministically; the next completed capture
    // has a contrasting level so the output change is plainly observable.
    assert(processor.status().hasCapturedSlice);
    assert(processor.status().boundaryCount == 2U);
    assert(processor.status().lastBoundaryFrame == 1999);
    assert(processor.status().activeSliceFrames == 1000U);
    assert(processor.status().remainingFramesToBoundary == 999U);
}

void testControlsLatchAtBoundaryAndPitchIsAudible() {
    NativeBeatScatterProcessor processor;
    assert(processor.prepare(8000U));
    NativeBeatScatterConfig config;
    config.scatterPercent = 0.0f;
    config.pitchSemitones = 0.0f;
    config.repeats = 4U;
    config.wetMix = 1.0f;
    assert(processor.setConfig(config, 0U));

    std::vector<float> first(400U, 0.2f);
    (void)processor.processInPlace(first.data(), 400U, 1U);
    auto pending = config;
    pending.bpm = 60.0f;
    pending.sliceBeats = 0.5f;
    pending.scatterPercent = 0.0f;
    pending.pitchSemitones = 12.0f;
    pending.repeats = 8U;
    pending.wetMix = 0.5f;
    assert(processor.setConfig(pending, 0U));
    assert(processor.activeConfig().bpm == 120.0f);
    assert(processor.activeConfig().sliceBeats == 0.25f);
    assert(processor.remainingFramesToBoundary() == 600U);

    std::vector<float> toBoundary(600U, 0.3f);
    (void)processor.processInPlace(toBoundary.data(), 600U, 1U);
    assert(processor.status().lastBoundaryFrame == 999);
    assert(processor.activeConfig().bpm == 60.0f);
    assert(processor.activeConfig().sliceBeats == 0.5f);
    assert(processor.activeConfig().scatterPercent == 0.0f);
    assert(processor.activeConfig().pitchSemitones == 12.0f);
    assert(processor.activeConfig().repeats == 8U);
    assert(processor.remainingFramesToBoundary() == 4000U);

    // Complete the updated slice, then verify its read-head plays at the
    // configured octave-up rate rather than replaying the captured source.
    std::vector<float> next(8001U, 0.0f);
    for (std::size_t index = 0U; index < 4000U; ++index) {
        next[index] = static_cast<float>(index) / 4000.0f;
    }
    (void)processor.processInPlace(next.data(), 8001U, 1U);
    assert(processor.status().boundaryCount == 3U);
    assert(processor.status().activeSliceFrames == 4000U);
    // The first output grain starts at local frame 4000. At output offset 100,
    // octave-up resampling reads source offset 200 from the captured ramp.
    expectNear(next[4100U], 0.05f * 0.70710678f, 0.002f);
}

void testScatterAmountChangesTheDeterministicGrainOrder() {
    NativeBeatScatterProcessor orderedProcessor;
    NativeBeatScatterProcessor scatteredProcessor;
    assert(orderedProcessor.prepare(8000U));
    assert(scatteredProcessor.prepare(8000U));
    NativeBeatScatterConfig ordered;
    ordered.scatterPercent = 0.0f;
    ordered.wetMix = 1.0f;
    auto scattered = ordered;
    scattered.scatterPercent = 100.0f;
    assert(orderedProcessor.setConfig(ordered, 0U));
    assert(scatteredProcessor.setConfig(scattered, 0U));

    std::vector<float> orderedSamples(2000U, 0.0f);
    std::vector<float> scatteredSamples(2000U, 0.0f);
    for (std::size_t frame = 0U; frame < 1000U; ++frame) {
        const float value = static_cast<float>(frame) / 1000.0f;
        orderedSamples[frame] = value;
        scatteredSamples[frame] = value;
    }
    (void)orderedProcessor.processInPlace(orderedSamples.data(), 2000U, 1U);
    (void)scatteredProcessor.processInPlace(scatteredSamples.data(), 2000U, 1U);
    assert(orderedProcessor.status().hasCapturedSlice && scatteredProcessor.status().hasCapturedSlice);

    bool outputChanged = false;
    for (std::size_t frame = 1000U; frame < 2000U; ++frame) {
        if (std::fabs(orderedSamples[frame] - scatteredSamples[frame]) > 0.01f) {
            outputChanged = true;
            break;
        }
    }
    assert(outputChanged);
}

void testFiniteClampedAudioAndExtraChannelPassThrough() {
    NativeBeatScatterProcessor processor;
    assert(processor.prepare(8000U));
    NativeBeatScatterConfig config;
    config.wetMix = 1.0f;
    assert(processor.setConfig(config, 0U));

    std::array<float, 6U> threeChannels{{80.0f, -80.0f, 0.75f,
        std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::infinity(), -0.5f}};
    (void)processor.processInPlace(threeChannels.data(), 2U, 3U);
    expectNear(threeChannels[0], 64.0f, 0.0f);
    expectNear(threeChannels[1], -64.0f, 0.0f);
    expectNear(threeChannels[3], 0.0f, 0.0f);
    expectNear(threeChannels[4], 0.0f, 0.0f);
    expectNear(threeChannels[2], 0.75f, 0.0f);
    expectNear(threeChannels[5], -0.5f, 0.0f);

    std::array<float, 2U> oneFrame{{std::numeric_limits<float>::quiet_NaN(), 12.0f}};
    assert(processor.processInPlace(oneFrame.data(), 1U, 0U) == 0.0f);
    assert(std::isnan(oneFrame[0]));
    const auto peak = processor.processInPlace(oneFrame.data(), 1U, 1U);
    assert(std::isfinite(peak) && peak <= 64.0f);
    expectNear(oneFrame[0], 0.0f, 0.0f);
}

void testAllocationFreeVariableBlocksAndDeterminism() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = 8192U;
    NativeBeatScatterProcessor wholeProcessor;
    NativeBeatScatterProcessor chunkedProcessor;
    assert(wholeProcessor.prepare(sampleRate));
    assert(chunkedProcessor.prepare(sampleRate));
    NativeBeatScatterConfig config;
    config.bpm = 137.0f;
    config.sliceBeats = 0.25f;
    config.scatterPercent = 83.0f;
    config.pitchSemitones = -7.0f;
    config.repeats = 7U;
    config.wetMix = 0.75f;
    assert(wholeProcessor.setConfig(config, 0U));
    assert(chunkedProcessor.setConfig(config, 0U));

    std::vector<float> whole(frames * 2U);
    fillStereoSignal(whole);
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
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(chunks[chunkIndex % chunks.size()],
            frames - offset));
        (void)chunkedProcessor.processInPlace(chunked.data() + offset * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    assert(chunked == whole);
    assert(wholeProcessor.status().boundaryCount == chunkedProcessor.status().boundaryCount);
    assert(wholeProcessor.status().lastBoundaryFrame == chunkedProcessor.status().lastBoundaryFrame);

    NativeBeatScatterProcessor replayProcessor;
    assert(replayProcessor.prepare(sampleRate));
    assert(replayProcessor.setConfig(config, 0U));
    std::vector<float> replay(frames * 2U);
    fillStereoSignal(replay);
    (void)replayProcessor.processInPlace(replay.data(), static_cast<unsigned int>(frames), 2U);
    assert(replay == whole);
}

} // namespace

int main() {
    testPrepareConfigRangesAndTempoBoundaries();
    testSliceCaptureAndRepeatSegmentsChangeAudio();
    testControlsLatchAtBoundaryAndPitchIsAudible();
    testScatterAmountChangesTheDeterministicGrainOrder();
    testFiniteClampedAudioAndExtraChannelPassThrough();
    testAllocationFreeVariableBlocksAndDeterminism();
    return 0;
}
