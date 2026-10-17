#include "native_auto_riff_core.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <vector>

using namespace webrc::native;

namespace {

constexpr double kPi = 3.14159265358979323846;

void fillSine(std::vector<float>& samples, std::size_t frameOffset, std::size_t frames,
              unsigned int channels, unsigned int sampleRate, double frequency,
              float amplitude = 0.35f) {
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const double value = static_cast<double>(amplitude) * std::sin(2.0 * kPi * frequency *
            static_cast<double>(frameOffset + frame) / static_cast<double>(sampleRate));
        for (unsigned int channel = 0U; channel < channels; ++channel) {
            samples[(frameOffset + frame) * channels + channel] = static_cast<float>(value);
        }
    }
}

void processChunks(NativeAutoRiffCore& core, std::vector<float>& samples, unsigned int channels,
                   const std::vector<unsigned int>& chunkSizes) {
    assert(!chunkSizes.empty());
    std::size_t frameOffset = 0U;
    std::size_t chunkIndex = 0U;
    const std::size_t totalFrames = samples.size() / channels;
    while (frameOffset < totalFrames) {
        const auto requested = static_cast<std::size_t>(chunkSizes[chunkIndex % chunkSizes.size()]);
        const auto count = static_cast<unsigned int>(std::min(requested, totalFrames - frameOffset));
        assert(count > 0U);
        assert(core.processInterleaved(samples.data() + frameOffset * channels, count, channels));
        frameOffset += count;
        ++chunkIndex;
    }
}

double powerAt(const std::vector<float>& mono, std::size_t begin, std::size_t end,
               unsigned int sampleRate, double frequency) {
    double real = 0.0;
    double imaginary = 0.0;
    for (std::size_t i = begin; i < end; ++i) {
        const double phase = 2.0 * kPi * frequency * static_cast<double>(i) /
            static_cast<double>(sampleRate);
        real += static_cast<double>(mono[i]) * std::cos(phase);
        imaginary -= static_cast<double>(mono[i]) * std::sin(phase);
    }
    return real * real + imaginary * imaginary;
}

void testPrepareParametersAndLatency() {
    NativeAutoRiffCore core;
    assert(!core.prepare(0U));
    assert(!core.prepare(7999U));
    assert(core.prepare(48000U));
    assert(core.prepared());
    assert(core.sampleRate() == 48000U);
    assert(core.latencySamples() == NativeAutoRiffCore::calculateLatencySamples(48000U));
    assert(core.latencySamples() == 1920U);
    assert(core.detectorLatencySamples() > 0U);
    assert(core.detectorLatencySamples() < 48000U / 10U);
    assert(!core.setParameter("scale", -1.0f));
    assert(!core.setParameter("scale", 4.1f));
    assert(!core.setParameter("scale", 1.5f));
    assert(!core.setParameter("rate", 0.3f));
    assert(!core.setParameter("sensitivity", -0.1f));
    assert(!core.setParameter("sensitivity", 100.1f));
    assert(!core.setParameter("mix", std::numeric_limits<float>::infinity()));
    assert(!core.setParameter("missing", 1.0f));
    for (const float scale : {0.0f, 1.0f, 2.0f, 3.0f, 4.0f}) {
        assert(core.setParameter("auto-riff.scale", scale));
    }
    for (const float rate : {0.25f, 0.5f, 1.0f, 2.0f, 4.0f}) {
        assert(core.setParameter("rate", rate));
    }
    assert(core.setParameter("sensitivity", 0.0f));
    assert(core.setParameter("sensitivity", 100.0f));
    assert(core.setParameter("mix", 0.0f));
    assert(core.setParameter("mix", 100.0f));
    assert(!core.setTempoBpm(19.9f));
    assert(!core.setTempoBpm(300.1f));
    assert(!core.setTempoBpm(std::nanf("")));
    assert(core.setTempoBpm(20.0f));
    assert(core.setTempoBpm(300.0f));
}

