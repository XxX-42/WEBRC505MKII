#include "native_preamp_processor.hpp"
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

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr unsigned int kSampleRate = 48000U;

void expectNear(float actual, float expected, float tolerance = 1.0e-6f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

[[nodiscard]] float onePoleCoefficient(float cutoffHz, unsigned int sampleRate) {
    return static_cast<float>(1.0 - std::exp(-2.0 * kPi * static_cast<double>(cutoffHz) /
                                               static_cast<double>(sampleRate)));
}

[[nodiscard]] float selectedBinAmplitude(const std::vector<float>& samples, unsigned int frequencyHz) {
    const std::size_t count = samples.size();
    double real = 0.0;
    double imaginary = 0.0;
    for (std::size_t index = 0U; index < count; ++index) {
        const double phase = 2.0 * kPi * static_cast<double>(frequencyHz) * static_cast<double>(index) /
                             static_cast<double>(kSampleRate);
        real += static_cast<double>(samples[index]) * std::cos(phase);
        imaginary -= static_cast<double>(samples[index]) * std::sin(phase);
    }
    return static_cast<float>(2.0 * std::hypot(real, imaginary) / static_cast<double>(count));
}

[[nodiscard]] double foldedAliasEnergy(const std::vector<float>& samples) {
    constexpr unsigned int sampleRate = kSampleRate;
    constexpr unsigned int nyquist = sampleRate / 2U;
    constexpr double testFrequency = 5000.0;
    std::array<bool, nyquist + 1U> aliasBins{};
    std::array<bool, nyquist + 1U> directHarmonicBins{};
    for (unsigned int harmonic = 1U; harmonic <= 4U; ++harmonic) {
        const unsigned int frequency = harmonic * static_cast<unsigned int>(testFrequency);
        if (frequency <= nyquist) directHarmonicBins[frequency] = true;
    }
    // Measure every distinct bin where the 5th–63rd harmonics fold below
    // Nyquist, excluding bins occupied by true 1x–4x in-band harmonics.
    for (unsigned int harmonic = 5U; harmonic <= 63U; ++harmonic) {
        unsigned int folded = static_cast<unsigned int>(harmonic * testFrequency) % sampleRate;
        if (folded > nyquist) folded = sampleRate - folded;
        if (folded > 0U) aliasBins[folded] = true;
    }
    double energy = 0.0;
    for (unsigned int frequency = 1U; frequency <= nyquist; ++frequency) {
        if (!aliasBins[frequency] || directHarmonicBins[frequency]) continue;
        const double amplitude = selectedBinAmplitude(samples, frequency);
        energy += amplitude * amplitude;
    }
    return energy;
}

class OneTimesLeadReference {
public:
    OneTimesLeadReference() {
        constexpr unsigned int taps = 129U;
        constexpr double cutoff = 6400.0 / static_cast<double>(kSampleRate);
        double coefficientSum = 0.0;
        for (unsigned int tap = 0U; tap < taps; ++tap) {
            const double offset = static_cast<double>(tap) - 64.0;
            const double ideal = offset == 0.0 ? 2.0 * cutoff
                : std::sin(2.0 * kPi * cutoff * offset) / (kPi * offset);
            const double normalizedPosition = static_cast<double>(tap) / 128.0;
            const double window = 0.42 - 0.5 * std::cos(2.0 * kPi * normalizedPosition) +
                                  0.08 * std::cos(4.0 * kPi * normalizedPosition);
            const double resonance = 0.012 * std::exp(-std::fabs(offset) / 17.0) *
                std::cos(2.0 * kPi * 185.0 * offset / static_cast<double>(kSampleRate));
            cabinetIr_[tap] = static_cast<float>((ideal + resonance) * window);
            coefficientSum += cabinetIr_[tap];
        }
        for (float& coefficient : cabinetIr_) coefficient /= static_cast<float>(coefficientSum);
    }

    [[nodiscard]] float process(float input) noexcept {
        constexpr std::array<float, 4U> stageDrive{{1.08f, 1.02f, 0.98f, 0.93f}};
        constexpr std::array<float, 4U> stageSlope{{0.94f, 1.04f, 0.91f, 1.12f}};
        constexpr float commonStageGain = 2.196007f; // fourth root of model 3's maximum total drive (23).
        float signal = input;
        for (unsigned int stage = 0U; stage < stageDrive.size(); ++stage) {
            const float slope = 1.28f * stageSlope[stage];
            const float bias = 0.16f * (0.72f + 0.17f * static_cast<float>(stage));
            const float stageInput = std::clamp(signal * commonStageGain * stageDrive[stage], -16.0f, 16.0f);
            // Deliberately naive 1x static transfer; production uses its
            // antiderivative averaged at 4x before reconstruction.
            signal = (std::tanh(slope * (stageInput + bias)) - std::tanh(slope * bias)) * 1.42f;
        }

        toneLow_ += onePoleCoefficient(180.0f, kSampleRate) * (signal - toneLow_);
        toneUpper_ += onePoleCoefficient(2500.0f, kSampleRate) * (signal - toneUpper_);
        const float tone = toneLow_ * 0.96f + (toneUpper_ - toneLow_) * 1.08f + (signal - toneUpper_);
        cabinetHighPass_ += onePoleCoefficient(72.0f, kSampleRate) * (tone - cabinetHighPass_);
        cabinetHistory_[cabinetWrite_] = tone - cabinetHighPass_;
        float output = 0.0f;
        unsigned int historyIndex = cabinetWrite_;
        for (unsigned int tap = 0U; tap < cabinetIr_.size(); ++tap) {
            output += cabinetIr_[tap] * cabinetHistory_[historyIndex];
            historyIndex = historyIndex == 0U ? static_cast<unsigned int>(cabinetIr_.size() - 1U) : historyIndex - 1U;
        }
        cabinetWrite_ = cabinetWrite_ + 1U == cabinetIr_.size() ? 0U : cabinetWrite_ + 1U;
        return output;
    }

private:
    std::array<float, 129U> cabinetIr_{};
    std::array<float, 129U> cabinetHistory_{};
    unsigned int cabinetWrite_ = 0U;
    float toneLow_ = 0.0f;
    float toneUpper_ = 0.0f;
    float cabinetHighPass_ = 0.0f;
};

void testSupportedRatesAndConfigBounds() {
    NativePreampProcessor processor;
    assert(!processor.prepare(7999U));
    assert(processor.prepare(8000U));
    assert(processor.prepare(22050U));
    assert(processor.prepare(44100U));
    assert(processor.prepare(48000U));
    assert(processor.prepare(96000U));
    assert(processor.prepare(192000U));
    assert(!processor.prepare(192001U));
    assert(processor.sampleRate() == 192000U);
    assert(processor.latencyFrames() == 88U);

    assert(!processor.setConfig({1.5f, 35.0f, 0.0f, 0.0f, 0.0f, 0.0f}));
    assert(!processor.setConfig({-1.0f, 35.0f, 0.0f, 0.0f, 0.0f, 0.0f}));
    assert(!processor.setConfig({4.0f, 100.1f, 0.0f, 0.0f, 0.0f, 0.0f}));
    assert(!processor.setConfig({0.0f, 35.0f, -12.1f, 0.0f, 0.0f, 0.0f}));
    assert(!processor.setConfig({0.0f, 35.0f, 0.0f, 12.1f, 0.0f, 0.0f}));
    assert(!processor.setConfig({0.0f, 35.0f, 0.0f, 0.0f, -12.1f, 0.0f}));
    assert(!processor.setConfig({0.0f, 35.0f, 0.0f, 0.0f, 0.0f, 12.1f}));
    assert(!processor.setConfig({0.0f, std::numeric_limits<float>::quiet_NaN(), 0.0f, 0.0f, 0.0f, 0.0f}));
    assert(processor.setConfig({4.0f, 100.0f, -12.0f, 12.0f, -12.0f, 12.0f}, 0U));
}

void testProcessingAtSupportedSampleRates() {
    constexpr std::array<unsigned int, 6U> sampleRates{{8000U, 22050U, 44100U, 48000U, 96000U, 192000U}};
    for (const unsigned int sampleRate : sampleRates) {
        NativePreampProcessor processor;
        assert(processor.prepare(sampleRate));
        assert(processor.setConfig({2.0f, 76.0f, 2.0f, -3.0f, 1.0f, 0.5f}, 64U));
        std::array<float, 514U> audio{};
        for (std::size_t frame = 0U; frame < audio.size() / 2U; ++frame) {
            audio[frame * 2U] = static_cast<float>(0.7 * std::sin(2.0 * kPi * 440.0 * frame / sampleRate));
            audio[frame * 2U + 1U] = static_cast<float>(0.6 * std::cos(2.0 * kPi * 880.0 * frame / sampleRate));
        }
        constexpr std::array<unsigned int, 4U> chunks{{1U, 31U, 64U, 161U}};
        std::size_t frameOffset = 0U;
        std::size_t chunkIndex = 0U;
        while (frameOffset < audio.size() / 2U) {
            const unsigned int count = static_cast<unsigned int>(std::min<std::size_t>(
                chunks[chunkIndex % chunks.size()], audio.size() / 2U - frameOffset));
            const float peak = processor.processInPlace(audio.data() + frameOffset * 2U, count, 2U);
            assert(std::isfinite(peak) && peak <= 4.0f);
            frameOffset += count;
            ++chunkIndex;
        }
        for (const float sample : audio) assert(std::isfinite(sample) && std::fabs(sample) <= 4.0f);
    }
}

void testModelsAndToneControlsChangeTheSound() {
    constexpr unsigned int frames = 4096U;
    std::vector<float> input(frames);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        input[frame] = static_cast<float>(0.78 * std::sin(2.0 * kPi * 700.0 * frame / kSampleRate));
    }

    NativePreampProcessor clean;
    NativePreampProcessor lead;
    assert(clean.prepare(kSampleRate) && lead.prepare(kSampleRate));
    assert(clean.setConfig({0.0f, 80.0f, 0.0f, 0.0f, 0.0f, 0.0f}, 0U));
    assert(lead.setConfig({3.0f, 80.0f, 0.0f, 0.0f, 0.0f, 0.0f}, 0U));
    auto cleanOutput = input;
    auto leadOutput = input;
    (void)clean.processInPlace(cleanOutput.data(), frames, 1U);
    (void)lead.processInPlace(leadOutput.data(), frames, 1U);
    double modelDifference = 0.0;
    for (unsigned int frame = 512U; frame < frames; ++frame) {
        modelDifference += std::fabs(static_cast<double>(cleanOutput[frame] - leadOutput[frame]));
    }
    assert(modelDifference > 10.0);

    NativePreampProcessor bassCut;
    NativePreampProcessor bassBoost;
    assert(bassCut.prepare(kSampleRate) && bassBoost.prepare(kSampleRate));
    assert(bassCut.setConfig({0.0f, 35.0f, -12.0f, 0.0f, 0.0f, 0.0f}, 0U));
    assert(bassBoost.setConfig({0.0f, 35.0f, 12.0f, 0.0f, 0.0f, 0.0f}, 0U));
    std::vector<float> lowTone(frames);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        lowTone[frame] = static_cast<float>(0.6 * std::sin(2.0 * kPi * 100.0 * frame / kSampleRate));
    }
    auto cutOutput = lowTone;
    auto boostOutput = lowTone;
    (void)bassCut.processInPlace(cutOutput.data(), frames, 1U);
    (void)bassBoost.processInPlace(boostOutput.data(), frames, 1U);
    double toneDifference = 0.0;
    for (unsigned int frame = 512U; frame < frames; ++frame) {
        toneDifference += std::fabs(static_cast<double>(cutOutput[frame] - boostOutput[frame]));
    }
    assert(toneDifference > 1.0);

    NativePreampProcessor unityLevel;
    NativePreampProcessor boostedLevel;
    assert(unityLevel.prepare(kSampleRate) && boostedLevel.prepare(kSampleRate));
    assert(unityLevel.setConfig({0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f}, 0U));
    assert(boostedLevel.setConfig({0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 6.0f}, 0U));
    auto unityOutput = input;
    auto levelOutput = input;
    (void)unityLevel.processInPlace(unityOutput.data(), frames, 1U);
    (void)boostedLevel.processInPlace(levelOutput.data(), frames, 1U);
    for (unsigned int frame = 512U; frame < frames; ++frame) {
        expectNear(levelOutput[frame], std::clamp(unityOutput[frame] * 1.9952623f, -4.0f, 4.0f), 2.0e-5f);
    }
}

