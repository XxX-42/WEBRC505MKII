#include "native_mod_delay_processor.hpp"
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

constexpr double kPi = 3.14159265358979323846;

NativeModDelayProcessorConfig activeConfig() {
    NativeModDelayProcessorConfig config;
    config.enabled = true;
    config.rateHz = 0.7f;
    config.depthMs = 8.0f;
    config.delayMs = 80.0f;
    config.feedback = 0.35f;
    config.wetMix = 0.75f;
    return config;
}

void testPrepareConfigAndCapacity() {
    NativeModDelayProcessor processor;
    assert(!processor.prepare(0U));
    assert(!processor.prepare(7999U));
    assert(!processor.prepare(192001U));
    assert(processor.prepare(48000U));
    assert(processor.sampleRate() == 48000U);
    assert(processor.delayCapacityFrames() >= 2050U * 48U + 4U);

    const auto valid = activeConfig();
    assert(processor.setConfig(valid, 0U));
    const auto capacityBefore = processor.delayCapacityFrames();
    assert(!processor.prepare(1000U));
    assert(processor.sampleRate() == 48000U);
    assert(processor.delayCapacityFrames() == capacityBefore);

    auto invalid = valid;
    invalid.rateHz = 0.049f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.rateHz = 10.01f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.depthMs = 50.1f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.delayMs = 9.9f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.delayMs = 2000.1f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.feedback = 0.951f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.feedback = -0.001f;
    assert(!processor.setConfig(invalid));
    invalid = valid;
    invalid.wetMix = std::numeric_limits<float>::quiet_NaN();
    assert(!processor.setConfig(invalid));

    const auto& retained = processor.config();
    assert(retained.rateHz == valid.rateHz);
    assert(retained.depthMs == valid.depthMs);
    assert(retained.delayMs == valid.delayMs);
    assert(retained.feedback == valid.feedback);
    assert(retained.wetMix == valid.wetMix);
}

void testModulationAndStereoPhase() {
    constexpr unsigned int sampleRate = 48000U;
    NativeModDelayProcessor moving;
    NativeModDelayProcessor fixed;
    assert(moving.prepare(sampleRate));
    assert(fixed.prepare(sampleRate));
    auto movingConfig = activeConfig();
    movingConfig.delayMs = 25.0f;
    movingConfig.depthMs = 8.0f;
    movingConfig.wetMix = 1.0f;
    assert(moving.setConfig(movingConfig, 0U));
    auto fixedConfig = movingConfig;
    fixedConfig.depthMs = 0.0f;
    assert(fixed.setConfig(fixedConfig, 0U));

    const std::size_t frames = sampleRate;
    std::vector<float> input(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const float sample = static_cast<float>(0.35 * std::sin(
            2.0 * kPi * 440.0 * static_cast<double>(frame) / static_cast<double>(sampleRate)
        ));
        input[frame * 2U] = sample;
        input[frame * 2U + 1U] = sample;
    }
    auto movingOutput = input;
    auto fixedOutput = input;
    (void)moving.processInPlace(movingOutput.data(), static_cast<unsigned int>(frames), 2U);
    (void)fixed.processInPlace(fixedOutput.data(), static_cast<unsigned int>(frames), 2U);

    double modulationDifferenceEnergy = 0.0;
    double stereoDifferenceEnergy = 0.0;
    for (std::size_t frame = sampleRate / 5U; frame < frames; ++frame) {
        const double modulationDifference = static_cast<double>(movingOutput[frame * 2U] - fixedOutput[frame * 2U]);
        const double stereoDifference = static_cast<double>(movingOutput[frame * 2U] - movingOutput[frame * 2U + 1U]);
        modulationDifferenceEnergy += modulationDifference * modulationDifference;
        stereoDifferenceEnergy += stereoDifference * stereoDifference;
    }
    assert(modulationDifferenceEnergy > 0.1);
    assert(stereoDifferenceEnergy > 0.1);
    for (const float sample : movingOutput) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) <= 8.0f);
    }
}

