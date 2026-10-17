#include "native_fx_catalog.hpp"
#include "native_osc_voc_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <map>

using namespace webrc::native;

namespace {

constexpr unsigned int kSampleRate = 48000U;

void testFactoryParametersAndSampleClockedEvents() {
    std::size_t catalogCount = 0U;
    const auto* catalog = nativeEffectCatalog(catalogCount);
    assert(catalog != nullptr && catalogCount > 0U);
    const auto* descriptor = findNativeEffectDescriptor("osc_voc_m");
    assert(descriptor != nullptr && descriptor->sourceIndex == 21);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    assert(findNativeEffectParameter("osc_voc_m", "waveform") != nullptr);
    assert(findNativeEffectParameter("osc_voc_m", "midi-channel") != nullptr);
    assert(findNativeEffectParameter("osc_voc_m", "octave") != nullptr);
    assert(findNativeEffectParameter("osc_voc_m", "mix") != nullptr);

    auto effect = createNativeEffectProcessor("osc_voc_m");
    auto* processor = dynamic_cast<NativeOscVocProcessor*>(effect.get());
    assert(processor != nullptr);
    assert(processor->setParameter("midi-channel", 2.0f));
    assert(processor->setParameter("octave", 12.0f));
    assert(processor->setParameter("waveform", 2.0f));
    assert(processor->setParameter("mix", 100.0f));
    assert(processor->prepare(kSampleRate));
    assert(processor->queueNoteOn(1, 69, 127, 0U));
    assert(processor->queueNoteOff(1, 69, 256U));
    assert(!processor->queueNoteOn(0, 69, 127, 0U));
    assert(processor->rejectedEventCount() == 1U);

    constexpr unsigned int frames = 512U;
    std::array<float, frames * 2U> samples{};
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float sample = 0.35f * std::sin(2.0f * 3.14159265358979323846f * 220.0f *
            static_cast<float>(frame) / static_cast<float>(kSampleRate));
        samples[frame * 2U] = sample;
        samples[frame * 2U + 1U] = -sample * 0.6f;
    }
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    assert(processor->processInPlace(samples.data(), frames, 2U) > 0.0f);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
    assert(processor->currentFrame() == frames);
    assert(processor->queuedEventCount() == 0U);
    assert(!processor->queueNoteOff(1, 69, frames - 1U));
    assert(processor->lateEventCount() == 1U);
}

void testFixedQueueOverflowIsCounted() {
    auto effect = createNativeEffectProcessor("osc_voc_m");
    auto* processor = dynamic_cast<NativeOscVocProcessor*>(effect.get());
    assert(processor != nullptr && processor->prepare(kSampleRate));
    for (std::size_t index = 0U; index < kNativeOscVocEventQueueCapacity; ++index) {
        assert(processor->queueNoteOn(0, 60, 100, static_cast<std::uint64_t>(index)));
    }
    assert(processor->queuedEventCount() == kNativeOscVocEventQueueCapacity);
    assert(!processor->queueNoteOn(0, 60, 100,
        static_cast<std::uint64_t>(kNativeOscVocEventQueueCapacity)));
    assert(processor->overflowEventCount() == 1U);
}

void testConfiguredBeforePrepareSurvivesPrepare() {
    auto effect = createNativeEffectProcessor("osc_voc_m");
    auto* processor = dynamic_cast<NativeOscVocProcessor*>(effect.get());
    assert(processor != nullptr);
    assert(processor->setParameter("mix", 0.0f));
    assert(processor->prepare(kSampleRate));
    std::array<float, 256U * 2U> samples{};
    for (std::size_t frame = 0U; frame < 256U; ++frame) {
        const float value = static_cast<float>(frame) * 0.001f;
        samples[frame * 2U] = value;
        samples[frame * 2U + 1U] = -value;
    }
    const auto dry = samples;
    (void)processor->processInPlace(samples.data(), 256U, 2U);
    for (std::size_t sample = 0U; sample < samples.size(); ++sample) {
        assert(std::fabs(samples[sample] - dry[sample]) < 1.0e-6f);
    }
}

} // namespace

int main() {
    testFactoryParametersAndSampleClockedEvents();
    testFixedQueueOverflowIsCounted();
    testConfiguredBeforePrepareSurvivesPrepare();
    return 0;
}
