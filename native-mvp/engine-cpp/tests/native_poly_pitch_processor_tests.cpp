#include "native_poly_pitch_processor.hpp"
#include "native_pitch_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <tuple>
#include <vector>

using namespace webrc::native;

namespace {

constexpr double kPi = 3.14159265358979323846;

void runBlocks(NativePolyPitchProcessor& processor, std::vector<float>& samples, unsigned int channels,
               const std::vector<unsigned int>& chunks) {
    std::size_t offsetFrames = 0U;
    std::size_t chunkIndex = 0U;
    const auto totalFrames = samples.size() / channels;
    while (offsetFrames < totalFrames) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(
            chunks[chunkIndex % chunks.size()], totalFrames - offsetFrames));
        assert(processor.processInterleaved(samples.data() + offsetFrames * channels, count, channels));
        offsetFrames += count;
        ++chunkIndex;
    }
}

double estimateByPositiveCrossings(const std::vector<float>& samples, std::size_t begin, std::size_t end,
                                   unsigned int sampleRate) {
    assert(end > begin + 1U);
    std::size_t crossings = 0U;
    for (std::size_t i = begin + 1U; i < end; ++i) {
        if (samples[i - 1U] <= 0.0f && samples[i] > 0.0f) ++crossings;
    }
    return static_cast<double>(crossings) * static_cast<double>(sampleRate) / static_cast<double>(end - begin);
}

double powerAt(const std::vector<float>& samples, std::size_t begin, std::size_t end,
               unsigned int sampleRate, double frequency) {
    double real = 0.0;
    double imaginary = 0.0;
    for (std::size_t i = begin; i < end; ++i) {
        const double phase = 2.0 * kPi * frequency * static_cast<double>(i) / static_cast<double>(sampleRate);
        real += static_cast<double>(samples[i]) * std::cos(phase);
        imaginary -= static_cast<double>(samples[i]) * std::sin(phase);
    }
    return real * real + imaginary * imaginary;
}

void testConfigurationAndReportedLatency() {
    NativePolyPitchProcessor processor;
    assert(!processor.prepare(0U));
    assert(!processor.prepare(48000U, 24.01f));
    assert(!processor.setFormantSemitones(1.0f));
    assert(!processor.setFormantBaseHz(220.0f));
    assert(processor.prepare(48000U, 0.0f));
    assert(processor.prepared());
    assert(processor.sampleRate() == 48000U);
    assert(processor.latencySamples() == NativePolyPitchProcessor::calculateLatencySamples(48000U));
    assert(processor.latencySamples() == 6720U);
    assert(processor.latencySamples() == 0U + 4800U + 1920U);
    for (const auto rate : {8000U, 44100U, 96000U, 192000U}) {
        NativePolyPitchProcessor rateProcessor;
        assert(rateProcessor.prepare(rate, 0.0f));
        assert(rateProcessor.latencySamples() == NativePolyPitchProcessor::calculateLatencySamples(rate));
    }
    assert(!processor.setSemitones(std::nanf("")));
    assert(!processor.setSemitones(-24.01f));
    assert(processor.setSemitones(-24.0f));
    assert(processor.setSemitones(24.0f));
    assert(!processor.setFormantSemitones(std::nanf("")));
    assert(!processor.setFormantSemitones(-12.01f));
    assert(!processor.setFormantSemitones(12.01f));
    assert(processor.setFormantSemitones(-12.0f));
    assert(processor.formantSemitones() == -12.0f);
    assert(processor.setFormantSemitones(5.0f, true));
    assert(processor.formantSemitones() == 5.0f);
    assert(!processor.setFormantBaseHz(std::nanf("")));
    assert(!processor.setFormantBaseHz(-1.0f));
    assert(!processor.setFormantBaseHz(24000.0f));
    assert(processor.setFormantBaseHz(220.0f));
    assert(processor.formantBaseHz() == 220.0f);
    processor.reset();
    assert(processor.formantSemitones() == 5.0f);
    assert(processor.formantBaseHz() == 220.0f);
}

