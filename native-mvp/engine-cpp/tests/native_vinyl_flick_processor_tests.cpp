#include "native_vinyl_flick_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <vector>

using namespace webrc::native;

namespace {

constexpr double kPi = 3.14159265358979323846;

void expectNear(float actual, float expected, float tolerance = 1.0e-5f) {
    assert(std::isfinite(actual));
    if (std::fabs(actual - expected) > tolerance) {
        std::fprintf(stderr, "expected %.9g, got %.9g (tolerance %.9g)\n", expected, actual, tolerance);
    }
    assert(std::fabs(actual - expected) <= tolerance);
}

void processTone(
    NativeVinylFlickProcessor& processor,
    unsigned int sampleRate,
    double frequencyHz,
    std::uint64_t firstFrame,
    std::size_t frames,
    std::vector<float>* output = nullptr,
    std::size_t outputBeginFrame = 0U
) {
    std::array<float, 512U> block{};
    std::size_t processed = 0U;
    while (processed < frames) {
        const auto count = std::min<std::size_t>(block.size() / 2U, frames - processed);
        for (std::size_t index = 0U; index < count; ++index) {
            const auto absoluteFrame = firstFrame + processed + index;
            const double phase = 2.0 * kPi * frequencyHz * static_cast<double>(absoluteFrame) /
                static_cast<double>(sampleRate);
            const float sample = static_cast<float>(0.25 * std::sin(phase));
            block[index * 2U] = sample;
            block[(index * 2U) + 1U] = static_cast<float>(0.20 * std::sin(phase + 0.27));
        }
        (void)processor.processInPlace(block.data(), static_cast<unsigned int>(count), 2U);
        if (output != nullptr) {
            for (std::size_t index = 0U; index < count; ++index) {
                const auto outputFrame = processed + index;
                if (outputFrame >= outputBeginFrame) {
                    const auto target = (outputFrame - outputBeginFrame) * 2U;
                    (*output)[target] = block[index * 2U];
                    (*output)[target + 1U] = block[(index * 2U) + 1U];
                }
            }
        }
        processed += count;
    }
}

double estimateFrequency(const std::vector<float>& interleaved, std::size_t firstFrame, std::size_t endFrame,
                         unsigned int sampleRate) {
    assert(endFrame > firstFrame + 1U);
    std::size_t crossings = 0U;
    for (std::size_t frame = firstFrame + 1U; frame < endFrame; ++frame) {
        const float before = interleaved[(frame - 1U) * 2U];
        const float current = interleaved[frame * 2U];
        if (before <= 0.0f && current > 0.0f) ++crossings;
    }
    return static_cast<double>(crossings) * static_cast<double>(sampleRate) /
        static_cast<double>(endFrame - firstFrame);
}

void testPrepareConfigurationAndChannelSemantics() {
    NativeVinylFlickProcessor processor;
    assert(!processor.prepare(7999U));
    assert(!processor.prepare(192001U));
    assert(processor.prepare(48000U));
    assert(processor.prepared());
    assert(processor.sampleRate() == 48000U);
    assert(processor.speedPercent() == 0.0f);
    assert(processor.motorReturnSeconds() == 1.0f);
    assert(processor.brakePercent() == 0.0f);
    assert(processor.mixPercent() == 100.0f);

    auto config = NativeVinylFlickConfig{};
    config.speedPercent = -100.0f;
    config.motorReturnSeconds = 0.05f;
    config.brakePercent = 100.0f;
    config.mixPercent = 0.0f;
    assert(processor.setConfig(config, 0U));
    assert(processor.speedPercent() == -100.0f);
    assert(processor.motorReturnSeconds() == 0.05f);
    assert(processor.brakePercent() == 100.0f);
    assert(processor.mixPercent() == 0.0f);

    auto invalid = config;
    invalid.speedPercent = -100.01f;
    assert(!processor.setConfig(invalid));
    invalid = config;
    invalid.motorReturnSeconds = std::numeric_limits<float>::quiet_NaN();
    assert(!processor.setConfig(invalid));
    invalid = config;
    invalid.brakePercent = 100.01f;
    assert(!processor.setConfig(invalid));
    invalid = config;
    invalid.mixPercent = -0.01f;
    assert(!processor.setConfig(invalid));

    std::array<float, 12U> stereoWithExtra{{0.1f, -0.2f, 0.75f, 0.3f, -0.4f, 0.75f,
                                            0.5f, -0.6f, 0.75f, 0.7f, -0.8f, 0.75f}};
    const auto original = stereoWithExtra;
    (void)processor.processInPlace(stereoWithExtra.data(), 4U, 3U);
    for (std::size_t frame = 0U; frame < 4U; ++frame) {
        expectNear(stereoWithExtra[(frame * 3U) + 2U], original[(frame * 3U) + 2U], 0.0f);
    }

    std::array<float, 4U> mono{{0.1f, -0.2f, 0.3f, -0.4f}};
    (void)processor.processInPlace(mono.data(), 4U, 1U);
    expectNear(mono[0], 0.1f, 0.0f);
    expectNear(mono[1], -0.2f, 0.0f);
}

void testInertialResponseAndBrakeHold() {
    constexpr unsigned int sampleRate = 48000U;
    NativeVinylFlickProcessor processor;
    auto config = NativeVinylFlickConfig{};
    config.motorReturnSeconds = 10.0f;
    assert(processor.setConfig(config));
    assert(processor.prepare(sampleRate));

    config.speedPercent = 100.0f;
    config.motorReturnSeconds = 10.0f;
    assert(processor.setConfig(config, 1U));
    std::array<float, 2U> frame{{0.2f, 0.2f}};
    const double speedBefore = processor.platterSpeedRatio();
    (void)processor.processInPlace(frame.data(), 1U, 2U);
    const double speedAfterOneFrame = processor.platterSpeedRatio();
    assert(speedAfterOneFrame > speedBefore);
    assert(speedAfterOneFrame < 1.001);

    config.speedPercent = -100.0f;
    config.motorReturnSeconds = 0.05f;
    config.brakePercent = 100.0f;
    assert(processor.setConfig(config, 1U));
    std::array<float, 1024U> brakeBlock{};
    for (std::size_t index = 0U; index < brakeBlock.size(); index += 2U) {
        brakeBlock[index] = 0.2f;
        brakeBlock[index + 1U] = 0.2f;
    }
    for (unsigned int frameIndex = 0U; frameIndex < sampleRate; frameIndex += 512U) {
        (void)processor.processInPlace(brakeBlock.data(), 512U, 2U);
    }
    assert(processor.platterSpeedRatio() < 1.0e-5);
    for (const float sample : brakeBlock) assert(std::isfinite(sample));

    config.speedPercent = 0.0f;
    config.brakePercent = 0.0f;
    assert(processor.setConfig(config, 1U));
    for (unsigned int frameIndex = 0U; frameIndex < sampleRate / 5U; frameIndex += 512U) {
        (void)processor.processInPlace(brakeBlock.data(), 512U, 2U);
    }
    assert(processor.platterSpeedRatio() > 0.05);
}

void testDefaultBrakeSettlesNearBothRequestedRates() {
    constexpr unsigned int sampleRate = 48000U;
    NativeVinylFlickProcessor processor;
    auto config = NativeVinylFlickConfig{};
    config.speedPercent = 0.0f;
    config.motorReturnSeconds = 1.5f;
    config.brakePercent = 35.0f;
    assert(processor.setConfig(config));
    assert(processor.prepare(sampleRate));

    std::array<float, 1024U> silence{};
    for (unsigned int frameIndex = 0U; frameIndex < sampleRate * 5U; frameIndex += 512U) {
        (void)processor.processInPlace(silence.data(), 512U, 2U);
    }
    assert(processor.platterSpeedRatio() > 0.85 && processor.platterSpeedRatio() < 1.0);

    config.speedPercent = 100.0f;
    assert(processor.setConfig(config, 1U));
    for (unsigned int frameIndex = 0U; frameIndex < sampleRate * 5U; frameIndex += 512U) {
        (void)processor.processInPlace(silence.data(), 512U, 2U);
    }
    assert(processor.platterSpeedRatio() > 1.7 && processor.platterSpeedRatio() < 2.0);
}

void testUnityRateMixUsesThreeFrameAlignedDryPath() {
    constexpr unsigned int sampleRate = 48000U;
    NativeVinylFlickProcessor processor;
    auto config = NativeVinylFlickConfig{};
    config.speedPercent = 0.0f;
    config.motorReturnSeconds = 0.05f;
    config.brakePercent = 0.0f;
    config.mixPercent = 50.0f;
    assert(processor.setConfig(config));
    assert(processor.prepare(sampleRate));
    assert(NativeVinylFlickProcessor::latencyFrames() == 3U);

    constexpr std::size_t frames = 4096U;
    std::vector<float> samples(frames * 2U);
    std::vector<float> original(frames * 2U);
    for (std::size_t frameIndex = 0U; frameIndex < frames; ++frameIndex) {
        const float left = static_cast<float>(0.31 * std::sin(2.0 * kPi * 317.0 * frameIndex / sampleRate));
        const float right = static_cast<float>(0.23 * std::cos(2.0 * kPi * 193.0 * frameIndex / sampleRate));
        samples[frameIndex * 2U] = left;
        samples[(frameIndex * 2U) + 1U] = right;
        original[frameIndex * 2U] = left;
        original[(frameIndex * 2U) + 1U] = right;
    }
    (void)processor.processInPlace(samples.data(), static_cast<unsigned int>(frames), 2U);
    for (std::size_t frameIndex = 0U; frameIndex < NativeVinylFlickProcessor::latencyFrames(); ++frameIndex) {
        expectNear(samples[frameIndex * 2U], 0.0f, 0.0f);
        expectNear(samples[(frameIndex * 2U) + 1U], 0.0f, 0.0f);
    }
    for (std::size_t frameIndex = NativeVinylFlickProcessor::latencyFrames(); frameIndex < frames; ++frameIndex) {
        expectNear(samples[frameIndex * 2U], original[(frameIndex - 3U) * 2U], 1.0e-5f);
        expectNear(samples[(frameIndex * 2U) + 1U], original[((frameIndex - 3U) * 2U) + 1U], 1.0e-5f);
    }
}

void testSustainedHalfSpeedOnBoundedHistory() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr double inputFrequency = 440.0;
    NativeVinylFlickProcessor processor;
    auto config = NativeVinylFlickConfig{};
    config.motorReturnSeconds = 0.05f;
    assert(processor.setConfig(config));
    assert(processor.prepare(sampleRate));