void testDetectedPitchAndSignalsmithSequenceTransitions() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr double sourceHz = 440.0;
    NativeAutoRiffCore core;
    assert(core.prepare(sampleRate));
    assert(core.setParameter("scale", 1.0f)); // C major: A, B, C, E ...
    assert(core.setParameter("rate", 0.25f));
    assert(core.setParameter("sensitivity", 70.0f));
    assert(core.setParameter("mix", 100.0f));
    assert(core.setTempoBpm(120.0f));

    constexpr std::size_t totalFrames = static_cast<std::size_t>(sampleRate) * 2U / 3U;
    std::vector<float> audio(totalFrames);
    fillSine(audio, 0U, totalFrames, 1U, sampleRate, sourceHz);
    std::uint64_t sequenceStartUpperBound = std::numeric_limits<std::uint64_t>::max();
    bool sawStep1 = false;
    bool sawStep2 = false;
    bool sawStep3 = false;
    int priorStep = -1;
    for (std::size_t frame = 0U; frame < totalFrames; frame += 64U) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(64U, totalFrames - frame));
        assert(core.processInterleaved(audio.data() + frame, count, 1U));
        const int step = core.currentStep();
        if (priorStep < 0 && step >= 0) sequenceStartUpperBound = core.sampleCursor();
        if (step == 1 && !sawStep1) {
            sawStep1 = true;
            assert(std::fabs(core.targetSemitones() - 2.0f) < 0.01f);
        }
        if (step == 2 && !sawStep2) {
            sawStep2 = true;
            assert(std::fabs(core.targetSemitones() - 3.0f) < 0.01f);
        }
        if (step == 3 && !sawStep3) {
            sawStep3 = true;
            assert(std::fabs(core.targetSemitones() - 7.0f) < 0.01f);
        }
        priorStep = step;
    }
    assert(sequenceStartUpperBound != std::numeric_limits<std::uint64_t>::max());
    assert(core.voiced());
    assert(core.rootMidiNote() == 69); // detected A4 is retained in C major
    assert(core.detectedFrequencyHz() > 430.0f && core.detectedFrequencyHz() < 450.0f);
    assert(sawStep1 && sawStep2 && sawStep3);

    const std::size_t latency = core.latencySamples();
    const std::size_t stepPeriod = core.stepPeriodSamples();
    const std::size_t windowFrames = sampleRate * 4U / 100U;
    const std::size_t firstWindow = static_cast<std::size_t>(sequenceStartUpperBound) + latency +
        sampleRate * 25U / 1000U;
    const std::size_t secondStepWindow = static_cast<std::size_t>(sequenceStartUpperBound) + stepPeriod +
        latency + sampleRate * 25U / 1000U;
    const std::size_t thirdStepWindow = static_cast<std::size_t>(sequenceStartUpperBound) + 2U * stepPeriod +
        latency + sampleRate * 25U / 1000U;
    assert(thirdStepWindow + windowFrames < audio.size());
    const double basePower = powerAt(audio, firstWindow, firstWindow + windowFrames, sampleRate, 440.0);
    const double step1TargetPower = powerAt(audio, secondStepWindow, secondStepWindow + windowFrames,
                                            sampleRate, 440.0 * std::pow(2.0, 2.0 / 12.0));
    const double step1SourcePower = powerAt(audio, secondStepWindow, secondStepWindow + windowFrames,
                                            sampleRate, 440.0);
    const double step2TargetPower = powerAt(audio, thirdStepWindow, thirdStepWindow + windowFrames,
                                            sampleRate, 440.0 * std::pow(2.0, 3.0 / 12.0));
    const double step2PreviousPower = powerAt(audio, thirdStepWindow, thirdStepWindow + windowFrames,
                                              sampleRate, 440.0 * std::pow(2.0, 2.0 / 12.0));
    assert(basePower > 1.0);
    assert(step1TargetPower > step1SourcePower * 3.0);
    assert(step2TargetPower > step2PreviousPower * 3.0);
    for (const float sample : audio) assert(std::isfinite(sample));
}

