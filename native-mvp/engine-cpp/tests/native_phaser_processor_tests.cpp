#include "native_phaser_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <complex>
#include <cstddef>
#include <vector>

using namespace webrc::native;

namespace {

constexpr double kPi = 3.14159265358979323846;

std::complex<double> fundamental(
    const std::vector<float>& signal,
    std::size_t begin,
    std::size_t count,
    double omega
) {
    std::complex<double> sum{0.0, 0.0};
    for (std::size_t index = 0; index < count; ++index) {
        const double phase = omega * static_cast<double>(begin + index);
        sum += static_cast<double>(signal[begin + index]) * std::complex<double>{std::cos(phase), -std::sin(phase)};
    }
    return sum * (2.0 / static_cast<double>(count));
}

std::complex<double> expectedAllpass(float coefficient, double omega) {
    const std::complex<double> delay{std::cos(omega), -std::sin(omega)};
    return (static_cast<double>(coefficient) + delay) /
        (1.0 + static_cast<double>(coefficient) * delay);
}

void testPrepareDryBypassAndBounds() {
    NativePhaserProcessor phaser;
    assert(!phaser.prepare(0U));
    assert(phaser.prepare(48000U));
    assert(phaser.sampleRate() == 48000U);
    assert(!phaser.enabled());

    PhaserProcessorConfig bypassConfig;
    bypassConfig.stages = 4U;
    bypassConfig.rateHz = 10.0f;
    bypassConfig.depth = 1.0f;
    bypassConfig.feedback = 0.9f;
    bypassConfig.wetMix = 1.0f;
    assert(phaser.setConfig(bypassConfig, 0U));
    std::array<float, 8> samples{{1.25f, -1.5f, 0.8f, -0.7f, 0.1f, 0.2f, -0.3f, 0.4f}};
    const auto original = samples;
    const auto peak = phaser.processInPlace(samples.data(), 4U, 2U);
    assert(peak == 1.5f);
    for (std::size_t sample = 0; sample < samples.size(); ++sample) {
        assert(samples[sample] == original[sample]);
    }

    const std::array<unsigned int, 3> supportedStages{{4U, 8U, 12U}};
    for (const auto stages : supportedStages) {
        PhaserProcessorConfig config;
        config.stages = stages;
        assert(phaser.setConfig(config));
    }
    PhaserProcessorConfig invalid;
    invalid.stages = 6U;
    assert(!phaser.setConfig(invalid));
    invalid.stages = 8U;
    invalid.rateHz = 0.049f;
    assert(!phaser.setConfig(invalid));
    invalid.rateHz = 1.0f;
    invalid.depth = 1.01f;
    assert(!phaser.setConfig(invalid));
    invalid.depth = 0.5f;
    invalid.feedback = -0.91f;
    assert(!phaser.setConfig(invalid));
    invalid.feedback = 0.0f;
    invalid.wetMix = 1.01f;
    assert(!phaser.setConfig(invalid));

    std::array<float, 6> threeChannel{{0.1f, -0.2f, 0.3f, -0.4f, 0.5f, 0.6f}};
    const auto extraBefore = std::array<float, 2>{{threeChannel[2], threeChannel[5]}};
    (void)phaser.processInPlace(threeChannel.data(), 2U, 3U);
    assert(threeChannel[2] == extraBefore[0]);
    assert(threeChannel[5] == extraBefore[1]);
}

void testCascadedAllpassMagnitudeAndPhase() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = sampleRate;
    constexpr double frequencyHz = 750.0;
    const double omega = 2.0 * kPi * frequencyHz / static_cast<double>(sampleRate);

    NativePhaserProcessor phaser;
    assert(phaser.prepare(sampleRate));
    PhaserProcessorConfig config;
    config.enabled = true;
    config.stages = 4U;
    config.rateHz = 0.05f;
    config.depth = 0.0f; // holds the all-pass coefficient fixed for analysis
    config.feedback = 0.0f;
    config.wetMix = 1.0f;
    assert(phaser.setConfig(config, 0U));

    std::vector<float> input(frames);
    std::vector<float> output(frames);
    for (std::size_t frame = 0; frame < frames; ++frame) {
        input[frame] = static_cast<float>(0.5 * std::sin(omega * static_cast<double>(frame)));
        output[frame] = input[frame];
    }
    (void)phaser.processInPlace(output.data(), static_cast<unsigned int>(frames), 1U);

    // Match the processor's coefficient mapping at the zero-depth centre.
    const double centerHz = 140.0 * std::exp2(2.75);
    const double tangent = std::tan(kPi * centerHz / static_cast<double>(sampleRate));
    const float coefficient = static_cast<float>(std::clamp((tangent - 1.0) / (tangent + 1.0), -0.98, 0.98));
    auto expected = expectedAllpass(coefficient, omega);
    expected *= expected;
    expected *= expected; // Four identical cascaded first-order all-pass sections.