    // Fill the full rolling history at nominal speed before changing rate.
    // At 0.5x the read head reaches and wraps the oldest valid sample; this
    // run crosses that seam and verifies that the bounded loop keeps sounding.
    const std::size_t warmupFrames = NativeVinylFlickProcessor::kHistoryFrames + sampleRate / 10U;
    processTone(processor, sampleRate, inputFrequency, 0U, warmupFrames);

    config.speedPercent = -50.0f;
    assert(processor.setConfig(config, 1U));
    constexpr std::size_t runFrames = static_cast<std::size_t>(sampleRate) * 8U;
    constexpr std::size_t measuredFrames = static_cast<std::size_t>(sampleRate) * 2U;
    std::vector<float> measured(measuredFrames * 2U, 0.0f);
    processTone(processor, sampleRate, inputFrequency, warmupFrames, runFrames, &measured,
                runFrames - measuredFrames);

    const double outputFrequency = estimateFrequency(measured, 0U, measuredFrames, sampleRate);
    assert(outputFrequency > 205.0 && outputFrequency < 235.0);
    double squareSum = 0.0;
    for (const float sample : measured) {
        assert(std::isfinite(sample));
        squareSum += static_cast<double>(sample) * static_cast<double>(sample);
    }
    const double rms = std::sqrt(squareSum / static_cast<double>(measured.size()));
    assert(rms > 0.08);
    assert(processor.platterSpeedRatio() > 0.45 && processor.platterSpeedRatio() < 0.55);
}