void testCatalogPresetSpectralAccuracyAcrossFullRange() {
    constexpr unsigned int sampleRate = 48000U;
    for (const auto rate : {8000U, 44100U, 96000U, 192000U}) {
        NativePolyPitchProcessor rateProcessor;
        assert(rateProcessor.prepareForFx(rate, 0.0f));
        assert(rateProcessor.latencySamples() == NativePolyPitchProcessor::calculateFxLatencySamples(rate));
    }

    constexpr double sourceFrequency = 220.0;
    constexpr std::size_t kSamples = static_cast<std::size_t>(sampleRate) * 2U;
    for (const auto& [semitones, targetFrequency, competitors] : {
             std::tuple<float, double, std::array<double, 3U>>{24.0f, 880.0, {220.0, 440.0, 1760.0}},
             std::tuple<float, double, std::array<double, 3U>>{-24.0f, 55.0, {110.0, 220.0, 440.0}},
         }) {
        NativePolyPitchProcessor processor;
        assert(processor.prepareForFx(sampleRate, semitones));
        assert(processor.latencySamples() == 1920U);
        std::vector<float> tone(kSamples);
        for (std::size_t i = 0U; i < tone.size(); ++i) {
            tone[i] = static_cast<float>(0.35 * std::sin(2.0 * kPi * sourceFrequency *
                static_cast<double>(i) / sampleRate));
        }
        runBlocks(processor, tone, 1U, {64U, 17U, 127U, 3U, 256U});
        const auto begin = static_cast<std::size_t>(processor.latencySamples()) + sampleRate / 3U;
        const auto end = begin + sampleRate / 2U;
        const double targetPower = powerAt(tone, begin, end, sampleRate, targetFrequency);
        double largestCompetingPower = 0.0;
        for (const double frequency : competitors) {
            largestCompetingPower = std::max(largestCompetingPower,
                powerAt(tone, begin, end, sampleRate, frequency));
        }
        assert(targetPower > largestCompetingPower * 100.0);
        double energy = 0.0;
        for (std::size_t i = begin; i < end; ++i) {
            assert(std::isfinite(tone[i]));
            assert(std::fabs(tone[i]) < 1.5f);
            energy += static_cast<double>(tone[i]) * tone[i];
        }
        const double rms = std::sqrt(energy / static_cast<double>(end - begin));
        assert(rms > 0.05 && rms < 1.0);
    }
}

void testUnityPitchRetainsSignalAfterReportedLatency() {
    constexpr unsigned int sampleRate = 48000U;
    NativePolyPitchProcessor processor;
    assert(processor.prepare(sampleRate, 0.0f));
    const auto latency = static_cast<std::size_t>(processor.latencySamples());
    std::vector<float> tone(static_cast<std::size_t>(sampleRate) * 2U);
    for (std::size_t i = 0U; i < tone.size(); ++i) {
        tone[i] = static_cast<float>(0.35 * std::sin(2.0 * kPi * 440.0 * static_cast<double>(i) / sampleRate));
    }
    runBlocks(processor, tone, 1U, {64U, 17U, 127U, 3U, 256U});
    const auto begin = latency + static_cast<std::size_t>(sampleRate) / 3U;
    const auto end = begin + static_cast<std::size_t>(sampleRate) / 2U;
    const double observedHz = estimateByPositiveCrossings(tone, begin, end, sampleRate);
    assert(observedHz > 440.0 * 0.96 && observedHz < 440.0 * 1.04);
    double energy = 0.0;
    for (std::size_t i = begin; i < end; ++i) energy += static_cast<double>(tone[i]) * tone[i];
    assert(energy > 1.0);
}

