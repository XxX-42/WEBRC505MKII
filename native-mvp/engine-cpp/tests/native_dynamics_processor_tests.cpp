#include "native_dynamics_processor.hpp"
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

constexpr double kPi = 3.14159265358979323846;

void expectNear(float actual, float expected, float tolerance = 1.0e-5f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

float settledOutput(const NativeDynamicsConfig& config, float left, float right) {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int settleFrames = 8192U;
    NativeDynamicsProcessor processor;
    assert(processor.prepare(sampleRate));
    assert(processor.setConfig(config));

    std::array<float, settleFrames * 2U> steady{};
    for (unsigned int frame = 0U; frame < settleFrames; ++frame) {
        steady[static_cast<std::size_t>(frame) * 2U] = left;
        steady[static_cast<std::size_t>(frame) * 2U + 1U] = right;
    }
    (void)processor.processInPlace(steady.data(), settleFrames, 2U);
    std::array<float, 2U> last{{left, right}};
    (void)processor.processInPlace(last.data(), 1U, 2U);
    return last[0];
}

double referenceGainReductionDb(double levelDb, double thresholdDb, double ratio, double kneeDb) {
    const double slope = (1.0 / ratio) - 1.0;
    if (kneeDb <= 1.0e-6) {
        return levelDb > thresholdDb ? slope * (levelDb - thresholdDb) : 0.0;
    }
    const double lower = thresholdDb - kneeDb * 0.5;
    const double upper = thresholdDb + kneeDb * 0.5;
    if (levelDb >= upper) return slope * (levelDb - thresholdDb);
    if (levelDb > lower) {
        const double position = levelDb - lower;
        return slope * position * position / (2.0 * kneeDb);
    }
    return 0.0;
}

void testValidationDefaultsAndReset() {
    NativeDynamicsProcessor processor;
    assert(!processor.prepare(7999U));
    assert(processor.prepare(48000U));
    assert(processor.sampleRate() == 48000U);
    expectNear(processor.config().thresholdDb, -18.0f);
    expectNear(processor.config().ratio, 4.0f);
    expectNear(processor.config().kneeDb, 6.0f);
    expectNear(processor.config().attackMs, 10.0f);
    expectNear(processor.config().releaseMs, 120.0f);
    expectNear(processor.config().outputGainDb, 0.0f);
    assert(processor.config().detector == NativeDynamicsDetector::Peak);

    NativeDynamicsConfig invalid;
    invalid.thresholdDb = -60.1f;
    assert(!processor.setConfig(invalid));
    invalid = {};
    invalid.ratio = 20.1f;
    assert(!processor.setConfig(invalid));
    invalid = {};
    invalid.kneeDb = -0.1f;
    assert(!processor.setConfig(invalid));
    invalid = {};
    invalid.attackMs = 0.09f;
    assert(!processor.setConfig(invalid));
    invalid = {};
    invalid.releaseMs = 1000.1f;
    assert(!processor.setConfig(invalid));
    invalid = {};
    invalid.outputGainDb = std::numeric_limits<float>::quiet_NaN();
    assert(!processor.setConfig(invalid));
    invalid = {};
    invalid.detector = static_cast<NativeDynamicsDetector>(99U);
    assert(!processor.setConfig(invalid));

    NativeDynamicsConfig boundaries;
    boundaries.thresholdDb = -60.0f;
    boundaries.ratio = 20.0f;
    boundaries.kneeDb = 24.0f;
    boundaries.attackMs = 0.1f;
    boundaries.releaseMs = 1000.0f;
    boundaries.outputGainDb = 12.0f;
    assert(processor.setConfig(boundaries));
    processor.reset();
    assert(processor.setConfig(NativeDynamicsConfig{}));
}

void testSoftKneeRatioAndOutputGain() {
    NativeDynamicsConfig soft;
    soft.thresholdDb = -12.0f;
    soft.ratio = 4.0f;
    soft.kneeDb = 6.0f;
    soft.attackMs = 0.1f;
    soft.releaseMs = 50.0f;
    const float softOutput = settledOutput(soft, 0.25f, 0.25f);
    const double softLevel = 20.0 * std::log10(0.25);
    const double softExpected = 0.25 * std::pow(10.0,
        referenceGainReductionDb(softLevel, soft.thresholdDb, soft.ratio, soft.kneeDb) / 20.0);
    expectNear(softOutput, static_cast<float>(softExpected));

    NativeDynamicsConfig hard = soft;
    hard.kneeDb = 0.0f;
    const float hardOutput = settledOutput(hard, 0.25f, 0.25f);
    assert(softOutput < hardOutput); // The signal lies inside the soft-knee region.
    expectNear(hardOutput, 0.25f, 1.0e-6f);

    NativeDynamicsConfig noCompression = soft;
    noCompression.ratio = 1.0f;
    noCompression.outputGainDb = 6.0f;
    const float amplified = settledOutput(noCompression, 0.25f, 0.25f);
    expectNear(amplified, 0.25f * static_cast<float>(std::pow(10.0, 6.0 / 20.0)));
}

void testStereoLinkAndMonoProcessing() {
    NativeDynamicsConfig config;
    config.thresholdDb = -18.0f;
    config.ratio = 8.0f;
    config.kneeDb = 0.0f;
    config.attackMs = 0.1f;
    config.releaseMs = 100.0f;
    NativeDynamicsProcessor stereo;
    assert(stereo.prepare(48000U));
    assert(stereo.setConfig(config));
    std::array<float, 8192U * 2U> linked{};
    for (std::size_t frame = 0U; frame < linked.size() / 2U; ++frame) {
        linked[frame * 2U] = 0.8f;
        linked[frame * 2U + 1U] = 0.1f;
    }
    (void)stereo.processInPlace(linked.data(), 8192U, 2U);
    const float left = linked[linked.size() - 2U];
    const float right = linked.back();
    assert(left < 0.8f);
    expectNear(left / right, 8.0f, 1.0e-4f);

    NativeDynamicsProcessor mono;
    assert(mono.prepare(48000U));
    assert(mono.setConfig(config));
    std::array<float, 5U> monoSignal{{0.8f, 0.8f, 0.8f, 0.8f, 0.8f}};
    const float peak = mono.processInPlace(monoSignal.data(), static_cast<unsigned int>(monoSignal.size()), 1U);
    assert(peak <= 0.8f);
    for (const float sample : monoSignal) assert(std::isfinite(sample));
}

void testPeakRmsAndAttackReleaseResponse() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = 12037U;
    NativeDynamicsConfig peakConfig;
    peakConfig.thresholdDb = -12.0f;
    peakConfig.ratio = 4.0f;
    peakConfig.kneeDb = 0.0f;
    peakConfig.attackMs = 10.0f;
    peakConfig.releaseMs = 5.0f;
    NativeDynamicsConfig rmsConfig = peakConfig;
    rmsConfig.detector = NativeDynamicsDetector::Rms;

    NativeDynamicsProcessor peak;
    NativeDynamicsProcessor rms;
    assert(peak.prepare(sampleRate));
    assert(rms.prepare(sampleRate));
    assert(peak.setConfig(peakConfig));
    assert(rms.setConfig(rmsConfig));
    std::vector<float> sine(static_cast<std::size_t>(frames) * 2U);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float sample = static_cast<float>(0.8 * std::sin(2.0 * kPi * 440.0 * frame / sampleRate));
        sine[static_cast<std::size_t>(frame) * 2U] = sample;
        sine[static_cast<std::size_t>(frame) * 2U + 1U] = sample;
    }
    auto peakOutput = sine;
    auto rmsOutput = sine;
    (void)peak.processInPlace(peakOutput.data(), frames, 2U);
    (void)rms.processInPlace(rmsOutput.data(), frames, 2U);
    double peakEnergy = 0.0;
    double rmsEnergy = 0.0;
    constexpr unsigned int measureStart = frames - 2048U;
    for (unsigned int frame = measureStart; frame < frames; ++frame) {
        const double peakSample = peakOutput[static_cast<std::size_t>(frame) * 2U];
        const double rmsSample = rmsOutput[static_cast<std::size_t>(frame) * 2U];
        peakEnergy += peakSample * peakSample;
        rmsEnergy += rmsSample * rmsSample;
    }
    // With the Browser attack/release coefficient choice and this short
    // release, the RMS mean-square estimate yields visibly different gain.
    assert(peakEnergy > rmsEnergy * 1.1);

    NativeDynamicsConfig fastAttack = peakConfig;
    fastAttack.thresholdDb = -30.0f;
    fastAttack.attackMs = 0.1f;
    NativeDynamicsConfig slowAttack = fastAttack;
    slowAttack.attackMs = 100.0f;
    NativeDynamicsProcessor fast;
    NativeDynamicsProcessor slow;
    assert(fast.prepare(sampleRate));
    assert(slow.prepare(sampleRate));
    assert(fast.setConfig(fastAttack));
    assert(slow.setConfig(slowAttack));
    std::array<float, 2U> impulseFast{{1.0f, 1.0f}};
    std::array<float, 2U> impulseSlow{{1.0f, 1.0f}};
    (void)fast.processInPlace(impulseFast.data(), 1U, 2U);
    (void)slow.processInPlace(impulseSlow.data(), 1U, 2U);
    assert(impulseFast[0] < impulseSlow[0]);

    NativeDynamicsConfig fastRelease = peakConfig;
    fastRelease.attackMs = 0.1f;
    fastRelease.releaseMs = 5.0f;
    NativeDynamicsConfig slowRelease = fastRelease;
    slowRelease.releaseMs = 1000.0f;
    NativeDynamicsProcessor shortRelease;
    NativeDynamicsProcessor longRelease;
    assert(shortRelease.prepare(sampleRate));
    assert(longRelease.prepare(sampleRate));
    assert(shortRelease.setConfig(fastRelease));
    assert(longRelease.setConfig(slowRelease));
    std::array<float, 4096U * 2U> loudFast{};
    std::array<float, 4096U * 2U> loudSlow{};
    loudFast.fill(0.8f);
    loudSlow.fill(0.8f);
    (void)shortRelease.processInPlace(loudFast.data(), 4096U, 2U);
    (void)longRelease.processInPlace(loudSlow.data(), 4096U, 2U);
    std::array<float, 480U * 2U> silence{};
    (void)shortRelease.processInPlace(silence.data(), 480U, 2U);
    (void)longRelease.processInPlace(silence.data(), 480U, 2U);
    std::array<float, 2U> quietPulseFast{{0.1f, 0.1f}};
    std::array<float, 2U> quietPulseSlow{{0.1f, 0.1f}};
    (void)shortRelease.processInPlace(quietPulseFast.data(), 1U, 2U);
    (void)longRelease.processInPlace(quietPulseSlow.data(), 1U, 2U);
    assert(quietPulseFast[0] > quietPulseSlow[0]);
}

