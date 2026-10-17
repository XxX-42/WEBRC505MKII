#include "native_fx_catalog.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <limits>
#include <memory>
#include <string_view>
#include <vector>

using namespace webrc::native;

namespace {

constexpr unsigned int kSampleRate = 48000U;
constexpr double kPi = 3.141592653589793238462643383279502884;

[[nodiscard]] std::vector<float> makeTone(unsigned int frames, double frequency, float amplitude = 0.24f) {
    std::vector<float> result(static_cast<std::size_t>(frames) * 2U);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float sample = amplitude * static_cast<float>(std::sin(
            2.0 * kPi * frequency * static_cast<double>(frame) / static_cast<double>(kSampleRate)));
        result[static_cast<std::size_t>(frame) * 2U] = sample;
        result[(static_cast<std::size_t>(frame) * 2U) + 1U] = sample;
    }
    return result;
}

[[nodiscard]] double projectedAmplitude(
    const std::vector<float>& samples,
    unsigned int firstFrame,
    unsigned int endFrame,
    double frequency
) {
    double real = 0.0;
    double imaginary = 0.0;
    const unsigned int count = endFrame - firstFrame;
    for (unsigned int frame = firstFrame; frame < endFrame; ++frame) {
        const double phase = 2.0 * kPi * frequency * static_cast<double>(frame - firstFrame) /
            static_cast<double>(kSampleRate);
        const double sample = samples[static_cast<std::size_t>(frame) * 2U];
        real += sample * std::cos(phase);
        imaginary -= sample * std::sin(phase);
    }
    return 2.0 * std::hypot(real, imaginary) / static_cast<double>(count);
}

void processChunked(NativeEffectProcessor& processor, std::vector<float>& audio, bool variableChunks) {
    constexpr std::array<unsigned int, 7U> chunks{{1U, 31U, 127U, 64U, 257U, 96U, 211U}};
    const unsigned int totalFrames = static_cast<unsigned int>(audio.size() / 2U);
    unsigned int position = 0U;
    std::size_t chunkIndex = 0U;
    while (position < totalFrames) {
        const unsigned int requested = variableChunks
            ? chunks[chunkIndex++ % chunks.size()] : 256U;
        const unsigned int frames = std::min(requested, totalFrames - position);
        (void)processor.processInPlace(audio.data() + (static_cast<std::size_t>(position) * 2U), frames, 2U);
        position += frames;
    }
}

void testDescriptorAndParameterBounds() {
    const auto* descriptor = findNativeEffectDescriptor("synth");
    assert(descriptor != nullptr);
    assert(descriptor->sourceIndex == 6);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    assert(descriptor->parameterCount == 5U);

    const auto* sensitivity = findNativeEffectParameter("synth", "sensitivity");
    const auto* waveform = findNativeEffectParameter("synth", "waveform");
    const auto* octave = findNativeEffectParameter("synth", "octave");
    const auto* tone = findNativeEffectParameter("synth", "tone");
    const auto* mix = findNativeEffectParameter("synth", "mix");
    assert(sensitivity != nullptr && sensitivity->minimum == 0.0f && sensitivity->maximum == 100.0f &&
        sensitivity->defaultValue == 60.0f);
    assert(waveform != nullptr && waveform->minimum == 0.0f && waveform->maximum == 2.0f &&
        waveform->discrete && waveform->discreteValueCount == 3U);
    assert(octave != nullptr && octave->minimum == -24.0f && octave->maximum == 24.0f);
    assert(tone != nullptr && tone->minimum == 100.0f && tone->maximum == 16000.0f);
    assert(mix != nullptr && mix->minimum == 0.0f && mix->maximum == 100.0f);

    auto processor = createNativeEffectProcessor("synth");
    assert(processor != nullptr && processor->stableId() == "synth");
    assert(processor->prepare(kSampleRate));
    assert(!processor->setParameter("sensitivity", -0.1f));
    assert(!processor->setParameter("sensitivity", 100.1f));
    assert(!processor->setParameter("waveform", 1.5f));
    assert(!processor->setParameter("octave", -24.1f));
    assert(!processor->setParameter("octave", 24.1f));
    assert(!processor->setParameter("tone", 99.0f));
    assert(!processor->setParameter("tone", 16001.0f));
    assert(!processor->setParameter("mix", 100.1f));
    assert(!processor->setParameter("mix", std::numeric_limits<float>::quiet_NaN()));
    assert(processor->setParameter("sensitivity", 0.0f, 1U));
    assert(processor->setParameter("sensitivity", 100.0f, 1U));
    assert(processor->setParameter("waveform", 2.0f, 1U));
    assert(processor->setParameter("octave", -24.0f, 1U));
    assert(processor->setParameter("octave", 24.0f, 1U));
    assert(processor->setParameter("tone", 100.0f, 1U));
    assert(processor->setParameter("tone", 16000.0f, 1U));
    assert(processor->setParameter("mix", 0.0f, 1U));
    assert(processor->setParameter("mix", 100.0f, 1U));
}

