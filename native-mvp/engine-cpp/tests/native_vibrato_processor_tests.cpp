#include "native_fx_catalog.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string_view>
#include <vector>

using namespace webrc::native;

namespace {

void expectNear(float actual, float expected, float tolerance = 1.0e-6f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

void setDefaultVibrato(NativeEffectProcessor& processor, std::uint64_t rampFrames = 1U) {
    assert(processor.setParameter("rate_hz", 5.0f, rampFrames));
    assert(processor.setParameter("depth", 35.0f, rampFrames));
    assert(processor.setParameter("delay_ms", 2.0f, rampFrames));
    assert(processor.setParameter("mix_percent", 100.0f, rampFrames));
}

void testCatalogAndParameterBounds() {
    const auto* descriptor = findNativeEffectDescriptor("vibrato");
    assert(descriptor != nullptr && descriptor->sourceIndex == 33);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    assert(descriptor->parameterCount == 4U);

    const auto* rate = findNativeEffectParameter("vibrato", "rate_hz");
    const auto* depth = findNativeEffectParameter("vibrato", "depth");
    const auto* delay = findNativeEffectParameter("vibrato", "delay_ms");
    const auto* mix = findNativeEffectParameter("vibrato", "mix_percent");
    assert(rate != nullptr && rate->minimum == 0.05f && rate->maximum == 20.0f && rate->defaultValue == 5.0f);
    assert(depth != nullptr && depth->minimum == 0.0f && depth->maximum == 100.0f && depth->defaultValue == 35.0f);
    assert(delay != nullptr && delay->minimum == 0.2f && delay->maximum == 10.0f && delay->defaultValue == 2.0f);
    assert(mix != nullptr && mix->minimum == 0.0f && mix->maximum == 100.0f && mix->defaultValue == 100.0f);

    auto processor = createNativeEffectProcessor("vibrato");
    assert(processor != nullptr && processor->stableId() == "vibrato");
    assert(processor->prepare(48000U));
    assert(!processor->setParameter("rate_hz", 0.049f));
    assert(!processor->setParameter("rate_hz", 20.01f));
    assert(!processor->setParameter("rate_hz", std::numeric_limits<float>::quiet_NaN()));
    assert(!processor->setParameter("depth", -0.01f));
    assert(!processor->setParameter("depth", 100.01f));
    assert(!processor->setParameter("delay_ms", 0.19f));
    assert(!processor->setParameter("delay_ms", 10.01f));
    assert(!processor->setParameter("mix_percent", -0.01f));
    assert(!processor->setParameter("mix_percent", 100.01f));
    assert(!processor->setParameter("unlisted", 1.0f));
    assert(processor->setParameter("rate_hz", 0.05f, 1U));
    assert(processor->setParameter("rate_hz", 20.0f, 1U));
    assert(processor->setParameter("depth", 100.0f, 1U));
    assert(processor->setParameter("delay_ms", 10.0f, 1U));
    assert(processor->setParameter("mix_percent", 0.0f, 1U));
}

void testFractionalDelayAndDryWetEndpoints() {
    auto processor = createNativeEffectProcessor("vibrato");
    assert(processor != nullptr && processor->prepare(48000U));
    assert(processor->setParameter("rate_hz", 5.0f, 1U));
    assert(processor->setParameter("depth", 0.0f, 1U));
    assert(processor->setParameter("delay_ms", 2.0f, 1U));
    assert(processor->setParameter("mix_percent", 100.0f, 1U));

    constexpr unsigned int frames = 256U;
    std::array<float, frames * 2U> impulse{};
    impulse[0] = 1.0f;
    impulse[1] = -0.5f;
    assert(std::fabs(processor->processInPlace(impulse.data(), frames, 2U)) > 0.0f);
    // 2ms at 48kHz is exactly 96 frames; the interpolation is unity at that
    // fractional-delay tap and produces neither direct nor wrong-time output.
    expectNear(impulse[96U * 2U], 1.0f);
    expectNear(impulse[96U * 2U + 1U], -0.5f);
    expectNear(impulse[0], 0.0f);
    expectNear(impulse[1], 0.0f);

    auto fractional = createNativeEffectProcessor("vibrato");
    assert(fractional != nullptr && fractional->prepare(48000U));
    assert(fractional->setParameter("rate_hz", 5.0f, 1U));
    assert(fractional->setParameter("depth", 0.0f, 1U));
    assert(fractional->setParameter("delay_ms", 2.01f, 1U));
    assert(fractional->setParameter("mix_percent", 100.0f, 1U));
    std::array<float, frames * 2U> fractionalImpulse{};
    fractionalImpulse[0] = 1.0f;
    (void)fractional->processInPlace(fractionalImpulse.data(), frames, 2U);
    assert(std::fabs(fractionalImpulse[96U * 2U]) > 0.1f);
    assert(std::fabs(fractionalImpulse[97U * 2U]) > 0.1f);
    assert(fractionalImpulse[96U * 2U] != fractionalImpulse[97U * 2U]);

    assert(processor->setParameter("mix_percent", 0.0f, 1U));
    processor->resetState();
    std::array<float, 32U> dry{};
    for (std::size_t index = 0U; index < dry.size(); ++index) {
        dry[index] = static_cast<float>(static_cast<int>(index) - 11) * 0.03125f;
    }
    const auto original = dry;
    (void)processor->processInPlace(dry.data(), 16U, 2U);
    for (std::size_t index = 0U; index < dry.size(); ++index) expectNear(dry[index], original[index]);
}

void testModulationChangesTheSignalAndRemainsBounded() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = sampleRate;
    auto fixed = createNativeEffectProcessor("vibrato");
    auto modulated = createNativeEffectProcessor("vibrato");
    assert(fixed != nullptr && modulated != nullptr);
    assert(fixed->prepare(sampleRate) && modulated->prepare(sampleRate));
    for (NativeEffectProcessor* processor : {fixed.get(), modulated.get()}) {
        assert(processor->setParameter("rate_hz", 5.0f, 1U));
        assert(processor->setParameter("delay_ms", 5.0f, 1U));
        assert(processor->setParameter("mix_percent", 100.0f, 1U));
    }
    assert(fixed->setParameter("depth", 0.0f, 1U));
    assert(modulated->setParameter("depth", 100.0f, 1U));

    std::vector<float> fixedSignal(frames * 2U);
    std::vector<float> modulatedSignal(frames * 2U);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float sample = 0.35f * static_cast<float>(std::sin(6.28318530717958647692 * 440.0 * frame / sampleRate));
        fixedSignal[frame * 2U] = sample;
        fixedSignal[frame * 2U + 1U] = sample * 0.7f;
    }
    modulatedSignal = fixedSignal;
    (void)fixed->processInPlace(fixedSignal.data(), frames, 2U);
    (void)modulated->processInPlace(modulatedSignal.data(), frames, 2U);