void testSignalsmithShiftsSustainedTone() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr double sourceFrequency = 220.0;
    constexpr float semitones = 7.0f;
    NativePolyPitchProcessor processor;
    assert(processor.prepare(sampleRate, semitones));
    std::vector<float> signal(static_cast<std::size_t>(sampleRate) * 2U);
    for (std::size_t i = 0U; i < signal.size(); ++i) {
        signal[i] = static_cast<float>(0.35 * std::sin(2.0 * kPi * sourceFrequency * static_cast<double>(i) / sampleRate));
    }
    runBlocks(processor, signal, 1U, {64U, 17U, 127U, 3U, 256U});
    const auto latency = static_cast<std::size_t>(processor.latencySamples());
    const auto begin = latency + static_cast<std::size_t>(sampleRate) / 3U;
    const auto end = begin + static_cast<std::size_t>(sampleRate) / 2U;
    const double observedHz = estimateByPositiveCrossings(signal, begin, end, sampleRate);
    const double expectedHz = sourceFrequency * std::pow(2.0, static_cast<double>(semitones) / 12.0);
    assert(observedHz > expectedHz * 0.96 && observedHz < expectedHz * 1.04);
    double energy = 0.0;
    for (std::size_t i = begin; i < end; ++i) {
        assert(std::isfinite(signal[i]));
        assert(std::fabs(signal[i]) < 1.5f);
        energy += static_cast<double>(signal[i]) * static_cast<double>(signal[i]);
    }
    assert(energy > 1.0);
}

void testChordPartialsAreShiftedTogetherAndStereoIsRetained() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr double firstFrequency = 220.0;
    constexpr double secondFrequency = 329.63;
    constexpr float semitones = 3.0f;
    NativePolyPitchProcessor processor;
    assert(processor.prepare(sampleRate, semitones));
    const auto frames = static_cast<std::size_t>(sampleRate) * 2U;
    std::vector<float> stereo(frames * 2U);
    for (std::size_t i = 0U; i < frames; ++i) {
        const double first = 0.24 * std::sin(2.0 * kPi * firstFrequency * static_cast<double>(i) / sampleRate);
        const double second = 0.18 * std::sin(2.0 * kPi * secondFrequency * static_cast<double>(i) / sampleRate);
        stereo[i * 2U] = static_cast<float>(first + second);
        stereo[i * 2U + 1U] = static_cast<float>(first - second);
    }
    runBlocks(processor, stereo, 2U, {64U, 31U, 127U, 9U});

    std::vector<float> left(frames);
    std::vector<float> right(frames);
    for (std::size_t i = 0U; i < frames; ++i) {
        left[i] = stereo[i * 2U];
        right[i] = stereo[i * 2U + 1U];
    }
    const auto begin = static_cast<std::size_t>(processor.latencySamples()) + sampleRate / 3U;
    const auto end = begin + sampleRate / 2U;
    const double ratio = std::pow(2.0, static_cast<double>(semitones) / 12.0);
    const double firstTarget = firstFrequency * ratio;
    const double secondTarget = secondFrequency * ratio;
    const double leftFirst = powerAt(left, begin, end, sampleRate, firstTarget);
    const double leftSecond = powerAt(left, begin, end, sampleRate, secondTarget);
    const double rightFirst = powerAt(right, begin, end, sampleRate, firstTarget);
    const double rightSecond = powerAt(right, begin, end, sampleRate, secondTarget);
    assert(leftFirst > leftSecond * 0.3);
    assert(leftSecond > leftFirst * 0.2);
    assert(rightFirst > rightSecond * 0.3);
    assert(rightSecond > rightFirst * 0.2);
    assert(std::fabs(leftFirst - rightFirst) > 1.0);
}

