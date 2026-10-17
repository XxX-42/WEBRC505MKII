#include "native_fdn16_reverb_processor.hpp"
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

void expectNear(float actual, float expected, float tolerance = 1.0e-6f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

bool isPrime(unsigned int value) {
    if (value < 2U) return false;
    if ((value % 2U) == 0U) return value == 2U;
    for (unsigned int divisor = 3U; divisor <= value / divisor; divisor += 2U) {
        if ((value % divisor) == 0U) return false;
    }
    return true;
}

NativeFdn16ReverbConfig testConfig(float wetMix = 1.0f, float rt60 = 2.0f, float damping = 8000.0f) {
    NativeFdn16ReverbConfig config{};
    config.enabled = true;
    config.wetMix = wetMix;
    config.rt60Seconds = rt60;
    config.dampingCutoffHz = damping;
    return config;
}

std::vector<float> renderImpulse(float dampingCutoffHz, unsigned int frames) {
    NativeFdn16ReverbProcessor reverb;
    assert(reverb.setConfig(testConfig(1.0f, 3.0f, dampingCutoffHz), 0U));
    assert(reverb.prepare(48000U));
    std::vector<float> audio(static_cast<std::size_t>(frames) * 2U, 0.0f);
    audio[0] = 1.0f;
    audio[1] = 0.5f;
    (void)reverb.processInPlace(audio.data(), frames, 2U);
    return audio;
}

double spectralMagnitude(const std::vector<float>& audio, unsigned int channel, float frequencyHz,
                        unsigned int sampleRate, unsigned int startFrame, unsigned int endFrame) {
    constexpr double kPi = 3.14159265358979323846;
    double real = 0.0;
    double imaginary = 0.0;
    double windowSum = 0.0;
    const double frameCount = static_cast<double>(endFrame - startFrame);
    for (unsigned int frame = startFrame; frame < endFrame; ++frame) {
        const double position = static_cast<double>(frame - startFrame) / frameCount;
        const double window = 0.5 - (0.5 * std::cos(2.0 * kPi * position));
        const double phase = 2.0 * kPi * static_cast<double>(frequencyHz) *
            static_cast<double>(frame) / static_cast<double>(sampleRate);
        const double sample = static_cast<double>(audio[static_cast<std::size_t>(frame) * 2U + channel]) * window;
        real += sample * std::cos(phase);
        imaginary -= sample * std::sin(phase);
        windowSum += window;
    }
    return std::sqrt((real * real) + (imaginary * imaginary)) / std::max(1.0, windowSum);
}

double estimateSchroederRt60(const std::vector<float>& stereo, unsigned int sampleRate) {
    const auto frames = static_cast<unsigned int>(stereo.size() / 2U);
    std::vector<double> decayEnergy(static_cast<std::size_t>(frames) + 1U, 0.0);
    for (unsigned int frame = frames; frame-- > 0U;) {
        const double left = stereo[static_cast<std::size_t>(frame) * 2U];
        const double right = stereo[static_cast<std::size_t>(frame) * 2U + 1U];
        decayEnergy[frame] = decayEnergy[frame + 1U] + left * left + right * right;
    }
    const double reference = decayEnergy.front();
    assert(reference > 0.0 && std::isfinite(reference));

    // Fit the -5 to -35 dB portion of the backward-integrated energy decay
    // curve, then extrapolate the measured slope to -60 dB.
    double sumTime = 0.0;
    double sumDb = 0.0;
    double sumTimeSquared = 0.0;
    double sumTimeDb = 0.0;
    std::size_t points = 0U;
    for (unsigned int frame = 1U; frame < frames; ++frame) {
        const double db = 10.0 * std::log10(decayEnergy[frame] / reference);
        if (db <= -5.0 && db >= -35.0) {
            const double time = static_cast<double>(frame) / sampleRate;
            sumTime += time;
            sumDb += db;
            sumTimeSquared += time * time;
            sumTimeDb += time * db;
            ++points;
        }
    }
    assert(points > 100U);
    const double count = static_cast<double>(points);
    const double denominator = count * sumTimeSquared - sumTime * sumTime;
    assert(denominator > 0.0);
    const double slopeDbPerSecond = (count * sumTimeDb - sumTime * sumDb) / denominator;
    assert(std::isfinite(slopeDbPerSecond) && slopeDbPerSecond < 0.0);
    return -60.0 / slopeDbPerSecond;
}

void testSampleRateBoundsPrimeLinesAndConfigValidation() {
    NativeFdn16ReverbProcessor tooSlow;
    assert(!tooSlow.prepare(NativeFdn16ReverbProcessor::kMinimumSampleRate - 1U));
    assert(tooSlow.sampleRate() == 0U);

    NativeFdn16ReverbProcessor lowRate;
    assert(lowRate.setConfig(testConfig(0.6f, 4.0f, 16000.0f), 0U));
    assert(lowRate.prepare(NativeFdn16ReverbProcessor::kMinimumSampleRate));
    assert(lowRate.sampleRate() == NativeFdn16ReverbProcessor::kMinimumSampleRate);
    unsigned int previousDelay = 0U;
    for (std::size_t line = 0U; line < NativeFdn16ReverbProcessor::kLineCount; ++line) {
        const unsigned int delay = lowRate.lineDelayFrames(line);
        assert(delay > previousDelay);
        assert(isPrime(delay));
        previousDelay = delay;
    }
    assert(lowRate.lineDelayFrames(NativeFdn16ReverbProcessor::kLineCount) == 0U);

    NativeFdn16ReverbProcessor highRate;
    assert(highRate.prepare(NativeFdn16ReverbProcessor::kMaximumSampleRate));
    assert(highRate.sampleRate() == NativeFdn16ReverbProcessor::kMaximumSampleRate);
    for (std::size_t line = 0U; line < NativeFdn16ReverbProcessor::kLineCount; ++line) {
        assert(isPrime(highRate.lineDelayFrames(line)));
    }
    NativeFdn16ReverbProcessor tooFast;
    assert(!tooFast.prepare(NativeFdn16ReverbProcessor::kMaximumSampleRate + 1U));

    auto invalid = testConfig();
    invalid.wetMix = std::nanf("");
    assert(!lowRate.setConfig(invalid));
    invalid = testConfig();
    invalid.wetMix = 1.01f;
    assert(!lowRate.setConfig(invalid));
    invalid = testConfig();
    invalid.rt60Seconds = 0.09f;
    assert(!lowRate.setConfig(invalid));
    invalid = testConfig();
    invalid.rt60Seconds = 20.01f;
    assert(!lowRate.setConfig(invalid));
    invalid = testConfig();
    invalid.dampingCutoffHz = 499.0f;
    assert(!lowRate.setConfig(invalid));
    invalid = testConfig();
    invalid.dampingCutoffHz = std::numeric_limits<float>::infinity();
    assert(!lowRate.setConfig(invalid));
}

void testImpulseFiniteBoundedDenseAndStereoLateField() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = sampleRate * 6U;
    NativeFdn16ReverbProcessor reverb;
    assert(reverb.setConfig(testConfig(1.0f, 2.0f, 9000.0f), 0U));
    assert(reverb.prepare(sampleRate));

    std::vector<float> impulse(static_cast<std::size_t>(frames) * 2U, 0.0f);
    impulse[0] = 1.0f;
    impulse[1] = 0.0f;
    const float peak = reverb.processInPlace(impulse.data(), frames, 2U);
    assert(std::isfinite(peak) && peak > 1.0e-4f && peak < 2.0f);

    double totalEnergy = 0.0;
    double earlyEnergy = 0.0;
    double lateEnergy = 0.0;
    std::size_t denseSamples = 0U;
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float left = impulse[static_cast<std::size_t>(frame) * 2U];
        const float right = impulse[static_cast<std::size_t>(frame) * 2U + 1U];
        assert(std::isfinite(left) && std::isfinite(right));
        const double energy = (static_cast<double>(left) * left) + (static_cast<double>(right) * right);
        totalEnergy += energy;
        if (frame >= sampleRate / 2U && frame < sampleRate * 3U / 2U) earlyEnergy += energy;
        if (frame >= sampleRate * 9U / 2U && frame < sampleRate * 11U / 2U) lateEnergy += energy;
        if (frame >= sampleRate / 5U && frame < sampleRate && (std::fabs(left) > 1.0e-8f || std::fabs(right) > 1.0e-8f)) {
            ++denseSamples;
        }
    }
    assert(totalEnergy > 1.0e-5 && totalEnergy < 10000.0);
    assert(earlyEnergy > 1.0e-8 && lateEnergy < earlyEnergy);
    assert(denseSamples > 1000U);

    // Distinct Hadamard output rows provide a decorrelated stereo late field.
    double leftSquare = 0.0;
    double rightSquare = 0.0;
    double cross = 0.0;
    for (unsigned int frame = sampleRate / 5U; frame < sampleRate; ++frame) {
        const double left = impulse[static_cast<std::size_t>(frame) * 2U];
        const double right = impulse[static_cast<std::size_t>(frame) * 2U + 1U];
        leftSquare += left * left;
        rightSquare += right * right;
        cross += left * right;
    }
    assert(leftSquare > 1.0e-8 && rightSquare > 1.0e-8);
    const double correlation = cross / std::sqrt(leftSquare * rightSquare);
    assert(std::fabs(correlation) < 0.98);
}