    double differenceEnergy = 0.0;
    double signalEnergy = 0.0;
    float peak = 0.0f;
    for (std::size_t index = 2000U; index < modulatedSignal.size(); ++index) {
        const float sample = modulatedSignal[index];
        assert(std::isfinite(sample));
        peak = std::max(peak, std::fabs(sample));
        const double difference = static_cast<double>(sample) - static_cast<double>(fixedSignal[index]);
        differenceEnergy += difference * difference;
        signalEnergy += static_cast<double>(sample) * static_cast<double>(sample);
    }
    assert(differenceEnergy > signalEnergy * 0.02);
    assert(peak < 0.75f);

    auto stressed = createNativeEffectProcessor("vibrato");
    assert(stressed != nullptr && stressed->prepare(192000U));
    assert(stressed->setParameter("rate_hz", 20.0f, 1U));
    assert(stressed->setParameter("depth", 100.0f, 1U));
    assert(stressed->setParameter("delay_ms", 10.0f, 1U));
    assert(stressed->setParameter("mix_percent", 100.0f, 1U));
    std::array<float, 2048U> stressBlock{};
    for (std::size_t index = 0U; index < stressBlock.size(); ++index) {
        stressBlock[index] = 0.5f * static_cast<float>(std::sin(6.28318530717958647692 * 233.0 * index / 192000.0));
    }
    for (unsigned int iteration = 0U; iteration < 400U; ++iteration) {
        (void)stressed->processInPlace(stressBlock.data(), 1024U, 2U);
        for (const float sample : stressBlock) {
            assert(std::isfinite(sample));
            assert(std::fabs(sample) < 1.0f);
        }
    }
}

void testChunkEquivalenceAndAllocationFreeProcessing() {
    constexpr unsigned int frames = 8192U;
    auto singleBlock = createNativeEffectProcessor("vibrato");
    auto chunked = createNativeEffectProcessor("vibrato");
    assert(singleBlock != nullptr && chunked != nullptr);
    assert(singleBlock->prepare(96000U) && chunked->prepare(96000U));
    for (NativeEffectProcessor* processor : {singleBlock.get(), chunked.get()}) {
        assert(processor->setParameter("rate_hz", 7.25f, 1800U));
        assert(processor->setParameter("depth", 87.0f, 1800U));
        assert(processor->setParameter("delay_ms", 4.25f, 1800U));
        assert(processor->setParameter("mix_percent", 73.0f, 1800U));
    }

    std::vector<float> input(frames * 2U);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float sample = 0.2f * static_cast<float>(std::sin(0.013 * frame)) +
            0.08f * static_cast<float>(std::cos(0.071 * frame));
        input[frame * 2U] = sample;
        input[frame * 2U + 1U] = -sample * 0.73f;
    }
    std::vector<float> reference = input;
    std::vector<float> split = input;
    (void)singleBlock->processInPlace(reference.data(), frames, 2U);
    constexpr std::array<unsigned int, 7U> chunks{{64U, 1U, 127U, 509U, 3U, 1000U, 257U}};
    unsigned int offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const unsigned int count = std::min(chunks[chunkIndex % chunks.size()], frames - offset);
        (void)chunked->processInPlace(split.data() + (static_cast<std::size_t>(offset) * 2U), count, 2U);
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t index = 0U; index < reference.size(); ++index) expectNear(split[index], reference[index], 1.0e-7f);

    std::array<float, 128U> callbackBlock{};
    auto noAllocation = createNativeEffectProcessor("vibrato");
    assert(noAllocation != nullptr && noAllocation->prepare(48000U));
    setDefaultVibrato(*noAllocation, 64U);
    for (std::size_t index = 0U; index < callbackBlock.size(); ++index) {
        callbackBlock[index] = 0.15f * static_cast<float>(std::sin(0.11 * index));
    }
    const std::size_t allocationBaseline = test_alloc::count();
    test_alloc::beginTracking();
    for (unsigned int iteration = 0U; iteration < 64U; ++iteration) {
        (void)noAllocation->processInPlace(callbackBlock.data(), 64U, 2U);
    }
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationBaseline);
}

} // namespace

int main() {
    testCatalogAndParameterBounds();
    testFractionalDelayAndDryWetEndpoints();
    testModulationChangesTheSignalAndRemainsBounded();
    testChunkEquivalenceAndAllocationFreeProcessing();
    return 0;
}
