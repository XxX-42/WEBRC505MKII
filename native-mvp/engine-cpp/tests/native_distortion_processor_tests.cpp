#include "native_distortion_processor.hpp"
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
constexpr unsigned int kLatency = 24U;

void expectNear(float actual, float expected, float tolerance = 1.0e-6f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

float softSaturate(float input, float driveDb) {
    const double gain = std::pow(10.0, static_cast<double>(driveDb) / 20.0);
    return static_cast<float>(std::tanh(gain * input) / std::tanh(gain));
}

void testPrepareConfigAndLatencyAlignedMixEndpoints() {
    NativeDistortionProcessor processor;
    assert(!processor.prepare(7999U));
    assert(processor.prepare(8000U));
    assert(processor.prepare(44100U));
    assert(processor.prepare(48000U));
    assert(processor.prepare(96000U));
    assert(processor.prepare(192000U));
    assert(!processor.prepare(192001U));
    assert(processor.sampleRate() == 192000U);
    assert(processor.latencyFrames() == kLatency);

    NativeDistortionConfig config;
    assert(!processor.setConfig({-0.01f, 50.0f}));
    assert(!processor.setConfig({36.01f, 50.0f}));
    assert(!processor.setConfig({12.0f, -0.01f}));
    assert(!processor.setConfig({12.0f, 100.01f}));
    assert(!processor.setConfig({std::numeric_limits<float>::quiet_NaN(), 100.0f}));
    assert(!processor.setConfig({12.0f, std::numeric_limits<float>::infinity()}));

    std::vector<float> input(257U * 2U);
    for (std::size_t frame = 0U; frame < input.size() / 2U; ++frame) {
        input[frame * 2U] = static_cast<float>(0.7 * std::sin(0.013 * static_cast<double>(frame)));
        input[frame * 2U + 1U] = static_cast<float>(0.4 * std::cos(0.019 * static_cast<double>(frame)));
    }
    auto dry = input;
    config.driveDb = 24.0f;
    config.mixPercent = 0.0f;
    assert(processor.setConfig(config, 0U));
    (void)processor.processInPlace(dry.data(), 257U, 2U);
    for (unsigned int frame = 0U; frame < 257U; ++frame) {
        for (unsigned int channel = 0U; channel < 2U; ++channel) {
            const std::size_t index = static_cast<std::size_t>(frame) * 2U + channel;
            const float expected = frame < kLatency ? 0.0f : input[index - kLatency * 2U];
            expectNear(dry[index], expected, 0.0f);
        }
    }

    NativeDistortionProcessor wetProcessor;
    NativeDistortionProcessor halfProcessor;
    assert(wetProcessor.prepare(kSampleRate));
    assert(halfProcessor.prepare(kSampleRate));
    config.mixPercent = 100.0f;
    assert(wetProcessor.setConfig(config, 0U));
    config.mixPercent = 50.0f;
    assert(halfProcessor.setConfig(config, 0U));
    auto wet = input;
    auto half = input;
    (void)wetProcessor.processInPlace(wet.data(), 257U, 2U);
    (void)halfProcessor.processInPlace(half.data(), 257U, 2U);
    double wetVsDry = 0.0;
    for (std::size_t index = 0U; index < input.size(); ++index) {
        const float alignedDry = index < kLatency * 2U ? 0.0f : input[index - kLatency * 2U];
        expectNear(half[index], 0.5f * alignedDry + 0.5f * wet[index], 2.0e-6f);
        wetVsDry += std::fabs(static_cast<double>(wet[index] - alignedDry));
    }
    assert(wetVsDry > 1.0);
}

[[nodiscard]] double selectedBinAmplitude(const std::vector<float>& samples, unsigned int frequencyHz) {
    const std::size_t count = samples.size();
    double real = 0.0;
    double imaginary = 0.0;
    for (std::size_t index = 0U; index < count; ++index) {
        const double phase = 2.0 * kPi * static_cast<double>(frequencyHz) * static_cast<double>(index) /
                             static_cast<double>(kSampleRate);
        real += static_cast<double>(samples[index]) * std::cos(phase);
        imaginary -= static_cast<double>(samples[index]) * std::sin(phase);
    }
    return 2.0 * std::hypot(real, imaginary) / static_cast<double>(count);
}

double foldedAliasEnergy(const std::vector<float>& samples) {
    // A 5 kHz odd-harmonic series has aliases at these folded bins after
    // ordinary 48 kHz sampling. The fundamental and its first in-band odd
    // harmonic (5 and 15 kHz) are deliberately excluded.
    constexpr std::array<unsigned int, 6U> aliasBins{{3000U, 7000U, 11000U, 13000U, 17000U, 23000U}};
    double energy = 0.0;
    for (const unsigned int bin : aliasBins) {
        const double amplitude = selectedBinAmplitude(samples, bin);
        energy += amplitude * amplitude;
    }
    return energy;
}

void testOversamplingReducesFoldedHarmonicAliasEnergy() {
    constexpr unsigned int prerollFrames = 1024U;
    constexpr unsigned int analysisFrames = kSampleRate;
    constexpr unsigned int totalFrames = prerollFrames + analysisFrames;
    constexpr double frequencyHz = 5000.0;
    constexpr float amplitude = 0.68f;
    constexpr float driveDb = 18.0f;

    NativeDistortionProcessor processor;
    assert(processor.prepare(kSampleRate));
    assert(processor.setConfig({driveDb, 100.0f}, 0U));
    std::vector<float> oversampledInput(totalFrames);
    std::vector<float> naiveInput(totalFrames);
    for (unsigned int frame = 0U; frame < totalFrames; ++frame) {
        oversampledInput[frame] = static_cast<float>(amplitude * std::sin(
            2.0 * kPi * frequencyHz * static_cast<double>(frame) / static_cast<double>(kSampleRate)));
        naiveInput[frame] = softSaturate(oversampledInput[frame], driveDb);
    }
    (void)processor.processInPlace(oversampledInput.data(), totalFrames, 1U);

    std::vector<float> oversampledSteady(analysisFrames);
    std::vector<float> naiveSteady(analysisFrames);
    for (unsigned int frame = 0U; frame < analysisFrames; ++frame) {
        oversampledSteady[frame] = oversampledInput[prerollFrames + frame];
        naiveSteady[frame] = naiveInput[prerollFrames + frame];
    }
    const double naiveAliasEnergy = foldedAliasEnergy(naiveSteady);
    const double oversampledAliasEnergy = foldedAliasEnergy(oversampledSteady);
    assert(naiveAliasEnergy > 1.0e-5);
    assert(oversampledAliasEnergy < naiveAliasEnergy * 0.25);
}

void testFiniteProtectionDynamicRangeAndExtraChannelPassThrough() {
    NativeDistortionProcessor processor;
    assert(processor.prepare(kSampleRate));
    assert(processor.setConfig({36.0f, 100.0f}, 0U));
    constexpr unsigned int frames = 512U;
    constexpr unsigned int channels = 3U;
    std::vector<float> audio(static_cast<std::size_t>(frames) * channels);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        audio[static_cast<std::size_t>(frame) * channels] = frame % 3U == 0U
            ? std::numeric_limits<float>::max()
            : (frame % 3U == 1U ? std::numeric_limits<float>::infinity() : 40.0f);
        audio[static_cast<std::size_t>(frame) * channels + 1U] = frame % 2U == 0U
            ? std::numeric_limits<float>::quiet_NaN()
            : -std::numeric_limits<float>::max();
        audio[static_cast<std::size_t>(frame) * channels + 2U] = static_cast<float>(frame) * 0.01f;
    }
    const auto extraChannelBefore = audio;
    const float peak = processor.processInPlace(audio.data(), frames, channels);
    assert(std::isfinite(peak));
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        for (unsigned int channel = 0U; channel < 2U; ++channel) {
            const float value = audio[static_cast<std::size_t>(frame) * channels + channel];
            assert(std::isfinite(value));
            assert(std::fabs(value) <= 4.0f);
        }
        expectNear(audio[static_cast<std::size_t>(frame) * channels + 2U],
                   extraChannelBefore[static_cast<std::size_t>(frame) * channels + 2U], 0.0f);
    }

    NativeDistortionProcessor normalRange;
    assert(normalRange.prepare(kSampleRate));
    assert(normalRange.setConfig({24.0f, 100.0f}, 0U));
    std::array<float, 4U> testSignal{{-1.0f, -0.5f, 0.5f, 1.0f}};
    (void)normalRange.processInPlace(testSignal.data(), 4U, 1U);
    for (const float sample : testSignal) assert(std::isfinite(sample));
}