void testDampingChangesHighFrequencyDecay() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = sampleRate * 2U;
    const auto dark = renderImpulse(900.0f, frames);
    const auto bright = renderImpulse(16000.0f, frames);
    constexpr unsigned int startFrame = sampleRate / 4U;
    constexpr unsigned int endFrame = sampleRate * 7U / 4U;
    double darkDifference = 0.0;
    double brightDifference = 0.0;
    double darkTotal = 0.0;
    double brightTotal = 0.0;
    for (std::size_t index = static_cast<std::size_t>(startFrame) * 2U;
         index < static_cast<std::size_t>(endFrame) * 2U; ++index) {
        const double darkSample = dark[index];
        const double brightSample = bright[index];
        darkDifference += darkSample * darkSample;
        brightDifference += brightSample * brightSample;
        darkTotal += std::fabs(darkSample);
        brightTotal += std::fabs(brightSample);
    }
    assert(darkDifference > 1.0e-8 && brightDifference > 1.0e-8);
    assert(std::fabs(darkTotal - brightTotal) > 1.0e-4);

    const double darkLow = spectralMagnitude(dark, 0U, 500.0f, sampleRate, startFrame, endFrame);
    const double darkHigh = spectralMagnitude(dark, 0U, 9000.0f, sampleRate, startFrame, endFrame);
    const double brightLow = spectralMagnitude(bright, 0U, 500.0f, sampleRate, startFrame, endFrame);
    const double brightHigh = spectralMagnitude(bright, 0U, 9000.0f, sampleRate, startFrame, endFrame);
    assert(darkLow > 1.0e-8 && brightLow > 1.0e-8);
    assert((darkHigh / darkLow) < (brightHigh / brightLow));
}