void testImpulseResponseIsCenteredAtDeclaredFirLatency() {
    constexpr unsigned int frames = 256U;
    for (unsigned int model = 0U; model <= 4U; ++model) {
        NativePreampProcessor processor;
        assert(processor.prepare(kSampleRate));
        assert(processor.setConfig({static_cast<float>(model), 20.0f, 0.0f, 0.0f, 0.0f, 0.0f}, 0U));
        std::array<float, frames> impulse{};
        impulse[0U] = 0.5f;
        (void)processor.processInPlace(impulse.data(), frames, 1U);
        unsigned int peakFrame = 0U;
        double impulseEnergy = 0.0;
        double energyWeightedFrame = 0.0;
        for (unsigned int frame = 1U; frame < frames; ++frame) {
            if (std::fabs(impulse[frame]) > std::fabs(impulse[peakFrame])) peakFrame = frame;
        }
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            const double energy = static_cast<double>(impulse[frame]) * impulse[frame];
            impulseEnergy += energy;
            energyWeightedFrame += energy * frame;
        }
        const int latencyError = static_cast<int>(peakFrame) - static_cast<int>(processor.latencyFrames());
        assert(std::abs(latencyError) <= 5);
        const double energyCentroid = energyWeightedFrame / impulseEnergy;
        assert(std::fabs(energyCentroid - static_cast<double>(processor.latencyFrames())) <= 3.0);
        assert(std::isfinite(impulse[peakFrame]));
    }
}

