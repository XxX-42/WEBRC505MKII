#include "native_fx_catalog.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <limits>
#include <memory>
#include <vector>

using namespace webrc::native;

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr unsigned int kSampleRate = 48000U;

std::unique_ptr<NativeEffectProcessor> makeIsolator() {
    auto processor = createNativeEffectProcessor("isolator");
    assert(processor != nullptr);
    assert(processor->prepare(kSampleRate));
    return processor;
}

double measureRms(float frequencyHz, float lowDb, float midDb, float highDb) {
    constexpr unsigned int frames = kSampleRate;
    auto processor = makeIsolator();
    assert(processor->setParameter("low_crossover_hz", 250.0f, 1U));
    assert(processor->setParameter("high_crossover_hz", 3000.0f, 1U));
    assert(processor->setParameter("low_gain_db", lowDb, 1U));
    assert(processor->setParameter("mid_gain_db", midDb, 1U));
    assert(processor->setParameter("high_gain_db", highDb, 1U));

    std::vector<float> signal(frames);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        signal[frame] = static_cast<float>(0.4 * std::sin(2.0 * kPi * frequencyHz * frame / kSampleRate));
    }
    (void)processor->processInPlace(signal.data(), frames, 1U);

    double energy = 0.0;
    unsigned int count = 0U;
    for (unsigned int frame = frames / 2U; frame < frames; ++frame) {
        const double sample = signal[frame];
        energy += sample * sample;
        ++count;
    }
    return std::sqrt(energy / count);
}

void testCatalogBoundsAndDiscreteValues() {
    const auto* descriptor = findNativeEffectDescriptor("isolator");
    assert(descriptor != nullptr);
    assert(descriptor->sourceIndex == 27);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    assert(descriptor->parameterCount == 11U);

    auto processor = makeIsolator();
    assert(processor->setParameter("low_crossover_hz", 8000.0f));
    assert(processor->setParameter("high_crossover_hz", 18000.0f));
    assert(processor->setParameter("low_gain_db", -24.0f));
    assert(processor->setParameter("mid_gain_db", 12.0f));
    assert(processor->setParameter("high_gain_db", 0.0f));
    assert(processor->setParameter("gate_enabled", 1.0f));
    assert(processor->setParameter("gate_bpm", 300.0f));
    assert(processor->setParameter("gate_division_beats", 4.0f));
    assert(processor->setParameter("gate_duty_percent", 95.0f));
    assert(processor->setParameter("gate_attack_ms", 50.0f));
    assert(processor->setParameter("gate_release_ms", 250.0f));

    assert(!processor->setParameter("low_crossover_hz", 39.9f));
    assert(!processor->setParameter("high_crossover_hz", 18000.1f));
    assert(!processor->setParameter("low_gain_db", -24.1f));
    assert(!processor->setParameter("mid_gain_db", 12.1f));
    assert(!processor->setParameter("high_gain_db", std::numeric_limits<float>::quiet_NaN()));
    assert(!processor->setParameter("gate_enabled", 0.5f));
    assert(!processor->setParameter("gate_bpm", 300.1f));
    assert(!processor->setParameter("gate_division_beats", 3.0f));
    assert(!processor->setParameter("gate_duty_percent", 4.9f));
    assert(!processor->setParameter("gate_attack_ms", 50.1f));
    assert(!processor->setParameter("gate_release_ms", 250.1f));
    assert(!processor->setParameter("unknown_control", 1.0f));
}

void testUnityReconstructionAndThreeBandResponse() {
    const double unityLow = measureRms(80.0f, 0.0f, 0.0f, 0.0f);
    const double unityLowCrossover = measureRms(250.0f, 0.0f, 0.0f, 0.0f);
    const double unityMid = measureRms(1000.0f, 0.0f, 0.0f, 0.0f);
    const double unityHighCrossover = measureRms(3000.0f, 0.0f, 0.0f, 0.0f);
    const double unityHigh = measureRms(12000.0f, 0.0f, 0.0f, 0.0f);
    assert(std::fabs(unityLow - (0.4 / std::sqrt(2.0))) < 0.005);
    assert(std::fabs(unityLowCrossover - (0.4 / std::sqrt(2.0))) < 0.005);
    assert(std::fabs(unityMid - (0.4 / std::sqrt(2.0))) < 0.005);
    assert(std::fabs(unityHighCrossover - (0.4 / std::sqrt(2.0))) < 0.005);
    assert(std::fabs(unityHigh - (0.4 / std::sqrt(2.0))) < 0.005);

    const double lowBoost = measureRms(80.0f, 12.0f, 0.0f, 0.0f);
    const double lowUnaffected = measureRms(8000.0f, 12.0f, 0.0f, 0.0f);
    const double midBoost = measureRms(1000.0f, 0.0f, 12.0f, 0.0f);
    const double midUnaffected = measureRms(80.0f, 0.0f, 12.0f, 0.0f);
    const double highBoost = measureRms(12000.0f, 0.0f, 0.0f, 12.0f);
    const double highUnaffected = measureRms(1000.0f, 0.0f, 0.0f, 12.0f);
    assert(lowBoost > lowUnaffected * 2.5);
    assert(midBoost > midUnaffected * 2.5);
    assert(highBoost > highUnaffected * 2.5);
}