std::uint64_t firstStepOneSample(unsigned int sampleRate, float bpm, float stepRate) {
    NativeAutoRiffCore core;
    assert(core.prepare(sampleRate));
    assert(core.setParameter("scale", 1.0f));
    assert(core.setParameter("rate", stepRate));
    assert(core.setParameter("mix", 100.0f));
    assert(core.setTempoBpm(bpm));
    const std::size_t limit = static_cast<std::size_t>(sampleRate) * 3U;
    std::array<float, 128U> block{};
    std::uint64_t previousStart = 0U;
    bool foundStart = false;
    for (std::size_t frame = 0U; frame < limit; frame += block.size()) {
        for (std::size_t i = 0U; i < block.size(); ++i) {
            block[i] = static_cast<float>(0.35 * std::sin(2.0 * kPi * 440.0 *
                static_cast<double>(frame + i) / static_cast<double>(sampleRate)));
        }
        assert(core.processInterleaved(block.data(), static_cast<unsigned int>(block.size()), 1U));
        if (core.currentStep() >= 0 && !foundStart) {
            foundStart = true;
            previousStart = core.sampleCursor();
        }
        if (foundStart && core.currentStep() == 1) return core.sampleCursor();
    }
    assert(false && "step one was not scheduled");
    return previousStart;
}

void testTempoScalingUsesSampleClock() {
    constexpr unsigned int sampleRate = 48000U;
    const auto fastTransition = firstStepOneSample(sampleRate, 120.0f, 0.5f);
    const auto slowTransition = firstStepOneSample(sampleRate, 60.0f, 0.5f);
    const auto observedSpacing = slowTransition - fastTransition;
    const auto expectedSpacing = static_cast<std::uint64_t>(sampleRate) / 4U;
    assert(observedSpacing > expectedSpacing - 512U);
    assert(observedSpacing < expectedSpacing + 512U);
}

int stepAfterAmplitudeReattack(float sensitivity) {
    constexpr unsigned int sampleRate = 48000U;
    NativeAutoRiffCore core;
    assert(core.prepare(sampleRate));
    assert(core.setParameter("scale", 1.0f));
    assert(core.setParameter("rate", 0.25f));
    assert(core.setParameter("sensitivity", sensitivity));
    assert(core.setParameter("mix", 100.0f));
    assert(core.setTempoBpm(120.0f));
    constexpr std::size_t totalFrames = sampleRate * 42U / 100U;
    std::array<float, 128U> block{};
    for (std::size_t frame = 0U; frame < totalFrames; frame += block.size()) {
        for (std::size_t i = 0U; i < block.size(); ++i) {
            const std::size_t absolute = frame + i;
            const double amplitude = absolute < sampleRate * 34U / 100U ? 0.25 : 0.5;
            block[i] = static_cast<float>(amplitude * std::sin(2.0 * kPi * 220.0 *
                static_cast<double>(absolute) / sampleRate));
        }
        assert(core.processInterleaved(block.data(), static_cast<unsigned int>(block.size()), 1U));
    }
    return core.currentStep();
}

void testSensitivityControlsReattackReset() {
    const int highSensitivityStep = stepAfterAmplitudeReattack(100.0f);
    const int lowSensitivityStep = stepAfterAmplitudeReattack(0.0f);
    assert(highSensitivityStep == 0);
    assert(lowSensitivityStep != 0);
}

void testPitchDetectionAcrossSupportedSampleRates() {
    for (const unsigned int sampleRate : {8000U, 44100U, 96000U, 192000U}) {
        NativeAutoRiffCore core;
        assert(core.prepare(sampleRate));
        assert(core.latencySamples() == NativeAutoRiffCore::calculateLatencySamples(sampleRate));
        assert(core.setParameter("scale", 0.0f));
        assert(core.setParameter("mix", 100.0f));
        const std::size_t frames = static_cast<std::size_t>(sampleRate) / 5U;
        std::vector<float> audio(frames);
        fillSine(audio, 0U, frames, 1U, sampleRate, 220.0);
        processChunks(core, audio, 1U, {64U, 257U, 11U});
        assert(core.voiced());
        assert(core.rootMidiNote() == 57);
        assert(core.detectedFrequencyHz() > 215.0f && core.detectedFrequencyHz() < 225.0f);
        for (const float sample : audio) assert(std::isfinite(sample));
    }
}