void testFourTimesOversamplingReducesFoldedHarmonicEnergy() {
    constexpr unsigned int prerollFrames = 2048U;
    constexpr unsigned int analysisFrames = kSampleRate;
    constexpr unsigned int totalFrames = prerollFrames + analysisFrames;
    constexpr double frequencyHz = 5000.0;
    constexpr float amplitude = 0.68f;
    NativePreampProcessor processor;
    assert(processor.prepare(kSampleRate));
    assert(processor.setConfig({3.0f, 100.0f, 0.0f, 0.0f, 0.0f, 0.0f}, 0U));
    std::vector<float> oversampled(totalFrames);
    std::vector<float> naive(totalFrames);
    OneTimesLeadReference oneTimesReference;
    for (unsigned int frame = 0U; frame < totalFrames; ++frame) {
        const float input = static_cast<float>(amplitude * std::sin(
            2.0 * kPi * frequencyHz * static_cast<double>(frame) / static_cast<double>(kSampleRate)));
        oversampled[frame] = input;
        naive[frame] = oneTimesReference.process(input);
    }
    (void)processor.processInPlace(oversampled.data(), totalFrames, 1U);
    std::vector<float> oversampledSteady(analysisFrames);
    std::vector<float> naiveSteady(analysisFrames);
    for (unsigned int frame = 0U; frame < analysisFrames; ++frame) {
        oversampledSteady[frame] = oversampled[prerollFrames + frame];
        naiveSteady[frame] = naive[prerollFrames + frame];
    }
    const double naiveAliases = foldedAliasEnergy(naiveSteady);
    const double oversampledAliases = foldedAliasEnergy(oversampledSteady);
    assert(naiveAliases > 1.0e-5);
    assert(oversampledAliases < naiveAliases * 0.05);
}

