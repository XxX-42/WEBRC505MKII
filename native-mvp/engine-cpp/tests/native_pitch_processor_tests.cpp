#include "native_pitch_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

using namespace webrc::native;

namespace {

constexpr double kPi = 3.14159265358979323846;

void expectNear(float actual, float expected, float tolerance = 1.0e-5f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

void runInBlocks(NativePitchProcessor& processor, std::vector<float>& samples, unsigned int blockFrames) {
    std::size_t offset = 0U;
    while (offset < samples.size()) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(blockFrames, samples.size() - offset));
        assert(processor.processInPlace(samples.data() + offset, count));
        offset += count;
    }
}

double estimateByPositiveCrossings(const std::vector<float>& samples, std::size_t begin, std::size_t end, unsigned int sampleRate) {
    assert(end > begin + 1U);
    std::size_t crossings = 0U;
    for (std::size_t i = begin + 1U; i < end; ++i) {
        if (samples[i - 1U] <= 0.0f && samples[i] > 0.0f) ++crossings;
    }
    return static_cast<double>(crossings) * static_cast<double>(sampleRate) / static_cast<double>(end - begin);
}

void testPrepareLatencyAndConfigurationValidation() {
    NativePitchProcessor processor;
    assert(!processor.prepare(0U));
    assert(!processor.prepare(48000U, 70.0f, 1200.0f, 12.1f));
    assert(!processor.prepare(48000U, 70.0f, 1200.0f, std::nanf("")));
    assert(!processor.prepare(48000U, 70.0f, 7000.0f));
    assert(!processor.prepare(48000U, 70.0f, 1200.0f, 0.0f, 0.009f));
    assert(!processor.prepare(48000U, 70.0f, 1200.0f, 0.0f, 1.01f));
    assert(processor.prepare(48000U, 70.0f, 1200.0f, 0.0f));
    assert(processor.prepared());
    assert(processor.sampleRate() == 48000U);
    assert(processor.latencySamples() == NativePitchProcessor::calculateLatencySamples(48000U, 70.0f));
    assert(processor.latencySamples() > 0U);
    assert(processor.status().latencySamples == processor.latencySamples());
    assert(processor.status().sampleRate == 48000U);
    assert(!processor.setSemitones(-12.01f));
    assert(processor.setSemitones(-12.0f));
    expectNear(processor.semitones(), -12.0f);
    assert(NativePitchProcessor::calculateLatencySamples(4000U, 70.0f) == 0U);
    assert(NativePitchProcessor::calculateLatencySamples(48000U, 0.0f) == 0U);
}

void testLatencyAccountingAcrossSupportedRates() {
    for (const unsigned int rate : {8000U, 22050U, 44100U, 48000U, 96000U, 192000U}) {
        NativePitchProcessor processor;
        assert(processor.prepare(rate, 20.0f, 1000.0f, 0.0f));
        assert(processor.latencySamples() == NativePitchProcessor::calculateLatencySamples(rate, 20.0f));
        assert(processor.latencySamples() > static_cast<unsigned int>(std::ceil(static_cast<double>(rate) / 20.0)));
    }
}

void testFixedDryDelayAndSilenceUnvoicedBehavior() {
    constexpr unsigned int sampleRate = 48000U;
    NativePitchProcessor dry;
    assert(dry.prepare(sampleRate, 70.0f, 1200.0f, 0.0f));
    const auto latency = static_cast<std::size_t>(dry.latencySamples());
    std::vector<float> impulse(latency + 64U, 0.0f);
    impulse[0] = 0.75f;
    runInBlocks(dry, impulse, 64U);
    for (std::size_t i = 0U; i < latency; ++i) expectNear(impulse[i], 0.0f, 0.0f);
    expectNear(impulse[latency], 0.75f, 0.0f);
    for (std::size_t i = latency + 1U; i < impulse.size(); ++i) expectNear(impulse[i], 0.0f, 0.0f);

    NativePitchProcessor silence;
    assert(silence.prepare(sampleRate, 70.0f, 1200.0f, 7.0f));
    std::vector<float> silentInput(static_cast<std::size_t>(silence.latencySamples()) + sampleRate / 3U, 0.0f);
    runInBlocks(silence, silentInput, 64U);
    assert(!silence.voiced());
    expectNear(silence.frequencyHz(), 0.0f);
    for (const float sample : silentInput) expectNear(sample, 0.0f);

    // A steady non-periodic DC input has no YIN minimum and therefore remains
    // on the exact fixed-delay dry path even with a nonzero transpose request.
    NativePitchProcessor unvoiced;
    assert(unvoiced.prepare(sampleRate, 70.0f, 1200.0f, 7.0f));
    const auto unvoicedLatency = static_cast<std::size_t>(unvoiced.latencySamples());
    std::vector<float> constant(unvoicedLatency + sampleRate / 5U, 0.1f);
    runInBlocks(unvoiced, constant, 64U);
    assert(!unvoiced.voiced());
    for (std::size_t i = 0U; i < unvoicedLatency; ++i) expectNear(constant[i], 0.0f, 0.0f);
    for (std::size_t i = unvoicedLatency; i < constant.size(); ++i) expectNear(constant[i], 0.1f, 1.0e-6f);
}