void testStoppedTargetHoldsAndRestartsWithoutSilence() {
    constexpr unsigned int sampleRate = 48000U;
    NativeVinylFlickProcessor processor;
    auto config = NativeVinylFlickConfig{};
    config.motorReturnSeconds = 0.05f;
    assert(processor.setConfig(config));
    assert(processor.prepare(sampleRate));

    std::array<float, 2U> frame{{0.25f, 0.125f}};
    constexpr unsigned int warmupFrames = 4096U;
    for (unsigned int index = 0U; index < warmupFrames; ++index) {
        frame = {{0.25f, 0.125f}};
        (void)processor.processInPlace(frame.data(), 1U, 2U);
    }

    config.speedPercent = -100.0f;
    assert(processor.setConfig(config, 1U));
    std::array<float, 1024U> block{};
    constexpr unsigned int stopFrames = sampleRate;
    for (unsigned int frameIndex = 0U; frameIndex < stopFrames; frameIndex += 512U) {
        for (std::size_t index = 0U; index < block.size(); index += 2U) {
            block[index] = 0.25f;
            block[index + 1U] = 0.125f;
        }
        (void)processor.processInPlace(block.data(), 512U, 2U);
    }
    assert(processor.platterSpeedRatio() == 0.0);
    expectNear(block[block.size() - 2U], 0.25f, 0.02f);
    expectNear(block[block.size() - 1U], 0.125f, 0.02f);

    config.speedPercent = 0.0f;
    assert(processor.setConfig(config, 1U));
    for (unsigned int frameIndex = 0U; frameIndex < sampleRate / 5U; frameIndex += 512U) {
        for (std::size_t index = 0U; index < block.size(); index += 2U) {
            block[index] = 0.25f;
            block[index + 1U] = 0.125f;
        }
        (void)processor.processInPlace(block.data(), 512U, 2U);
    }
    assert(processor.platterSpeedRatio() > 0.9);
    for (const float sample : block) assert(std::isfinite(sample));
    assert(std::fabs(block[block.size() - 2U]) > 0.05f);
}