void testDepthIsReducedAtDelayBounds() {
    constexpr unsigned int sampleRate = 8000U;
    constexpr unsigned int frames = 1600U;
    NativeModDelayProcessor boundary;
    NativeModDelayProcessor fixed;
    assert(boundary.prepare(sampleRate));
    assert(fixed.prepare(sampleRate));
    auto boundaryConfig = activeConfig();
    boundaryConfig.delayMs = 10.0f;
    boundaryConfig.depthMs = 50.0f;
    boundaryConfig.feedback = 0.0f;
    boundaryConfig.wetMix = 1.0f;
    assert(boundary.setConfig(boundaryConfig, 0U));
    auto fixedConfig = boundaryConfig;
    fixedConfig.depthMs = 0.0f;
    assert(fixed.setConfig(fixedConfig, 0U));

    std::vector<float> input(static_cast<std::size_t>(frames) * 2U);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        input[static_cast<std::size_t>(frame) * 2U] = static_cast<float>(
            0.4 * std::sin(2.0 * kPi * 330.0 * static_cast<double>(frame) / sampleRate)
        );
        input[static_cast<std::size_t>(frame) * 2U + 1U] = input[static_cast<std::size_t>(frame) * 2U];
    }
    auto boundaryOutput = input;
    auto fixedOutput = input;
    (void)boundary.processInPlace(boundaryOutput.data(), frames, 2U);
    (void)fixed.processInPlace(fixedOutput.data(), frames, 2U);
    for (std::size_t sample = 0U; sample < fixedOutput.size(); ++sample) {
        assert(std::fabs(boundaryOutput[sample] - fixedOutput[sample]) <= 1.0e-6f);
    }
}

void testChunkInvarianceAndCallbackAllocationFree() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = 8192U;
    NativeModDelayProcessor wholeProcessor;
    NativeModDelayProcessor chunkedProcessor;
    assert(wholeProcessor.prepare(sampleRate));
    assert(chunkedProcessor.prepare(sampleRate));
    const auto config = activeConfig();
    assert(wholeProcessor.setConfig(config, 257U));
    assert(chunkedProcessor.setConfig(config, 257U));

    std::vector<float> input(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        input[frame * 2U] = static_cast<float>(0.45 * std::sin(static_cast<double>(frame) * 0.023));
        input[frame * 2U + 1U] = static_cast<float>(0.35 * std::cos(static_cast<double>(frame) * 0.019));
    }
    auto whole = input;
    auto chunked = input;
    const auto beforeWhole = test_alloc::count();
    test_alloc::beginTracking();
    (void)wholeProcessor.processInPlace(whole.data(), static_cast<unsigned int>(frames), 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == beforeWhole);

    constexpr std::array<unsigned int, 7U> chunks{{1U, 31U, 64U, 127U, 257U, 512U, 1024U}};
    std::size_t offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(chunks[chunkIndex % chunks.size()], frames - offset));
        (void)chunkedProcessor.processInPlace(chunked.data() + offset * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t sample = 0U; sample < whole.size(); ++sample) {
        assert(std::isfinite(whole[sample]));
        assert(std::fabs(chunked[sample] - whole[sample]) <= 1.0e-6f);
    }

    NativeModDelayProcessor callbackProcessor;
    assert(callbackProcessor.prepare(sampleRate));
    assert(callbackProcessor.setConfig(config, 64U));
    std::array<float, 128U> callbackBlock{};
    callbackBlock.fill(0.2f);
    const auto beforeCallback = test_alloc::count();
    test_alloc::beginTracking();
    (void)callbackProcessor.processInPlace(callbackBlock.data(), 64U, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == beforeCallback);
}

void testFiniteBoundedFeedbackAndExtraChannels() {
    constexpr unsigned int sampleRate = 48000U;
    NativeModDelayProcessor processor;
    assert(processor.prepare(sampleRate));
    auto config = activeConfig();
    config.delayMs = 20.0f;
    config.depthMs = 2.0f;
    config.rateHz = 0.3f;
    config.feedback = 0.9f;
    config.wetMix = 1.0f;
    assert(processor.setConfig(config, 0U));

    constexpr unsigned int frames = sampleRate * 2U;
    constexpr unsigned int channels = 3U;
    std::vector<float> signal(static_cast<std::size_t>(frames) * channels, 0.0f);
    signal[0U] = 2.0f;
    signal[1U] = -2.0f;
    signal[2U] = std::numeric_limits<float>::infinity();
    signal[3U] = std::numeric_limits<float>::quiet_NaN();
    signal[4U] = -std::numeric_limits<float>::infinity();
    signal[5U] = 1.0e30f;
    const float peak = processor.processInPlace(signal.data(), frames, channels);
    assert(std::isfinite(peak));
    assert(peak <= 8.0f);
    for (const float sample : signal) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) <= 8.0f);
    }
}

} // namespace

int main() {
    testPrepareConfigAndCapacity();
    testModulationAndStereoPhase();
    testDepthIsReducedAtDelayBounds();
    testChunkInvarianceAndCallbackAllocationFree();
    testFiniteBoundedFeedbackAndExtraChannels();
    return 0;
}