void testPitchTrackingFiniteOutputAndChunkInvariance() {
    constexpr unsigned int frames = 48000U;
    auto source = makeTone(frames, 440.0);
    auto variableOutput = source;
    auto fixedOutput = source;
    auto variableProcessor = createNativeEffectProcessor("synth");
    auto fixedProcessor = createNativeEffectProcessor("synth");
    assert(variableProcessor != nullptr && fixedProcessor != nullptr);
    assert(variableProcessor->prepare(kSampleRate) && fixedProcessor->prepare(kSampleRate));
    assert(variableProcessor->setParameter("sensitivity", 80.0f, 1U));
    assert(fixedProcessor->setParameter("sensitivity", 80.0f, 1U));
    assert(variableProcessor->setParameter("mix", 100.0f, 1U));
    assert(fixedProcessor->setParameter("mix", 100.0f, 1U));

    processChunked(*variableProcessor, variableOutput, true);
    processChunked(*fixedProcessor, fixedOutput, false);
    for (std::size_t index = 0U; index < variableOutput.size(); ++index) {
        assert(std::isfinite(variableOutput[index]));
        assert(std::fabs(variableOutput[index]) <= 3.0f);
        assert(std::fabs(variableOutput[index] - fixedOutput[index]) <= 1.0e-7f);
    }
    const double fundamental = projectedAmplitude(variableOutput, 30000U, 48000U, 440.0);
    assert(fundamental > 0.02);
}

void testOctaveShiftAndDryMix() {
    constexpr unsigned int frames = 32000U;
    auto source = makeTone(frames, 440.0);
    auto shiftedOutput = source;
    auto shiftedProcessor = createNativeEffectProcessor("synth");
    assert(shiftedProcessor != nullptr && shiftedProcessor->prepare(kSampleRate));
    assert(shiftedProcessor->setParameter("sensitivity", 80.0f, 1U));
    assert(shiftedProcessor->setParameter("waveform", 1.0f, 1U));
    assert(shiftedProcessor->setParameter("octave", 12.0f, 1U));
    assert(shiftedProcessor->setParameter("mix", 100.0f, 1U));
    processChunked(*shiftedProcessor, shiftedOutput, true);
    assert(projectedAmplitude(shiftedOutput, 18000U, frames, 880.0) > 0.02);

    auto dryProcessor = createNativeEffectProcessor("synth");
    assert(dryProcessor != nullptr && dryProcessor->prepare(kSampleRate));
    assert(dryProcessor->setParameter("mix", 0.0f, 1U));
    auto drySignal = makeTone(512U, 330.0);
    const auto original = drySignal;
    (void)dryProcessor->processInPlace(drySignal.data(), 512U, 2U);
    assert(drySignal == original);
}

void testCallbackDoesNotAllocate() {
    auto processor = createNativeEffectProcessor("synth");
    assert(processor != nullptr && processor->prepare(kSampleRate));
    assert(processor->setParameter("mix", 100.0f, 1U));
    std::array<float, 514U> block{};
    for (unsigned int frame = 0U; frame < 257U; ++frame) {
        const float sample = 0.2f * static_cast<float>(std::sin(
            2.0 * kPi * 220.0 * static_cast<double>(frame) / static_cast<double>(kSampleRate)));
        block[frame * 2U] = sample;
        block[(frame * 2U) + 1U] = sample;
    }
    (void)processor->processInPlace(block.data(), 257U, 2U); // warm the tracker first
    const std::size_t allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    for (unsigned int iteration = 0U; iteration < 24U; ++iteration) {
        const unsigned int frames = (iteration % 3U) == 0U ? 257U : ((iteration % 3U) == 1U ? 64U : 127U);
        (void)processor->processInPlace(block.data(), frames, 2U);
    }
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
}

} // namespace

int main() {
    testDescriptorAndParameterBounds();
    testPitchTrackingFiniteOutputAndChunkInvariance();
    testOctaveShiftAndDryMix();
    testCallbackDoesNotAllocate();
    return 0;
}