void testFastSpeedAndBlockSegmentationWithNoCallbackAllocation() {
    constexpr unsigned int sampleRate = 48000U;
    NativeVinylFlickProcessor fast;
    auto config = NativeVinylFlickConfig{};
    config.motorReturnSeconds = 0.05f;
    assert(fast.setConfig(config));
    assert(fast.prepare(sampleRate));
    const std::size_t warmupFrames = NativeVinylFlickProcessor::kHistoryFrames + 4096U;
    processTone(fast, sampleRate, 330.0, 0U, warmupFrames);
    config.speedPercent = 100.0f;
    assert(fast.setConfig(config, 1U));
    constexpr std::size_t fastFrames = sampleRate / 3U;
    std::vector<float> fastOutput(fastFrames * 2U, 0.0f);
    processTone(fast, sampleRate, 330.0, warmupFrames, fastFrames, &fastOutput, 0U);
    const double fastFrequency = estimateFrequency(fastOutput, sampleRate / 5U, fastFrames, sampleRate);
    assert(fastFrequency > 590.0 && fastFrequency < 700.0);

    NativeVinylFlickProcessor whole;
    NativeVinylFlickProcessor chunked;
    config.speedPercent = 40.0f;
    config.motorReturnSeconds = 0.7f;
    config.brakePercent = 12.0f;
    config.mixPercent = 65.0f;
    assert(whole.setConfig(config));
    assert(chunked.setConfig(config));
    assert(whole.prepare(sampleRate));
    assert(chunked.prepare(sampleRate));
    processTone(whole, sampleRate, 190.0, 0U, 2048U);
    processTone(chunked, sampleRate, 190.0, 0U, 2048U);
    assert(whole.setConfig(config, 333U));
    assert(chunked.setConfig(config, 333U));

    constexpr std::size_t frames = 16384U;
    std::vector<float> input(frames * 2U);
    for (std::size_t frameIndex = 0U; frameIndex < frames; ++frameIndex) {
        const double phase = 2.0 * kPi * 231.0 * static_cast<double>(frameIndex) / sampleRate;
        input[frameIndex * 2U] = static_cast<float>(0.35 * std::sin(phase));
        input[(frameIndex * 2U) + 1U] = static_cast<float>(0.27 * std::cos(phase * 0.83));
    }
    auto wholeOutput = input;
    auto chunkedOutput = input;
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    const float wholePeak = whole.processInPlace(wholeOutput.data(), static_cast<unsigned int>(frames), 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
    assert(std::isfinite(wholePeak));

    constexpr std::array<unsigned int, 7U> chunkSizes{{1U, 63U, 64U, 127U, 255U, 511U, 1024U}};
    std::size_t offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(
            chunkSizes[chunkIndex % chunkSizes.size()], frames - offset));
        (void)chunked.processInPlace(chunkedOutput.data() + offset * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t sample = 0U; sample < wholeOutput.size(); ++sample) {
        expectNear(chunkedOutput[sample], wholeOutput[sample], 1.0e-6f);
    }

    std::array<float, 256U> callbackBlock{};
    callbackBlock.fill(0.25f);
    const auto callbackAllocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    const float peak = whole.processInPlace(callbackBlock.data(), 128U, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == callbackAllocationsBefore);
    assert(std::isfinite(peak));
    for (const float sample : callbackBlock) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) < 2.0f);
    }
}

} // namespace

int main() {
    testPrepareConfigurationAndChannelSemantics();
    testInertialResponseAndBrakeHold();
    testDefaultBrakeSettlesNearBothRequestedRates();
    testUnityRateMixUsesThreeFrameAlignedDryPath();
    testSustainedHalfSpeedOnBoundedHistory();
    testStoppedTargetHoldsAndRestartsWithoutSilence();
    testFastSpeedAndBlockSegmentationWithNoCallbackAllocation();
    return 0;
}
