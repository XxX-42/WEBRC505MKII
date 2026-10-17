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

void expectNear(float actual, float expected, float tolerance = 1.0e-5f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

std::unique_ptr<NativeEffectProcessor> makePrepared(unsigned int sampleRate) {
    auto processor = createNativeEffectProcessor("slow_gear");
    assert(processor != nullptr);
    assert(processor->stableId() == "slow_gear");
    assert(processor->prepare(sampleRate));
    return processor;
}

void testCatalogFactoryAndParameterBounds() {
    std::size_t count = 0U;
    const auto* catalog = nativeEffectCatalog(count);
    // The catalog grows as additional independently implemented effects land.
    // Keep this processor test focused on its own descriptor rather than a
    // brittle suite-wide exact count.
    assert(catalog != nullptr && count >= 27U);
    const auto* descriptor = findNativeEffectDescriptor("slow_gear");
    assert(descriptor != nullptr && descriptor->sourceIndex == 13);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    assert(createNativeEffectProcessor("slow_gear") != nullptr);
    assert(createNativeEffectProcessor("slow-gear") == nullptr);

    const auto* attack = findNativeEffectParameter("slow_gear", "attack_ms");
    const auto* sensitivity = findNativeEffectParameter("slow_gear", "sensitivity_percent");
    const auto* mix = findNativeEffectParameter("slow_gear", "mix_percent");
    assert(attack != nullptr && attack->minimum == 5.0f && attack->maximum == 2000.0f && attack->defaultValue == 250.0f);
    assert(sensitivity != nullptr && sensitivity->minimum == 0.0f && sensitivity->maximum == 100.0f &&
           sensitivity->defaultValue == 50.0f);
    assert(mix != nullptr && mix->minimum == 0.0f && mix->maximum == 100.0f && mix->defaultValue == 100.0f);

    auto processor = makePrepared(48000U);
    assert(!processor->setParameter("attack_ms", 4.99f, 1U));
    assert(!processor->setParameter("attack_ms", 2000.01f, 1U));
    assert(!processor->setParameter("attack_ms", std::numeric_limits<float>::quiet_NaN(), 1U));
    assert(!processor->setParameter("sensitivity_percent", -0.01f, 1U));
    assert(!processor->setParameter("sensitivity_percent", 100.01f, 1U));
    assert(!processor->setParameter("mix_percent", -1.0f, 1U));
    assert(!processor->setParameter("mix_percent", std::numeric_limits<float>::infinity(), 1U));
    assert(!processor->setParameter("unknown", 1.0f, 1U));
    assert(processor->setParameter("attack_ms", 5.0f, 1U));
    assert(processor->setParameter("attack_ms", 2000.0f, 1U));
    assert(processor->setParameter("sensitivity_percent", 0.0f, 1U));
    assert(processor->setParameter("sensitivity_percent", 100.0f, 1U));
    assert(processor->setParameter("mix_percent", 0.0f, 1U));
    assert(processor->setParameter("mix_percent", 100.0f, 1U));
}

void testImmediateTransientAttenuationAndRaisedCosineRamp() {
    constexpr unsigned int sampleRate = 48000U;
    auto processor = makePrepared(sampleRate);
    assert(processor->setParameter("attack_ms", 250.0f, 1U));
    assert(processor->setParameter("sensitivity_percent", 50.0f, 1U));
    assert(processor->setParameter("mix_percent", 100.0f, 1U));

    std::array<float, 2U> firstFrame{{1.0f, -0.5f}};
    (void)processor->processInPlace(firstFrame.data(), 1U, 2U);
    assert(std::fabs(firstFrame[0]) < 0.25f);
    assert(std::fabs(firstFrame[1]) < 0.13f);
    expectNear(firstFrame[1] / firstFrame[0], -0.5f, 1.0e-4f);

    // Constant-level audio keeps the test independent of musical phase while
    // exercising the complete attack interval.
    constexpr unsigned int frames = sampleRate / 4U;
    std::vector<float> sustained(frames, 0.5f);
    (void)processor->processInPlace(sustained.data(), frames, 1U);
    assert(sustained[0] < 0.2f);
    assert(sustained[frames / 2U] > 0.25f);
    assert(sustained[frames - 1U] > 0.49f);

    // A later onset retriggers from the attenuated level after the detector
    // has re-armed in silence.
    std::vector<float> silence(sampleRate / 5U, 0.0f);
    (void)processor->processInPlace(silence.data(), static_cast<unsigned int>(silence.size()), 1U);
    float nextTransient = 1.0f;
    (void)processor->processInPlace(&nextTransient, 1U, 1U);
    assert(nextTransient < 0.25f);

    processor->resetState();
    float afterReset = 1.0f;
    (void)processor->processInPlace(&afterReset, 1U, 1U);
    assert(afterReset < 0.25f);
}

void testSampleRateChangesAndChunkEquivalence() {
    for (const unsigned int sampleRate : {8000U, 44100U, 96000U, 192000U}) {
        auto processor = makePrepared(sampleRate);
        assert(processor->setParameter("attack_ms", 5.0f, 1U));
        float impulse = 0.75f;
        (void)processor->processInPlace(&impulse, 1U, 1U);
        assert(std::isfinite(impulse) && impulse >= 0.0f && impulse < 0.3f);
    }

    auto changedRate = makePrepared(48000U);
    float firstImpulse = 0.5f;
    (void)changedRate->processInPlace(&firstImpulse, 1U, 1U);
    assert(changedRate->prepare(96000U));
    assert(changedRate->sampleRate() == 96000U);
    float afterRateChange = 0.5f;
    (void)changedRate->processInPlace(&afterRateChange, 1U, 1U);
    assert(afterRateChange < 0.2f);

    auto wholeProcessor = makePrepared(48000U);
    auto chunkedProcessor = makePrepared(48000U);
    for (auto* processor : {wholeProcessor.get(), chunkedProcessor.get()}) {
        assert(processor->setParameter("attack_ms", 90.0f, 1U));
        assert(processor->setParameter("sensitivity_percent", 63.0f, 1U));
        assert(processor->setParameter("mix_percent", 87.0f, 1U));
    }
    constexpr std::size_t frames = 12000U;
    std::vector<float> input(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const float signal = frame < 6000U
            ? static_cast<float>(0.35 * std::sin(static_cast<double>(frame) * 0.051))
            : (frame < 6001U ? 0.9f : static_cast<float>(0.2 * std::sin(static_cast<double>(frame) * 0.017)));
        input[frame * 2U] = signal;
        input[(frame * 2U) + 1U] = -0.7f * signal;
    }
    auto whole = input;
    auto chunked = input;
    (void)wholeProcessor->processInPlace(whole.data(), static_cast<unsigned int>(frames), 2U);
    constexpr std::array<unsigned int, 7U> chunks{{1U, 63U, 64U, 127U, 255U, 511U, 1024U}};
    std::size_t offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const auto size = static_cast<unsigned int>(std::min<std::size_t>(chunks[chunkIndex % chunks.size()], frames - offset));
        (void)chunkedProcessor->processInPlace(chunked.data() + offset * 2U, size, 2U);
        offset += size;
        ++chunkIndex;
    }
    for (std::size_t index = 0U; index < whole.size(); ++index) {
        expectNear(chunked[index], whole[index], 1.0e-6f);
    }
}