void configureGate(NativeEffectProcessor& processor, float bpm) {
    assert(processor.setParameter("gate_enabled", 1.0f, 1U));
    assert(processor.setParameter("gate_bpm", bpm, 1U));
    assert(processor.setParameter("gate_division_beats", 0.5f, 1U));
    assert(processor.setParameter("gate_duty_percent", 50.0f, 1U));
    assert(processor.setParameter("gate_attack_ms", 1.0f, 1U));
    assert(processor.setParameter("gate_release_ms", 1.0f, 1U));
}

double windowRms(const std::vector<float>& signal, unsigned int begin, unsigned int end) {
    double energy = 0.0;
    for (unsigned int frame = begin; frame < end; ++frame) {
        const double sample = signal[frame];
        energy += sample * sample;
    }
    return std::sqrt(energy / static_cast<double>(end - begin));
}

void testSampleClockGateAndBpmFollowing() {
    constexpr unsigned int frames = kSampleRate;
    auto at120 = makeIsolator();
    configureGate(*at120, 120.0f);
    std::vector<float> signal(frames, 0.8f);
    (void)at120->processInPlace(signal.data(), frames, 1U);
    assert(windowRms(signal, 2400U, 4800U) > 0.75); // 50–100 ms: first open interval
    assert(windowRms(signal, 8000U, 10000U) < 0.08); // 167–208 ms: closed interval
    assert(windowRms(signal, 14000U, 16000U) > 0.75); // 292–333 ms: next open interval

    auto at60 = makeIsolator();
    configureGate(*at60, 60.0f);
    std::vector<float> slower(frames, 0.8f);
    (void)at60->processInPlace(slower.data(), frames, 1U);
    assert(windowRms(slower, 8000U, 10000U) > 0.75); // still open at 167–208 ms
    assert(windowRms(slower, 16000U, 18000U) < 0.08); // closed at 333–375 ms
    assert(windowRms(slower, 26000U, 28000U) > 0.75); // opens again after the half-beat period
}

void setSmoothingParameters(NativeEffectProcessor& processor) {
    assert(processor.setParameter("low_crossover_hz", 440.0f, 997U));
    assert(processor.setParameter("high_crossover_hz", 6500.0f, 2003U));
    assert(processor.setParameter("low_gain_db", 9.0f, 1801U));
    assert(processor.setParameter("mid_gain_db", -5.0f, 713U));
    assert(processor.setParameter("high_gain_db", 6.0f, 1109U));
    assert(processor.setParameter("gate_enabled", 1.0f, 1U));
    assert(processor.setParameter("gate_bpm", 97.0f, 877U));
    assert(processor.setParameter("gate_division_beats", 1.0f, 1U));
    assert(processor.setParameter("gate_duty_percent", 41.0f, 709U));
}

void testSmoothingAndVariableBlockSegmentation() {
    constexpr unsigned int frames = 12000U;
    auto contiguous = makeIsolator();
    auto segmented = makeIsolator();
    setSmoothingParameters(*contiguous);
    setSmoothingParameters(*segmented);

    std::vector<float> input(static_cast<std::size_t>(frames) * 2U);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float low = static_cast<float>(0.2 * std::sin(2.0 * kPi * 110.0 * frame / kSampleRate));
        const float high = static_cast<float>(0.15 * std::sin(2.0 * kPi * 6000.0 * frame / kSampleRate));
        input[static_cast<std::size_t>(frame) * 2U] = low + high;
        input[static_cast<std::size_t>(frame) * 2U + 1U] = low - high;
    }
    auto expected = input;
    auto actual = input;
    (void)contiguous->processInPlace(expected.data(), frames, 2U);

    constexpr std::array<unsigned int, 9U> blockPattern{{1U, 7U, 64U, 3U, 127U, 8U, 511U, 29U, 256U}};
    unsigned int processed = 0U;
    std::size_t patternIndex = 0U;
    while (processed < frames) {
        const unsigned int block = std::min(blockPattern[patternIndex % blockPattern.size()], frames - processed);
        (void)segmented->processInPlace(actual.data() + static_cast<std::size_t>(processed) * 2U, block, 2U);
        processed += block;
        ++patternIndex;
    }
    for (std::size_t index = 0U; index < expected.size(); ++index) {
        assert(std::isfinite(actual[index]));
        assert(std::fabs(actual[index] - expected[index]) < 1.0e-6f);
    }
}

void testBandGainSmoothingAndNoCallbackAllocations() {
    constexpr unsigned int frames = 4800U;
    auto processor = makeIsolator();
    assert(processor->setParameter("low_gain_db", 12.0f, frames));
    std::vector<float> signal(frames);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        signal[frame] = static_cast<float>(0.3 * std::sin(2.0 * kPi * 80.0 * frame / kSampleRate));
    }
    webrc::native::test_alloc::beginTracking();
    (void)processor->processInPlace(signal.data(), frames, 1U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == 0U);
    assert(windowRms(signal, 0U, 480U) < windowRms(signal, frames - 480U, frames) * 0.45);
}

} // namespace

int main() {
    testCatalogBoundsAndDiscreteValues();
    testUnityReconstructionAndThreeBandResponse();
    testSampleClockGateAndBpmFollowing();
    testSmoothingAndVariableBlockSegmentation();
    testBandGainSmoothingAndNoCallbackAllocations();
    return 0;
}
