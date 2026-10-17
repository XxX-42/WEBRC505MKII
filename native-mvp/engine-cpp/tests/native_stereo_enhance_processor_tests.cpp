#include "native_stereo_enhance_processor.hpp"
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

void expectNear(float actual, float expected, float tolerance = 1.0e-6f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

double measureSideRms(float frequencyHz, float cutoffHz) {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = sampleRate;
    NativeStereoEnhanceProcessor processor;
    assert(processor.prepare(sampleRate));
    NativeStereoEnhanceConfig config;
    config.widthPercent = 100.0f;
    config.lowMonoCutoffHz = cutoffHz;
    config.decorrelationPercent = 0.0f;
    config.wetMixPercent = 100.0f;
    assert(processor.setConfig(config, 0U));

    std::vector<float> signal(static_cast<std::size_t>(frames) * 2U);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float sample = static_cast<float>(0.5 * std::sin(2.0 * kPi * frequencyHz * frame / sampleRate));
        signal[static_cast<std::size_t>(frame) * 2U] = sample;
        signal[static_cast<std::size_t>(frame) * 2U + 1U] = -sample;
    }
    (void)processor.processInPlace(signal.data(), frames, 2U);
    double energy = 0.0;
    unsigned int count = 0U;
    for (unsigned int frame = frames / 4U; frame < frames; ++frame) {
        const double side = 0.5 * (signal[static_cast<std::size_t>(frame) * 2U] -
                                   signal[static_cast<std::size_t>(frame) * 2U + 1U]);
        energy += side * side;
        ++count;
    }
    return std::sqrt(energy / count);
}

void testValidationAndMonoChannelPreservation() {
    NativeStereoEnhanceProcessor processor;
    assert(!processor.prepare(7999U));
    assert(processor.prepare(48000U));
    NativeStereoEnhanceConfig config;
    assert(!processor.setConfig({-1.0f, 120.0f, 25.0f, 100.0f}));
    assert(!processor.setConfig({100.0f, 1001.0f, 25.0f, 100.0f}));
    assert(!processor.setConfig({100.0f, 120.0f, 101.0f, 100.0f}));
    assert(!processor.setConfig({100.0f, 120.0f, 25.0f, std::numeric_limits<float>::quiet_NaN()}));
    assert(processor.setConfig(config, 0U));

    std::array<float, 7U> mono{{0.25f, -0.7f, 0.0f, 1.1f, -0.3f, 0.9f, 0.2f}};
    const auto original = mono;
    const float peak = processor.processInPlace(mono.data(), static_cast<unsigned int>(mono.size()), 1U);
    expectNear(peak, 1.1f);
    for (std::size_t index = 0U; index < mono.size(); ++index) expectNear(mono[index], original[index], 0.0f);
}

void testMonoCompatibilityAndLowFrequencySideAttenuation() {
    constexpr unsigned int sampleRate = 48000U;
    NativeStereoEnhanceProcessor processor;
    assert(processor.prepare(sampleRate));
    NativeStereoEnhanceConfig config;
    config.widthPercent = 100.0f;
    config.lowMonoCutoffHz = 120.0f;
    config.decorrelationPercent = 0.0f;
    config.wetMixPercent = 100.0f;
    assert(processor.setConfig(config, 0U));
    std::vector<float> inPhase(4096U * 2U);
    for (std::size_t frame = 0U; frame < inPhase.size() / 2U; ++frame) {
        const float sample = static_cast<float>(0.45 * std::sin(2.0 * kPi * 440.0 * frame / sampleRate));
        inPhase[frame * 2U] = sample;
        inPhase[frame * 2U + 1U] = sample;
    }
    const auto exactCopy = inPhase;
    (void)processor.processInPlace(inPhase.data(), static_cast<unsigned int>(inPhase.size() / 2U), 2U);
    for (std::size_t index = 0U; index < inPhase.size(); ++index) expectNear(inPhase[index], exactCopy[index], 1.0e-6f);

    const double lowSide = measureSideRms(60.0f, 120.0f);
    const double highSide = measureSideRms(1000.0f, 120.0f);
    assert(highSide > lowSide * 1.8);
}

