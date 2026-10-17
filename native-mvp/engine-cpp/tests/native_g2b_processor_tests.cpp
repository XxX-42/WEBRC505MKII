#include "native_fx_catalog.hpp"
#include "native_g2b_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <string_view>
#include <vector>

using namespace webrc::native;

namespace {

constexpr unsigned int kSampleRate = 48000U;
constexpr double kPi = 3.14159265358979323846;

void testCatalogContract() {
    const auto* descriptor = findNativeEffectDescriptor("g2b");
    assert(descriptor != nullptr);
    assert(descriptor->sourceIndex == 10);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    assert(descriptor->name.find("experimental") != std::string_view::npos);
    assert(descriptor->parameterCount == 3U);

    const auto* tracking = findNativeEffectParameter("g2b", "tracking_percent");
    const auto* blend = findNativeEffectParameter("g2b", "blend_percent");
    const auto* body = findNativeEffectParameter("g2b", "body_hz");
    assert(tracking != nullptr && tracking->minimum == 0.0f && tracking->maximum == 100.0f &&
        tracking->defaultValue == 65.0f);
    assert(blend != nullptr && blend->minimum == 0.0f && blend->maximum == 100.0f &&
        blend->defaultValue == 65.0f);
    assert(body != nullptr && body->minimum == 60.0f && body->maximum == 1200.0f &&
        body->defaultValue == 180.0f);

    auto effect = createNativeEffectProcessor("g2b");
    assert(effect != nullptr && effect->stableId() == "g2b");
    assert(effect->prepare(kSampleRate));
    assert(!effect->setParameter("tracking_percent", -0.1f, 1U));
    assert(!effect->setParameter("tracking_percent", 100.1f, 1U));
    assert(!effect->setParameter("blend_percent", 101.0f, 1U));
    assert(!effect->setParameter("body_hz", 59.9f, 1U));
    assert(!effect->setParameter("body_hz", 1200.1f, 1U));
    assert(!effect->setParameter("invented_feature", 1.0f, 1U));
    assert(createNativeEffectProcessor("not_g2b") == nullptr);
    assert(effect->setParameter("tracking_percent", 100.0f, 1U));
    assert(effect->setParameter("blend_percent", 100.0f, 1U));
    assert(effect->setParameter("body_hz", 1200.0f, 1U));

    auto* g2b = dynamic_cast<NativeG2BProcessor*>(effect.get());
    assert(g2b != nullptr);
    assert(g2b->trackingLatencyUpperBoundSamples() == 2432U);
}

double spectralAmplitude(const std::vector<float>& signal, std::size_t start, std::size_t end, double frequency) {
    double cosine = 0.0;
    double sine = 0.0;
    const double step = 2.0 * kPi * frequency / static_cast<double>(kSampleRate);
    for (std::size_t index = start; index < end; ++index) {
        const double phase = step * static_cast<double>(index);
        cosine += static_cast<double>(signal[index]) * std::cos(phase);
        sine += static_cast<double>(signal[index]) * std::sin(phase);
    }
    return 2.0 * std::sqrt((cosine * cosine) + (sine * sine)) /
        static_cast<double>(end - start);
}

std::vector<float> processTone(float bodyCutoff, float blend) {
    auto processor = createNativeEffectProcessor("g2b");
    assert(processor != nullptr && processor->prepare(kSampleRate));
    assert(processor->setParameter("tracking_percent", 100.0f, 1U));
    assert(processor->setParameter("blend_percent", blend, 1U));
    assert(processor->setParameter("body_hz", bodyCutoff, 1U));
    std::vector<float> input(kSampleRate);
    std::vector<float> original(kSampleRate);
    for (std::size_t index = 0U; index < input.size(); ++index) {
        input[index] = 0.5f * static_cast<float>(std::sin(2.0 * kPi * 220.0 *
            static_cast<double>(index) / static_cast<double>(kSampleRate)));
    }
    original = input;
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    assert(processor->processInPlace(input.data(), static_cast<unsigned int>(input.size()), 1U) > 0.0f);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
    if (blend == 0.0f) {
        assert(input == original);
    }
    return input;
}

void testOctaveDownResynthesisAndBlend() {
    const auto wet = processTone(1200.0f, 100.0f);
    const auto darkBody = processTone(60.0f, 100.0f);
    const auto dry = processTone(1200.0f, 0.0f);
    constexpr std::size_t start = 12000U;
    constexpr std::size_t end = 48000U;
    const double subFundamental = spectralAmplitude(wet, start, end, 110.0);
    const double originalFundamental = spectralAmplitude(wet, start, end, 220.0);
    assert(subFundamental > 0.025);
    assert(subFundamental > originalFundamental * 4.0);
    assert(spectralAmplitude(dry, start, end, 220.0) > 0.40);
    assert(spectralAmplitude(wet, start, end, 330.0) >
        spectralAmplitude(darkBody, start, end, 330.0) * 1.5);
}

void testTrackingThresholdAndMeasuredStartupLatency() {
    auto makeLowLevel = [](float tracking) {
        auto processor = createNativeEffectProcessor("g2b");
        assert(processor != nullptr && processor->prepare(kSampleRate));
        assert(processor->setParameter("tracking_percent", tracking, 1U));
        assert(processor->setParameter("blend_percent", 100.0f, 1U));
        assert(processor->setParameter("body_hz", 1200.0f, 1U));
        std::vector<float> signal(kSampleRate);
        for (std::size_t index = 0U; index < signal.size(); ++index) {
            signal[index] = 0.01f * static_cast<float>(std::sin(2.0 * kPi * 220.0 *
                static_cast<double>(index) / static_cast<double>(kSampleRate)));
        }
        (void)processor->processInPlace(signal.data(), static_cast<unsigned int>(signal.size()), 1U);
        return signal;
    };

    const auto lowTracking = makeLowLevel(0.0f);
    const auto highTracking = makeLowLevel(100.0f);
    const double lowTrackingWet = spectralAmplitude(lowTracking, 12000U, 48000U, 110.0);
    const double highTrackingWet = spectralAmplitude(highTracking, 12000U, 48000U, 110.0);
    assert(highTrackingWet > lowTrackingWet + 0.001);

    auto processor = createNativeEffectProcessor("g2b");
    assert(processor != nullptr && processor->prepare(kSampleRate));
    assert(processor->setParameter("tracking_percent", 100.0f, 1U));
    assert(processor->setParameter("blend_percent", 100.0f, 1U));
    assert(processor->setParameter("body_hz", 1200.0f, 1U));
    constexpr unsigned int frames = 3000U;
    std::array<float, frames> output{};
    unsigned int firstWet = 0U;
    bool found = false;
    for (unsigned int sample = 0U; sample < frames; ++sample) {
        output[sample] = 0.5f * static_cast<float>(std::sin(2.0 * kPi * 220.0 *
            static_cast<double>(sample) / static_cast<double>(kSampleRate)));
        (void)processor->processInPlace(&output[sample], 1U, 1U);
        if (!found && std::fabs(output[sample]) > 0.001f) {
            firstWet = sample;
            found = true;
        }
    }
    assert(found);
    // Measured with a 0.5-amplitude 220 Hz sine at 48 kHz: the wet onset is
    // gated until the first 512+96 tracker samples arrive, plus the short
    // input-gate acquisition and TPT filter rise.
    assert(firstWet >= 2400U && firstWet < 2600U);
    std::cout << "G2B measured startup to first wet sample: " << firstWet
              << " samples (" << (1000.0 * static_cast<double>(firstWet) / kSampleRate)
              << " ms at 48 kHz); reported tracker window+hop: 2432 samples\n";
}

} // namespace

int main() {
    testCatalogContract();
    testOctaveDownResynthesisAndBlend();
    testTrackingThresholdAndMeasuredStartupLatency();
    std::cout << "Native G2B provisional processor tests passed\n";
}