void testChunkSegmentationAndNoCallbackAllocations() {
    constexpr unsigned int sampleRate = 48000U;
    NativePolyPitchProcessor blockProcessor;
    NativePolyPitchProcessor irregularProcessor;
    assert(blockProcessor.prepare(sampleRate, 5.0f));
    assert(irregularProcessor.prepare(sampleRate, 5.0f));
    std::vector<float> blockData(sampleRate / 2U);
    for (std::size_t i = 0U; i < blockData.size(); ++i) {
        blockData[i] = static_cast<float>(0.3 * std::sin(2.0 * kPi * 196.0 * static_cast<double>(i) / sampleRate));
    }
    auto irregularData = blockData;

    const auto before = test_alloc::count();
    test_alloc::beginTracking();
    assert(blockProcessor.processInterleaved(blockData.data(), static_cast<unsigned int>(blockData.size()), 1U));
    blockProcessor.reset();
    test_alloc::endTracking();
    assert(test_alloc::count() == before);
    std::array<float, 4096U * 2U> callback{};
    assert(blockProcessor.prepare(sampleRate, 5.0f));
    const auto beforeCallbacks = test_alloc::count();
    test_alloc::beginTracking();
    for (unsigned int i = 0U; i < callback.size() / 2U; i += 64U) {
        assert(blockProcessor.processInterleaved(callback.data() + i * 2U, 64U, 2U));
    }
    test_alloc::endTracking();
    assert(test_alloc::count() == beforeCallbacks);
    runBlocks(irregularProcessor, irregularData, 1U, {1U, 63U, 64U, 11U, 29U, 5U, 127U});
    for (std::size_t i = 0U; i < blockData.size(); ++i) {
        assert(std::fabs(blockData[i] - irregularData[i]) < 1.0e-6f);
    }
}

void testHostFallbackConditionsRemainExplicit() {
    constexpr unsigned int latency = 6720U;
    assert(decideNativePitchRoute(true, true, false, 2U, 12000U, latency).useProcessor);
    assert(decideNativePitchRoute(true, true, true, 2U, 12000U, latency).fallbackReason ==
        NativePitchFallbackReason::ReversePlayback);
    assert(decideNativePitchRoute(true, true, false, 2U, latency, latency).fallbackReason ==
        NativePitchFallbackReason::LoopShorterThanLatency);
    assert(decideNativePitchRoute(true, false, false, 2U, 12000U, latency).fallbackReason ==
        NativePitchFallbackReason::ProcessorNotPrepared);
}

void testOfficialBendExtendedRangeKeepsLegacyContract() {
    NativePolyPitchProcessor processor;
    assert(processor.prepareForFx(48000U));
    assert(!processor.setSemitones(25.0f));
    assert(!processor.setOfficialBendSemitones(-36.01f));
    assert(!processor.setOfficialBendSemitones(48.01f));
    for (float shift : {-36.0f, 48.0f}) {
        processor.reset();
        auto tone = std::vector<float>(48000U);
        for (unsigned int f = 0U; f < 48000U; ++f) tone[f] = static_cast<float>(0.2 * std::sin(2.0 * kPi * 220.0 * f / 48000.0));
        test_alloc::beginTracking();
        assert(processor.setOfficialBendSemitones(shift));
        for (unsigned int f = 0U; f < 48000U; f += 64U) assert(processor.processInterleaved(tone.data() + f, 64U, 1U));
        test_alloc::endTracking();
        assert(test_alloc::count() == 0U);
        const double expected = 220.0 * std::pow(2.0, shift / 12.0);
        assert(powerAt(tone, 24000U, 48000U, 48000U, expected) > powerAt(tone, 24000U, 48000U, 48000U, 220.0) * 20.0);
        for (float sample : tone) assert(std::isfinite(sample));
    }
}

} // namespace

int main() {
    testOfficialBendExtendedRangeKeepsLegacyContract();
    testConfigurationAndReportedLatency();
    testCatalogPresetSpectralAccuracyAcrossFullRange();
    testUnityPitchRetainsSignalAfterReportedLatency();
    testSignalsmithShiftsSustainedTone();
    testChordPartialsAreShiftedTogetherAndStereoIsRetained();
    testChunkSegmentationAndNoCallbackAllocations();
    testHostFallbackConditionsRemainExplicit();
    return 0;
}