void testSensitivityAndEffectMixControls() {
    auto lowSensitivity = makePrepared(48000U);
    auto highSensitivity = makePrepared(48000U);
    assert(lowSensitivity->setParameter("sensitivity_percent", 0.0f, 1U));
    assert(highSensitivity->setParameter("sensitivity_percent", 100.0f, 1U));
    float quietOnsetLow = 0.02f;
    float quietOnsetHigh = 0.02f;
    (void)lowSensitivity->processInPlace(&quietOnsetLow, 1U, 1U);
    (void)highSensitivity->processInPlace(&quietOnsetHigh, 1U, 1U);
    expectNear(quietOnsetLow, 0.02f);
    assert(quietOnsetHigh < 0.01f);

    auto dryMix = makePrepared(48000U);
    assert(dryMix->setParameter("mix_percent", 0.0f, 1U));
    float transient = 0.75f;
    (void)dryMix->processInPlace(&transient, 1U, 1U);
    expectNear(transient, 0.75f);
}

void testCallbackProcessingDoesNotAllocate() {
    auto processor = makePrepared(48000U);
    constexpr unsigned int frames = 512U;
    std::vector<float> audio(frames * 2U, 0.3f);
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)processor->processInPlace(audio.data(), frames, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
    for (float sample : audio) assert(std::isfinite(sample) && std::fabs(sample) <= 8.0f);
}

} // namespace

int main() {
    testCatalogFactoryAndParameterBounds();
    testImmediateTransientAttenuationAndRaisedCosineRamp();
    testSampleRateChangesAndChunkEquivalence();
    testSensitivityAndEffectMixControls();
    testCallbackProcessingDoesNotAllocate();
}