void testAllpassDecorrelationPreservesMidAndWidthSafety() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = 8192U;
    NativeStereoEnhanceProcessor dryDecorrelation;
    NativeStereoEnhanceProcessor fullDecorrelation;
    assert(dryDecorrelation.prepare(sampleRate));
    assert(fullDecorrelation.prepare(sampleRate));
    NativeStereoEnhanceConfig config;
    config.widthPercent = 100.0f;
    config.lowMonoCutoffHz = 20.0f;
    config.decorrelationPercent = 0.0f;
    config.wetMixPercent = 100.0f;
    assert(dryDecorrelation.setConfig(config, 0U));
    config.decorrelationPercent = 100.0f;
    assert(fullDecorrelation.setConfig(config, 0U));
    std::vector<float> original(static_cast<std::size_t>(frames) * 2U);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float mid = static_cast<float>(0.15 * std::sin(2.0 * kPi * 330.0 * frame / sampleRate));
        const float side = static_cast<float>(0.3 * std::sin(2.0 * kPi * 970.0 * frame / sampleRate));
        original[static_cast<std::size_t>(frame) * 2U] = mid + side;
        original[static_cast<std::size_t>(frame) * 2U + 1U] = mid - side;
    }
    auto uncolored = original;
    auto colored = original;
    (void)dryDecorrelation.processInPlace(uncolored.data(), frames, 2U);
    (void)fullDecorrelation.processInPlace(colored.data(), frames, 2U);
    double differenceEnergy = 0.0;
    for (unsigned int frame = frames / 4U; frame < frames; ++frame) {
        const std::size_t offset = static_cast<std::size_t>(frame) * 2U;
        const float mid = 0.5f * (colored[offset] + colored[offset + 1U]);
        const float expectedMid = 0.5f * (original[offset] + original[offset + 1U]);
        expectNear(mid, expectedMid, 2.0e-5f);
        const double difference = static_cast<double>(colored[offset] - uncolored[offset]);
        differenceEnergy += difference * difference;
    }
    assert(differenceEnergy > 0.01);

    NativeStereoEnhanceProcessor limiter;
    assert(limiter.prepare(sampleRate));
    config.widthPercent = 200.0f;
    config.lowMonoCutoffHz = 20.0f;
    config.decorrelationPercent = 0.0f;
    assert(limiter.setConfig(config, 0U));
    std::array<float, 2U> antiPhase{{0.2f, -0.2f}};
    (void)limiter.processInPlace(antiPhase.data(), 1U, 2U);
    expectNear(antiPhase[0], 0.0f, 1.0e-7f);
    expectNear(antiPhase[1], 0.0f, 1.0e-7f);
}

void testChunkInvarianceResetAndAllocationFreeProcessing() {
    constexpr unsigned int sampleRate = 44100U;
    constexpr std::size_t frames = 10037U;
    NativeStereoEnhanceProcessor wholeProcessor;
    NativeStereoEnhanceProcessor chunkedProcessor;
    assert(wholeProcessor.prepare(sampleRate));
    assert(chunkedProcessor.prepare(sampleRate));
    NativeStereoEnhanceConfig config;
    config.widthPercent = 165.0f;
    config.lowMonoCutoffHz = 220.0f;
    config.decorrelationPercent = 60.0f;
    config.wetMixPercent = 85.0f;
    assert(wholeProcessor.setConfig(config, 777U));
    assert(chunkedProcessor.setConfig(config, 777U));

    std::vector<float> input(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        input[frame * 2U] = static_cast<float>(0.35 * std::sin(static_cast<double>(frame) * 0.013));
        input[frame * 2U + 1U] = static_cast<float>(0.31 * std::cos(static_cast<double>(frame) * 0.017));
    }
    auto whole = input;
    auto chunked = input;
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)wholeProcessor.processInPlace(whole.data(), static_cast<unsigned int>(frames), 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);

    constexpr std::array<unsigned int, 7U> chunks{{1U, 17U, 63U, 64U, 255U, 511U, 1024U}};
    std::size_t offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(chunks[chunkIndex % chunks.size()], frames - offset));
        (void)chunkedProcessor.processInPlace(chunked.data() + offset * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t index = 0U; index < whole.size(); ++index) {
        assert(std::isfinite(whole[index]));
        expectNear(whole[index], chunked[index], 0.0f);
    }

    wholeProcessor.reset();
    assert(wholeProcessor.setConfig(config, 0U));
    auto afterReset = input;
    (void)wholeProcessor.processInPlace(afterReset.data(), static_cast<unsigned int>(frames), 2U);
    NativeStereoEnhanceProcessor resetReference;
    assert(resetReference.prepare(sampleRate));
    assert(resetReference.setConfig(config, 0U));
    auto expectedReset = input;
    (void)resetReference.processInPlace(expectedReset.data(), static_cast<unsigned int>(frames), 2U);
    for (std::size_t index = 0U; index < expectedReset.size(); ++index) {
        expectNear(afterReset[index], expectedReset[index], 0.0f);
    }
}

} // namespace

int main() {
    testValidationAndMonoChannelPreservation();
    testMonoCompatibilityAndLowFrequencySideAttenuation();
    testAllpassDecorrelationPreservesMidAndWidthSafety();
    testChunkInvarianceResetAndAllocationFreeProcessing();
    return 0;
}
