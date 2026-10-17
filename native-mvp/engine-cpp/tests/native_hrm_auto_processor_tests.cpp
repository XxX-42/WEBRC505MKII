#include "native_fx_catalog.hpp"
#include "native_hrm_auto_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <memory>

using namespace webrc::native;

namespace {
constexpr unsigned int kSampleRate = 48000U;

void testCatalogAndQueuedMidiClock() {
    const auto* descriptor = findNativeEffectDescriptor("hrm_auto_m");
    assert(descriptor != nullptr);
    assert(descriptor->sourceIndex == 19);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    const auto* key = findNativeEffectParameter("hrm_auto_m", "key");
    const auto* scale = findNativeEffectParameter("hrm_auto_m", "scale");
    const auto* channel = findNativeEffectParameter("hrm_auto_m", "midi-channel");
    const auto* mix = findNativeEffectParameter("hrm_auto_m", "mix_percent");
    assert(key && key->minimum == 0.0f && key->maximum == 11.0f && key->discrete);
    assert(scale && scale->minimum == 0.0f && scale->maximum == 4.0f && scale->discrete);
    assert(channel && channel->minimum == 1.0f && channel->maximum == 16.0f && channel->discrete);
    assert(mix && mix->minimum == 0.0f && mix->maximum == 100.0f && mix->defaultValue == 70.0f);

    auto effect = createNativeEffectProcessor("hrm_auto_m");
    auto* processor = dynamic_cast<NativeHrmAutoProcessor*>(effect.get());
    assert(processor != nullptr);
    assert(NativeHrmAutoProcessor::eventQueueCapacity() == NativeHrmAutoCore::kMidiQueueCapacity);
    assert(processor->setParameter("key", 7.0f));
    assert(processor->setParameter("scale", 2.0f));
    assert(processor->setParameter("midi-channel", 3.0f));
    assert(!processor->setParameter("scale", 2.5f));
    assert(!processor->setParameter("key", 12.0f));
    assert(processor->prepare(kSampleRate));
    assert(processor->reportedLatencySamples() == NativeHrmAutoCore::calculateLatencyFrames(kSampleRate));

    assert(!processor->queueMidiEvent(true, 2, 60, 100, 0U));
    assert(!processor->queueMidiEvent(true, 3, 128, 100, 0U));
    assert(processor->rejectedEventCount() == 2U);
    assert(processor->queueMidiEvent(true, 3, 60, 100, 10U));
    assert(processor->queueMidiEvent(false, 3, 60, 0, 256U));
    assert(processor->queuedEventCount() == 2U);

    std::array<float, 512U * 2U> samples{};
    for (unsigned int i = 0U; i < 512U; ++i) {
        const float value = 0.2f * std::sin(2.0f * 3.14159265358979323846f * 220.0f *
            static_cast<float>(i) / static_cast<float>(kSampleRate));
        samples[2U * i] = value;
        samples[2U * i + 1U] = value * 0.8f;
    }
    const std::size_t allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)processor->processInPlace(samples.data(), 128U, 2U);
    (void)processor->processInPlace(samples.data() + 128U * 2U, 128U, 2U);
    (void)processor->processInPlace(samples.data() + 256U * 2U, 256U, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
    assert(processor->currentFrame() == 512U);
    assert(processor->queuedEventCount() == 0U);
    for (float sample : samples) assert(std::isfinite(sample));

    assert(!processor->queueMidiEvent(false, 3, 60, 0, 511U));
    assert(processor->lateEventCount() == 0U);
    processor->recordLateEvent();
    processor->recordRejectedEvent();
    assert(processor->lateEventCount() == 1U);
    assert(processor->rejectedEventCount() == 4U);
}

void testQueueOverflowAndMonoSegmentation() {
    auto effect = createNativeEffectProcessor("hrm_auto_m");
    auto* processor = dynamic_cast<NativeHrmAutoProcessor*>(effect.get());
    assert(processor && processor->prepare(kSampleRate));
    for (unsigned int i = 0U; i < NativeHrmAutoCore::kMidiQueueCapacity; ++i) {
        assert(processor->queueMidiEvent(true, 1, 60, 100, 10000U + i));
    }
    assert(processor->queuedEventCount() == NativeHrmAutoCore::kMidiQueueCapacity);
    assert(!processor->queueMidiEvent(true, 1, 60, 100, 20000U));
    assert(processor->overflowEventCount() == 1U);

    // Reset clears MIDI state and exercises the one-channel adapter over a host
    // block larger than the processor's fixed internal segment bound.
    processor->resetState();
    constexpr unsigned int frames = 5000U;
    std::array<float, frames> mono{};
    for (unsigned int i = 0U; i < frames; ++i) {
        mono[i] = 0.1f * std::sin(2.0f * 3.14159265358979323846f * 330.0f *
                                  static_cast<float>(i) / static_cast<float>(kSampleRate));
    }
    const std::size_t allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    const float peak = processor->processInPlace(mono.data(), frames, 1U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
    assert(peak > 0.0f && std::isfinite(peak));
    assert(processor->currentFrame() == frames);
    for (float sample : mono) assert(std::isfinite(sample));
}

void testBaseMixAlignmentAndFailClosed() {
    auto effect = createNativeEffectProcessor("hrm_auto_m");
    auto* processor = dynamic_cast<NativeHrmAutoProcessor*>(effect.get());
    assert(processor && processor->setParameter("mix_percent", 0.0f, 1U));
    assert(processor->prepare(kSampleRate));
    constexpr unsigned int frames = 1024U;
    std::array<float, frames> samples{};
    for (unsigned int i = 0U; i < frames; ++i) samples[i] = static_cast<float>(i) / 2048.0f;
    const auto original = samples;
    const unsigned int latency = processor->reportedLatencySamples();
    (void)processor->processInPlace(samples.data(), frames, 1U);
    for (unsigned int i = 0U; i < frames; ++i) {
        const float expected = i >= latency ? original[i - latency] : 0.0f;
        assert(std::fabs(samples[i] - expected) < 1.0e-5f);
    }

    auto stereoEffect = createNativeEffectProcessor("hrm_auto_m");
    auto* stereo = dynamic_cast<NativeHrmAutoProcessor*>(stereoEffect.get());
    assert(stereo && stereo->prepare(kSampleRate));
    std::array<float, 64U * 3U> threeChannel{};
    for (unsigned int i = 0U; i < 64U; ++i) {
        threeChannel[3U * i] = 0.1f;
        threeChannel[3U * i + 1U] = -0.1f;
        threeChannel[3U * i + 2U] = 0.75f;
    }
    (void)stereo->processInPlace(threeChannel.data(), 64U, 3U);
    assert(stereo->processingFaulted());
    for (unsigned int i = 0U; i < 64U; ++i) {
        assert(threeChannel[3U * i + 2U] == 0.75f);
        assert(std::isfinite(threeChannel[3U * i]));
        assert(std::isfinite(threeChannel[3U * i + 1U]));
    }
}
} // namespace

int main() {
    testCatalogAndQueuedMidiClock();
    testQueueOverflowAndMonoSegmentation();
    testBaseMixAlignmentAndFailClosed();
    return 0;
}
