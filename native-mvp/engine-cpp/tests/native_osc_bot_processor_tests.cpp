#include "native_fx_catalog.hpp"
#include "native_osc_bot_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <map>
#include <string_view>

using namespace webrc::native;

namespace {

constexpr unsigned int kSampleRate = 48000U;
constexpr std::size_t kFrames = 8192U;

void testFactoryControlsAndPreparedAudioPath() {
    const auto* descriptor = findNativeEffectDescriptor("osc_bot");
    assert(descriptor != nullptr);
    assert(descriptor->sourceIndex == 22);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    assert(descriptor->name.find("clean-room") != std::string_view::npos);
    assert(findNativeEffectParameter("osc_bot", "bands") != nullptr);
    assert(findNativeEffectParameter("osc_bot", "waveform") != nullptr);
    assert(findNativeEffectParameter("osc_bot", "pattern") != nullptr);
    assert(findNativeEffectParameter("osc_bot", "tone") != nullptr);
    assert(findNativeEffectParameter("osc_bot", "tempo") != nullptr);
    assert(findNativeEffectParameter("osc_bot", "mix") != nullptr);

    auto effect = createNativeEffectProcessor("osc_bot");
    auto* processor = dynamic_cast<NativeOscBotProcessor*>(effect.get());
    assert(processor != nullptr);
    assert(processor->setParameter("bands", 24.0f));
    assert(processor->setParameter("waveform", 2.0f));
    assert(processor->setParameter("pattern", 4.0f));
    assert(processor->setParameter("tone", 6000.0f));
    assert(processor->setParameter("tempo", 95.0f));
    assert(processor->setParameter("mix", 100.0f));
    assert(!processor->setParameter("bands", 7.0f));
    assert(!processor->setParameter("waveform", 3.0f));
    assert(!processor->setParameter("pattern", 8.0f));
    assert(!processor->setParameter("tone", 99.0f));
    assert(!processor->setParameter("tempo", 301.0f));
    assert(!processor->setParameter("mix", 100.1f));
    assert(processor->prepare(kSampleRate));

    std::array<float, kFrames * 2U> samples{};
    for (std::size_t frame = 0U; frame < kFrames; ++frame) {
        const float modulator = 0.35f * std::sin(2.0f * 3.14159265358979323846f * 220.0f *
            static_cast<float>(frame) / static_cast<float>(kSampleRate));
        samples[frame * 2U] = modulator;
        samples[(frame * 2U) + 1U] = modulator;
    }
    const auto dry = samples;
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    const float peak = processor->processInPlace(samples.data(), kFrames, 2U);
    test_alloc::endTracking();
    assert(peak > 1.0e-5f);
    assert(test_alloc::count() == allocationsBefore);
    double difference = 0.0;
    for (std::size_t sample = 0U; sample < samples.size(); ++sample) {
        assert(std::isfinite(samples[sample]));
        difference += std::fabs(static_cast<double>(samples[sample] - dry[sample]));
    }
    assert((difference / static_cast<double>(samples.size())) > 1.0e-5);
}

} // namespace

int main() {
    testFactoryControlsAndPreparedAudioPath();
    return 0;
}