void testFiniteBoundsExtraChannelsVariableBlocksAndNoAllocations() {
    constexpr std::size_t frames = 10037U;
    constexpr unsigned int channels = 3U;
    NativePreampProcessor wholeProcessor;
    NativePreampProcessor chunkedProcessor;
    assert(wholeProcessor.prepare(44100U) && chunkedProcessor.prepare(44100U));
    const NativePreampConfig config{2.0f, 87.0f, 3.5f, -4.0f, 1.5f, 2.0f};
    assert(wholeProcessor.setConfig(config, 777U));
    assert(chunkedProcessor.setConfig(config, 777U));

    std::vector<float> input(frames * channels);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        input[frame * channels] = static_cast<float>(0.9 * std::sin(static_cast<double>(frame) * 0.013));
        input[frame * channels + 1U] = static_cast<float>(0.8 * std::cos(static_cast<double>(frame) * 0.017));
        input[frame * channels + 2U] = static_cast<float>(frame) * 0.01f;
    }
    auto whole = input;
    auto chunked = input;
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)wholeProcessor.processInPlace(whole.data(), static_cast<unsigned int>(frames), channels);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);

    constexpr std::array<unsigned int, 7U> chunks{{1U, 17U, 63U, 64U, 255U, 511U, 1024U}};
    std::size_t offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const unsigned int count = static_cast<unsigned int>(std::min<std::size_t>(
            chunks[chunkIndex % chunks.size()], frames - offset));
        (void)chunkedProcessor.processInPlace(chunked.data() + offset * channels, count, channels);
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        expectNear(whole[frame * channels], chunked[frame * channels], 0.0f);
        expectNear(whole[frame * channels + 1U], chunked[frame * channels + 1U], 0.0f);
        expectNear(whole[frame * channels + 2U], input[frame * channels + 2U], 0.0f);
        assert(std::fabs(whole[frame * channels]) <= 4.0f);
        assert(std::fabs(whole[frame * channels + 1U]) <= 4.0f);
    }

    NativePreampProcessor finiteProcessor;
    assert(finiteProcessor.prepare(kSampleRate));
    assert(finiteProcessor.setConfig({3.0f, 100.0f, 12.0f, 12.0f, 12.0f, 12.0f}, 0U));
    std::array<float, 12U> exceptional{{
        std::numeric_limits<float>::max(), std::numeric_limits<float>::infinity(), 12.0f,
        std::numeric_limits<float>::quiet_NaN(), -std::numeric_limits<float>::max(), 13.0f,
        -std::numeric_limits<float>::infinity(), 0.0f, 14.0f,
        0.5f, -0.5f, 15.0f,
    }};
    const auto before = exceptional;
    const float peak = finiteProcessor.processInPlace(exceptional.data(), 4U, 3U);
    assert(std::isfinite(peak) && peak <= 4.0f);
    for (unsigned int frame = 0U; frame < 4U; ++frame) {
        assert(std::isfinite(exceptional[frame * 3U]));
        assert(std::isfinite(exceptional[frame * 3U + 1U]));
        assert(std::fabs(exceptional[frame * 3U]) <= 4.0f);
        assert(std::fabs(exceptional[frame * 3U + 1U]) <= 4.0f);
        expectNear(exceptional[frame * 3U + 2U], before[frame * 3U + 2U], 0.0f);
    }
}