void testConfiguredRt60MatchesSchroederEnergyDecay() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::array<float, 3U> targetRt60Seconds{{0.5f, 2.0f, 4.0f}};
    for (const float targetRt60 : targetRt60Seconds) {
        const auto frames = static_cast<unsigned int>(std::ceil(targetRt60 * 2.5f * sampleRate));
        NativeFdn16ReverbProcessor reverb;
        assert(reverb.setConfig(testConfig(1.0f, targetRt60, 20000.0f), 0U));
        assert(reverb.prepare(sampleRate));
        std::vector<float> impulse(static_cast<std::size_t>(frames) * 2U, 0.0f);
        impulse[0] = 1.0f;
        const float peak = reverb.processInPlace(impulse.data(), frames, 2U);
        assert(std::isfinite(peak) && peak > 0.0f);

        const double measuredRt60 = estimateSchroederRt60(impulse, sampleRate);
        const double relativeError = std::fabs(measuredRt60 - targetRt60) / targetRt60;
        assert(relativeError < 0.08);
    }
}

void testChunkInvarianceSmoothingResetAndBypass() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int totalFrames = 18000U;
    constexpr unsigned int changeAt = 113U;
    NativeFdn16ReverbProcessor whole;
    NativeFdn16ReverbProcessor split;
    NativeFdn16ReverbProcessor unchanged;
    assert(whole.setConfig(testConfig(0.85f, 1.8f, 6000.0f), 1U));
    assert(split.setConfig(testConfig(0.85f, 1.8f, 6000.0f), 1U));
    assert(unchanged.setConfig(testConfig(0.85f, 1.8f, 6000.0f), 1U));
    assert(whole.prepare(sampleRate) && split.prepare(sampleRate) && unchanged.prepare(sampleRate));

    std::vector<float> input(static_cast<std::size_t>(totalFrames) * 2U);
    for (unsigned int frame = 0U; frame < totalFrames; ++frame) {
        const float n = static_cast<float>(frame);
        input[static_cast<std::size_t>(frame) * 2U] = (frame == 0U ? 0.75f : 0.0f) + 0.12f * std::sin(n * 0.071f);
        input[static_cast<std::size_t>(frame) * 2U + 1U] = (frame == 0U ? -0.3f : 0.0f) + 0.08f * std::cos(n * 0.053f);
    }
    auto wholeOutput = input;
    auto splitOutput = input;
    auto unchangedOutput = input;
    (void)whole.processInPlace(wholeOutput.data(), changeAt, 2U);
    (void)split.processInPlace(splitOutput.data(), changeAt, 2U);
    (void)unchanged.processInPlace(unchangedOutput.data(), changeAt, 2U);
    assert(whole.setConfig(testConfig(0.35f, 5.5f, 15000.0f), 997U));
    assert(split.setConfig(testConfig(0.35f, 5.5f, 15000.0f), 997U));
    const unsigned int remaining = totalFrames - changeAt;
    (void)whole.processInPlace(wholeOutput.data() + static_cast<std::size_t>(changeAt) * 2U, remaining, 2U);
    (void)unchanged.processInPlace(unchangedOutput.data() + static_cast<std::size_t>(changeAt) * 2U, remaining, 2U);
    constexpr std::array<unsigned int, 8U> chunks{{1U, 7U, 13U, 2U, 31U, 3U, 64U, 5U}};
    unsigned int processed = 0U;
    std::size_t chunkIndex = 0U;
    while (processed < remaining) {
        const unsigned int chunk = std::min(chunks[chunkIndex % chunks.size()], remaining - processed);
        (void)split.processInPlace(
            splitOutput.data() + static_cast<std::size_t>(changeAt + processed) * 2U, chunk, 2U
        );
        processed += chunk;
        ++chunkIndex;
    }
    double changedEnergy = 0.0;
    double unchangedEnergy = 0.0;
    for (std::size_t index = 0U; index < wholeOutput.size(); ++index) {
        expectNear(wholeOutput[index], splitOutput[index], 1.0e-7f);
        const double difference = static_cast<double>(wholeOutput[index]) - unchangedOutput[index];
        changedEnergy += difference * difference;
        unchangedEnergy += static_cast<double>(unchangedOutput[index]) * unchangedOutput[index];
    }
    assert(changedEnergy > unchangedEnergy * 1.0e-4);

    whole.resetState();
    NativeFdn16ReverbProcessor fresh;
    assert(fresh.setConfig(testConfig(0.35f, 5.5f, 15000.0f), 1U));
    assert(fresh.prepare(sampleRate));
    auto replayA = input;
    auto replayB = input;
    (void)whole.processInPlace(replayA.data(), totalFrames, 2U);
    (void)fresh.processInPlace(replayB.data(), totalFrames, 2U);
    for (std::size_t index = 0U; index < replayA.size(); ++index) {
        expectNear(replayA[index], replayB[index], 1.0e-7f);
    }

    NativeFdn16ReverbConfig disabled = testConfig(1.0f, 5.5f, 15000.0f);
    disabled.enabled = false;
    assert(whole.setConfig(disabled, 0U));
    std::array<float, 32U> dry{{
        0.5f, -0.4f, 0.2f, -0.1f, 0.8f, -0.7f, 0.0f, 0.1f,
        0.3f, 0.2f, -0.3f, 0.6f, -0.9f, 0.25f, 0.12f, -0.42f,
        0.14f, 0.32f, -0.51f, 0.77f, 0.93f, -0.23f, -0.11f, 0.45f,
        -0.33f, 0.61f, 0.08f, -0.72f, 0.55f, 0.19f, -0.02f, 0.48f
    }};
    const auto original = dry;
    (void)whole.processInPlace(dry.data(), 16U, 2U);
    for (std::size_t index = 0U; index < dry.size(); ++index) expectNear(dry[index], original[index]);

    whole.resetState();
    std::array<float, 32U> silence{};
    (void)whole.processInPlace(silence.data(), 16U, 2U);
    for (const float sample : silence) expectNear(sample, 0.0f);
}

void testNoAllocationDuringProcess() {
    NativeFdn16ReverbProcessor reverb;
    assert(reverb.setConfig(testConfig(0.7f, 2.4f, 6500.0f), 0U));
    assert(reverb.prepare(48000U));
    std::array<float, 2048U> audio{};
    for (std::size_t index = 0U; index < audio.size(); ++index) {
        audio[index] = 0.2f * std::sin(static_cast<float>(index) * 0.061f);
    }
    const std::size_t before = test_alloc::count();
    test_alloc::beginTracking();
    (void)reverb.processInPlace(audio.data(), 1024U, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == before);
}

} // namespace

int main() {
    testSampleRateBoundsPrimeLinesAndConfigValidation();
    testImpulseFiniteBoundedDenseAndStereoLateField();
    testDampingChangesHighFrequencyDecay();
    testConfiguredRt60MatchesSchroederEnergyDecay();
    testChunkInvarianceSmoothingResetAndBypass();
    testNoAllocationDuringProcess();
    return 0;
}