void testYinPsolaTranspositionAndBoundedSignal() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr float sourceFrequency = 220.0f;
    constexpr float semitones = 7.0f;
    NativePitchProcessor processor;
    assert(processor.prepare(sampleRate, 70.0f, 1200.0f, semitones));
    const std::size_t totalFrames = static_cast<std::size_t>(sampleRate) * 3U / 2U;
    std::vector<float> signal(totalFrames);
    for (std::size_t frame = 0U; frame < signal.size(); ++frame) {
        const double phase = 2.0 * kPi * static_cast<double>(sourceFrequency) * static_cast<double>(frame) / sampleRate;
        signal[frame] = static_cast<float>(0.35 * std::sin(phase));
    }
    runInBlocks(processor, signal, 64U);
    assert(processor.voiced());
    assert(processor.frequencyHz() > 205.0f && processor.frequencyHz() < 235.0f);

    const auto latency = static_cast<std::size_t>(processor.latencySamples());
    const std::size_t begin = std::max<std::size_t>(latency + sampleRate / 4U, sampleRate / 3U);
    const std::size_t end = std::min(signal.size(), begin + sampleRate / 2U);
    const double observedHz = estimateByPositiveCrossings(signal, begin, end, sampleRate);
    const double targetHz = static_cast<double>(sourceFrequency) * std::pow(2.0, static_cast<double>(semitones) / 12.0);
    assert(observedHz > targetHz * 0.90 && observedHz < targetHz * 1.10);
    for (const float sample : signal) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) < 1.5f);
    }
}

void testAllocationFree64FrameCallsAndBlockSegmentation() {
    constexpr unsigned int sampleRate = 48000U;
    NativePitchProcessor sixtyFour;
    NativePitchProcessor irregular;
    assert(sixtyFour.prepare(sampleRate, 70.0f, 1200.0f, 5.0f));
    assert(irregular.prepare(sampleRate, 70.0f, 1200.0f, 5.0f));

    constexpr std::size_t frames = 8192U;
    std::vector<float> sixtyFourData(frames);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        sixtyFourData[frame] = static_cast<float>(0.3 * std::sin(2.0 * kPi * 180.0 * static_cast<double>(frame) / sampleRate));
    }
    auto irregularData = sixtyFourData;

    const auto before = test_alloc::count();
    test_alloc::beginTracking();
    for (std::size_t offset = 0U; offset < frames; offset += NativePitchProcessor::kMaximumCallbackFrames) {
        assert(sixtyFour.processInPlace(sixtyFourData.data() + offset, NativePitchProcessor::kMaximumCallbackFrames));
    }
    test_alloc::endTracking();
    assert(test_alloc::count() == before);

    constexpr std::array<unsigned int, 7> chunks{{1U, 63U, 64U, 11U, 29U, 5U, 127U}};
    std::size_t offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(chunks[chunkIndex % chunks.size()], frames - offset));
        assert(irregular.processInPlace(irregularData.data() + offset, count));
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t i = 0U; i < frames; ++i) expectNear(sixtyFourData[i], irregularData[i], 1.0e-6f);
}

void testInterleavedMonoAndStereoFallbackContracts() {
    constexpr unsigned int sampleRate = 48000U;
    NativePitchProcessor processor;
    assert(processor.prepare(sampleRate, 70.0f, 1200.0f, 0.0f));
    const auto latency = static_cast<std::size_t>(processor.latencySamples());
    constexpr std::size_t frames = 4096U;
    std::vector<float> stereo(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        stereo[frame * 2U] = 0.2f;
        stereo[frame * 2U + 1U] = 0.4f;
    }
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    assert(processor.processInterleaved(stereo.data(), 64U, 2U));
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
    assert(processor.processInterleaved(stereo.data() + 128U, static_cast<unsigned int>(frames - 64U), 2U));
    expectNear(stereo[latency * 2U], 0.3f);
    expectNear(stereo[latency * 2U + 1U], 0.3f);

    std::array<float, 6> threeChannels{{0.1f, 0.2f, 0.3f, -0.4f, 0.5f, 0.6f}};
    const auto before = threeChannels;
    assert(!processor.processInterleaved(threeChannels.data(), 2U, 3U));
    assert(threeChannels == before);
}

void testNativeHostFallbackDecision() {
    const auto active = decideNativePitchRoute(true, true, false, 2U, 5000U, 1000U);
    assert(active.useProcessor);
    assert(active.fallbackReason == NativePitchFallbackReason::None);
    assert(decideNativePitchRoute(false, true, false, 1U, 5000U, 1000U).fallbackReason ==
        NativePitchFallbackReason::NotRequested);
    assert(decideNativePitchRoute(true, false, false, 1U, 5000U, 1000U).fallbackReason ==
        NativePitchFallbackReason::ProcessorNotPrepared);
    assert(decideNativePitchRoute(true, true, true, 1U, 5000U, 1000U).fallbackReason ==
        NativePitchFallbackReason::ReversePlayback);
    assert(decideNativePitchRoute(true, true, false, 3U, 5000U, 1000U).fallbackReason ==
        NativePitchFallbackReason::UnsupportedChannelCount);
    assert(decideNativePitchRoute(true, true, false, 2U, 1000U, 1000U).fallbackReason ==
        NativePitchFallbackReason::LoopShorterThanLatency);
}

} // namespace

int main() {
    testPrepareLatencyAndConfigurationValidation();
    testLatencyAccountingAcrossSupportedRates();
    testFixedDryDelayAndSilenceUnvoicedBehavior();
    testYinPsolaTranspositionAndBoundedSignal();
    testAllocationFree64FrameCallsAndBlockSegmentation();
    testInterleavedMonoAndStereoFallbackContracts();
    testNativeHostFallbackDecision();
    return 0;
}