void testFiniteProtectionChunkInvarianceAndAllocations() {
    constexpr unsigned int sampleRate = 44100U;
    constexpr std::size_t frames = 10037U;
    NativeDynamicsConfig config;
    config.thresholdDb = -24.0f;
    config.ratio = 6.0f;
    config.kneeDb = 9.0f;
    config.attackMs = 2.0f;
    config.releaseMs = 200.0f;
    config.outputGainDb = 3.0f;
    config.detector = NativeDynamicsDetector::Rms;
    NativeDynamicsProcessor wholeProcessor;
    NativeDynamicsProcessor chunkedProcessor;
    assert(wholeProcessor.prepare(sampleRate));
    assert(chunkedProcessor.prepare(sampleRate));
    assert(wholeProcessor.setConfig(config));
    assert(chunkedProcessor.setConfig(config));

    std::vector<float> input(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        input[frame * 2U] = static_cast<float>(0.6 * std::sin(static_cast<double>(frame) * 0.013));
        input[frame * 2U + 1U] = static_cast<float>(0.45 * std::cos(static_cast<double>(frame) * 0.017));
    }
    auto whole = input;
    auto chunked = input;
    constexpr std::array<unsigned int, 7U> chunks{{1U, 17U, 63U, 64U, 255U, 511U, 1024U}};

    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)wholeProcessor.processInPlace(whole.data(), static_cast<unsigned int>(frames), 2U);
    std::size_t offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(chunks[chunkIndex % chunks.size()], frames - offset));
        (void)chunkedProcessor.processInPlace(chunked.data() + offset * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
    for (std::size_t index = 0U; index < whole.size(); ++index) {
        assert(std::isfinite(whole[index]));
        expectNear(whole[index], chunked[index], 0.0f);
    }

    wholeProcessor.reset();
    assert(wholeProcessor.setConfig(config));
    auto afterReset = input;
    (void)wholeProcessor.processInPlace(afterReset.data(), static_cast<unsigned int>(frames), 2U);
    NativeDynamicsProcessor resetReference;
    assert(resetReference.prepare(sampleRate));
    assert(resetReference.setConfig(config));
    auto expectedReset = input;
    (void)resetReference.processInPlace(expectedReset.data(), static_cast<unsigned int>(frames), 2U);
    for (std::size_t index = 0U; index < expectedReset.size(); ++index) {
        expectNear(afterReset[index], expectedReset[index], 0.0f);
    }

    NativeDynamicsProcessor finite;
    assert(finite.prepare(48000U));
    NativeDynamicsConfig hot;
    hot.thresholdDb = 0.0f;
    hot.ratio = 1.0f;
    hot.kneeDb = 0.0f;
    hot.outputGainDb = 12.0f;
    assert(finite.setConfig(hot));
    std::array<float, 12U> hostile{{
        std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::infinity(),
        std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::max(),
        -std::numeric_limits<float>::max(), std::numeric_limits<float>::infinity(),
        std::numeric_limits<float>::max(), -std::numeric_limits<float>::max(),
        std::numeric_limits<float>::quiet_NaN(), -std::numeric_limits<float>::infinity(),
        0.25f, std::numeric_limits<float>::max(),
    }};
    const float hostilePeak = finite.processInPlace(hostile.data(), 4U, 3U);
    assert(std::isfinite(hostilePeak));
    assert(hostilePeak <= 64.0f);
    for (const float sample : hostile) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) <= 64.0f);
    }
}

} // namespace

int main() {
    testValidationDefaultsAndReset();
    testSoftKneeRatioAndOutputGain();
    testStereoLinkAndMonoProcessing();
    testPeakRmsAndAttackReleaseResponse();
    testFiniteProtectionChunkInvarianceAndAllocations();
    return 0;
}