void testStereoFiniteSilenceGateSegmentationAndNoAllocations() {
    constexpr unsigned int sampleRate = 44100U;
    NativeAutoRiffCore blockCore;
    NativeAutoRiffCore chunkCore;
    assert(blockCore.prepare(sampleRate));
    assert(chunkCore.prepare(sampleRate));
    for (NativeAutoRiffCore* core : {&blockCore, &chunkCore}) {
        assert(core->setParameter("scale", 4.0f));
        assert(core->setParameter("rate", 0.5f));
        assert(core->setParameter("sensitivity", 65.0f));
        assert(core->setParameter("mix", 100.0f));
        assert(core->setTempoBpm(110.0f));
    }

    constexpr std::size_t frames = sampleRate;
    std::vector<float> oneBlock(frames * 2U);
    std::vector<float> irregular(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        oneBlock[frame * 2U] = static_cast<float>(0.24 * std::sin(2.0 * kPi * 440.0 *
            static_cast<double>(frame) / sampleRate));
        oneBlock[frame * 2U + 1U] = static_cast<float>(0.2 * std::sin(2.0 * kPi * 330.0 *
            static_cast<double>(frame) / sampleRate));
    }
    irregular = oneBlock;
    oneBlock[25U] = std::numeric_limits<float>::quiet_NaN();
    oneBlock[1U] = std::numeric_limits<float>::infinity();
    irregular[25U] = std::numeric_limits<float>::quiet_NaN();
    irregular[1U] = std::numeric_limits<float>::infinity();
    const std::vector<unsigned int> segmentation{1U, 17U, 127U, 3U, 256U, 29U};

    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    assert(blockCore.processInterleaved(oneBlock.data(), static_cast<unsigned int>(frames), 2U));
    processChunks(chunkCore, irregular, 2U, segmentation);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
    assert(blockCore.voiced() && chunkCore.voiced());
    assert(blockCore.rootMidiNote() == chunkCore.rootMidiNote());
    assert(blockCore.currentStep() == chunkCore.currentStep());
    assert(std::fabs(blockCore.targetSemitones() - chunkCore.targetSemitones()) < 0.01f);
    double maximumDifference = 0.0;
    for (std::size_t i = 0U; i < oneBlock.size(); ++i) {
        assert(std::isfinite(oneBlock[i]));
        assert(std::isfinite(irregular[i]));
        maximumDifference = std::max(maximumDifference,
            std::fabs(static_cast<double>(oneBlock[i]) - static_cast<double>(irregular[i])));
    }
    assert(maximumDifference < 1.0e-4);

    NativeAutoRiffCore silenceCore;
    assert(silenceCore.prepare(sampleRate));
    std::vector<float> silence(static_cast<std::size_t>(sampleRate) * 2U, 0.0f);
    processChunks(silenceCore, silence, 1U, {31U, 8U, 64U});
    assert(!silenceCore.voiced());
    assert(silenceCore.currentStep() == -1);
    double silenceEnergy = 0.0;
    for (std::size_t i = silence.size() / 2U; i < silence.size(); ++i) {
        assert(std::isfinite(silence[i]));
        silenceEnergy += static_cast<double>(silence[i]) * silence[i];
    }
    assert(silenceEnergy < 1.0e-6);

    std::vector<float> voicedInput(sampleRate / 2U);
    fillSine(voicedInput, 0U, voicedInput.size(), 1U, sampleRate, 220.0);
    processChunks(silenceCore, voicedInput, 1U, {31U, 8U, 64U});
    assert(silenceCore.voiced());
    std::vector<float> releaseSilence(sampleRate / 2U, 0.0f);
    processChunks(silenceCore, releaseSilence, 1U, {31U, 8U, 64U});
    assert(!silenceCore.voiced());
    assert(silenceCore.currentStep() == -1);
    double releaseEnergy = 0.0;
    for (std::size_t i = releaseSilence.size() / 2U; i < releaseSilence.size(); ++i) {
        assert(std::isfinite(releaseSilence[i]));
        releaseEnergy += static_cast<double>(releaseSilence[i]) * releaseSilence[i];
    }
    assert(releaseEnergy < 1.0e-5);

    const auto cursorBeforeReset = blockCore.sampleCursor();
    assert(cursorBeforeReset == frames);
    blockCore.reset();
    assert(blockCore.sampleCursor() == 0U);
    assert(!blockCore.voiced());
    assert(blockCore.currentStep() == -1);
    assert(blockCore.prepared());
}

} // namespace

int main() {
    testPrepareParametersAndLatency();
    testDetectedPitchAndSignalsmithSequenceTransitions();
    testTempoScalingUsesSampleClock();
    testSensitivityControlsReattackReset();
    testPitchDetectionAcrossSupportedSampleRates();
    testStereoFiniteSilenceGateSegmentationAndNoAllocations();
    return 0;
}