void testChunkInvarianceResetAndAllocationFreeCallback() {
    constexpr std::size_t frames = 10037U;
    NativeDistortionProcessor wholeProcessor;
    NativeDistortionProcessor chunkedProcessor;
    assert(wholeProcessor.prepare(44100U));
    assert(chunkedProcessor.prepare(44100U));
    NativeDistortionConfig config{27.0f, 73.0f};
    assert(wholeProcessor.setConfig(config, 777U));
    assert(chunkedProcessor.setConfig(config, 777U));

    std::vector<float> input(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        input[frame * 2U] = static_cast<float>(0.9 * std::sin(static_cast<double>(frame) * 0.013));
        input[frame * 2U + 1U] = static_cast<float>(0.8 * std::cos(static_cast<double>(frame) * 0.017));
    }
    auto whole = input;
    auto chunked = input;
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)wholeProcessor.processInPlace(whole.data(), static_cast<unsigned int>(frames), 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);

    constexpr std::array<unsigned int, 7U> chunks{{1U, 17U, 63U, 64U, 255U, 511U, 1024U}};
    std::size_t offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const unsigned int count = static_cast<unsigned int>(std::min<std::size_t>(
            chunks[chunkIndex % chunks.size()], frames - offset));
        (void)chunkedProcessor.processInPlace(chunked.data() + offset * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t index = 0U; index < whole.size(); ++index) {
        assert(std::isfinite(whole[index]));
        expectNear(whole[index], chunked[index], 0.0f);
    }

    wholeProcessor.reset();
    assert(wholeProcessor.setConfig(config, 0U));
    auto afterReset = input;
    (void)wholeProcessor.processInPlace(afterReset.data(), static_cast<unsigned int>(frames), 2U);
    NativeDistortionProcessor resetReference;
    assert(resetReference.prepare(44100U));
    assert(resetReference.setConfig(config, 0U));
    auto expectedReset = input;
    (void)resetReference.processInPlace(expectedReset.data(), static_cast<unsigned int>(frames), 2U);
    for (std::size_t index = 0U; index < expectedReset.size(); ++index) {
        expectNear(afterReset[index], expectedReset[index], 0.0f);
    }
}