    constexpr std::size_t analysisBegin = frames / 2U;
    constexpr std::size_t analysisFrames = frames / 2U;
    const auto inputPhasor = fundamental(input, analysisBegin, analysisFrames, omega);
    const auto outputPhasor = fundamental(output, analysisBegin, analysisFrames, omega);
    const auto measured = outputPhasor / inputPhasor;
    assert(std::fabs(std::abs(measured) - 1.0) < 0.002); // all-pass magnitude
    assert(std::abs(std::arg(measured / expected)) < 0.01); // cascaded phase response
}

void testMovingNotchAndFeedbackStability() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = static_cast<std::size_t>(sampleRate) * 2U;
    constexpr double frequencyHz = 500.0;
    const double omega = 2.0 * kPi * frequencyHz / static_cast<double>(sampleRate);

    NativePhaserProcessor sweep;
    assert(sweep.prepare(sampleRate));
    PhaserProcessorConfig config;
    config.enabled = true;
    config.stages = 4U;
    config.rateHz = 0.5f;
    config.depth = 1.0f;
    config.feedback = 0.0f;
    config.wetMix = 0.5f;
    assert(sweep.setConfig(config, 0U));

    std::vector<float> tone(frames);
    for (std::size_t frame = 0; frame < frames; ++frame) {
        tone[frame] = static_cast<float>(0.5 * std::sin(omega * static_cast<double>(frame)));
    }
    (void)sweep.processInPlace(tone.data(), static_cast<unsigned int>(frames), 1U);

    constexpr std::size_t windowFrames = sampleRate / 50U;
    float minimumRms = 1.0f;
    float maximumRms = 0.0f;
    for (std::size_t begin = sampleRate / 10U; begin + windowFrames <= frames; begin += windowFrames) {
        double energy = 0.0;
        for (std::size_t frame = begin; frame < begin + windowFrames; ++frame) {
            energy += static_cast<double>(tone[frame]) * tone[frame];
        }
        const float rms = static_cast<float>(std::sqrt(energy / static_cast<double>(windowFrames)));
        minimumRms = std::min(minimumRms, rms);
        maximumRms = std::max(maximumRms, rms);
    }
    assert(maximumRms > 0.25f);
    assert(minimumRms < maximumRms * 0.35f); // the moving cascade creates a moving cancellation notch

    for (const float feedback : {-0.9f, 0.9f}) {
        NativePhaserProcessor stable;
        assert(stable.prepare(sampleRate));
        config.stages = 12U;
        config.rateHz = 10.0f;
        config.depth = 1.0f;
        config.feedback = feedback;
        config.wetMix = 1.0f;
        assert(stable.setConfig(config, 0U));
        constexpr std::size_t stressFrames = static_cast<std::size_t>(sampleRate) * 4U;
        std::vector<float> stress(stressFrames * 2U, 0.0f);
        for (std::size_t frame = 0; frame < stressFrames; ++frame) {
            const float signal = frame == 0U
                ? 0.8f
                : static_cast<float>(0.4 * std::sin(static_cast<double>(frame) * 0.031));
            stress[frame * 2U] = signal;
            stress[frame * 2U + 1U] = signal * -0.7f;
        }
        (void)stable.processInPlace(stress.data(), static_cast<unsigned int>(stressFrames), 2U);
        for (const float sample : stress) {
            assert(std::isfinite(sample));
            assert(std::fabs(sample) < 20.0f);
        }
    }
}

void testSegmentationAndCallbackAllocation() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = 8192U;
    NativePhaserProcessor wholeProcessor;
    NativePhaserProcessor chunkedProcessor;
    assert(wholeProcessor.prepare(sampleRate));
    assert(chunkedProcessor.prepare(sampleRate));
    PhaserProcessorConfig config;
    config.enabled = true;
    config.stages = 12U;
    config.rateHz = 1.8f;
    config.depth = 0.8f;
    config.feedback = -0.45f;
    config.wetMix = 0.67f;
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

    constexpr std::array<unsigned int, 7> chunks{{1U, 63U, 64U, 127U, 255U, 511U, 1024U}};
    std::size_t offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(chunks[chunkIndex % chunks.size()], frames - offset));
        (void)chunkedProcessor.processInPlace(chunked.data() + offset * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t sample = 0; sample < whole.size(); ++sample) {
        assert(std::isfinite(whole[sample]));
        assert(std::fabs(chunked[sample] - whole[sample]) < 1.0e-6f);
    }

    NativePhaserProcessor callbackProcessor;
    assert(callbackProcessor.prepare(sampleRate));
    assert(callbackProcessor.setConfig(config, 64U));
    std::array<float, 128> callbackBlock{};
    callbackBlock.fill(0.25f);
    const auto callbackAllocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)callbackProcessor.processInPlace(callbackBlock.data(), 64U, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == callbackAllocationsBefore);
}

} // namespace

int main() {
    testPrepareDryBypassAndBounds();
    testCascadedAllpassMagnitudeAndPhase();
    testMovingNotchAndFeedbackStability();
    testSegmentationAndCallbackAllocation();
    return 0;
}