void testControlSmoothingAndReset() {
    constexpr unsigned int frames = 1024U;
    NativePreampProcessor processor;
    assert(processor.prepare(kSampleRate));
    assert(processor.setConfig({0.0f, 5.0f, 0.0f, 0.0f, 0.0f, 0.0f}, 0U));
    std::vector<float> warmup(frames, 0.25f);
    (void)processor.processInPlace(warmup.data(), frames, 1U);
    const float stableBefore = warmup.back();
    assert(processor.setConfig({3.0f, 95.0f, 8.0f, -6.0f, 5.0f, 0.0f}, 128U));
    std::array<float, 128U> transition{};
    transition.fill(0.25f);
    (void)processor.processInPlace(transition.data(), 4U, 1U);
    assert(std::fabs(transition[3U] - stableBefore) < 0.04f);
    transition.fill(0.25f);
    (void)processor.processInPlace(transition.data(), 128U, 1U);
    assert(std::fabs(transition.back() - stableBefore) > 0.05f);

    processor.reset();
    auto afterReset = std::vector<float>(256U, 0.25f);
    (void)processor.processInPlace(afterReset.data(), static_cast<unsigned int>(afterReset.size()), 1U);
    NativePreampProcessor resetReference;
    assert(resetReference.prepare(kSampleRate));
    assert(resetReference.setConfig({3.0f, 95.0f, 8.0f, -6.0f, 5.0f, 0.0f}, 0U));
    auto expected = std::vector<float>(256U, 0.25f);
    (void)resetReference.processInPlace(expected.data(), static_cast<unsigned int>(expected.size()), 1U);
    for (std::size_t index = 0U; index < expected.size(); ++index) expectNear(afterReset[index], expected[index], 0.0f);
}

} // namespace

int main() {
    testSupportedRatesAndConfigBounds();
    testProcessingAtSupportedSampleRates();
    testModelsAndToneControlsChangeTheSound();
    testImpulseResponseIsCenteredAtDeclaredFirLatency();
    testFourTimesOversamplingReducesFoldedHarmonicEnergy();
    testFiniteBoundsExtraChannelsVariableBlocksAndNoAllocations();
    testControlSmoothingAndReset();
}