void testControlSmoothingIsBlockInvariantAndAvoidsImmediateJump() {
    constexpr unsigned int frames = 512U;
    NativeDistortionProcessor processor;
    assert(processor.prepare(kSampleRate));
    assert(processor.setConfig({0.0f, 100.0f}, 0U));
    std::vector<float> audio(frames, 0.2f);
    (void)processor.processInPlace(audio.data(), frames, 1U);
    const float stableBefore = audio.back();
    assert(processor.setConfig({30.0f, 100.0f}, 128U));
    std::array<float, 128U> transition{};
    transition.fill(0.2f);
    (void)processor.processInPlace(transition.data(), 4U, 1U);
    for (unsigned int index = 0U; index < 4U; ++index) {
        assert(std::fabs(transition[index] - stableBefore) < 0.02f);
    }
    transition.fill(0.2f);
    (void)processor.processInPlace(transition.data(), 128U, 1U);
    assert(std::fabs(transition.back() - stableBefore) > 0.05f);

    NativeDistortionProcessor mixSmoother;
    assert(mixSmoother.prepare(kSampleRate));
    assert(mixSmoother.setConfig({24.0f, 0.0f}, 0U));
    std::vector<float> mixWarmup(512U, 0.3f);
    (void)mixSmoother.processInPlace(mixWarmup.data(), static_cast<unsigned int>(mixWarmup.size()), 1U);
    const float dryLevel = mixWarmup.back();
    assert(mixSmoother.setConfig({24.0f, 100.0f}, 128U));
    std::array<float, 128U> mixTransition{};
    mixTransition.fill(0.3f);
    (void)mixSmoother.processInPlace(mixTransition.data(), 4U, 1U);
    for (unsigned int index = 0U; index < 4U; ++index) {
        assert(std::fabs(mixTransition[index] - dryLevel) < 0.05f);
    }
    mixTransition.fill(0.3f);
    (void)mixSmoother.processInPlace(mixTransition.data(), 128U, 1U);
    assert(std::fabs(mixTransition.back() - dryLevel) > 0.1f);

    NativeDistortionProcessor whole;
    NativeDistortionProcessor chunks;
    assert(whole.prepare(kSampleRate));
    assert(chunks.prepare(kSampleRate));
    assert(whole.setConfig({0.0f, 0.0f}, 0U));
    assert(chunks.setConfig({0.0f, 0.0f}, 0U));
    std::array<float, 300U> wholeInput{};
    std::array<float, 300U> chunkInput{};
    wholeInput.fill(0.37f);
    chunkInput.fill(0.37f);
    assert(whole.setConfig({24.0f, 100.0f}, 211U));
    assert(chunks.setConfig({24.0f, 100.0f}, 211U));
    (void)whole.processInPlace(wholeInput.data(), static_cast<unsigned int>(wholeInput.size()), 1U);
    (void)chunks.processInPlace(chunkInput.data(), 37U, 1U);
    (void)chunks.processInPlace(chunkInput.data() + 37U, 91U, 1U);
    (void)chunks.processInPlace(chunkInput.data() + 128U, 172U, 1U);
    for (std::size_t index = 0U; index < wholeInput.size(); ++index) {
        expectNear(wholeInput[index], chunkInput[index], 0.0f);
    }
}

} // namespace

int main() {
    testPrepareConfigAndLatencyAlignedMixEndpoints();
    testOversamplingReducesFoldedHarmonicAliasEnergy();
    testFiniteProtectionDynamicRangeAndExtraChannelPassThrough();
    testChunkInvarianceResetAndAllocationFreeCallback();
    testControlSmoothingIsBlockInvariantAndAvoidsImmediateJump();
    return 0;
}
