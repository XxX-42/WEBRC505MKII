#include "native_fx_catalog.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <limits>
#include <memory>
#include <vector>

using namespace webrc::native;

namespace {

constexpr float kSafetyCeiling = 0.9660508789898133f;
constexpr double kPi = 3.141592653589793238462643383279502884;

void expectNear(float actual, float expected, float tolerance = 1.0e-5f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

void setControls(
    NativeEffectProcessor& processor,
    float thresholdDb,
    float ratio,
    float releaseMs,
    float outputDb,
    std::uint64_t rampFrames = 1U
) {
    assert(processor.setParameter("threshold_db", thresholdDb, rampFrames));
    assert(processor.setParameter("ratio", ratio, rampFrames));
    assert(processor.setParameter("release_ms", releaseMs, rampFrames));
    assert(processor.setParameter("output_db", outputDb, rampFrames));
}

std::vector<float> makeTone(unsigned int frames, unsigned int sampleRate, double frequencyHz, float amplitude) {
    std::vector<float> samples(static_cast<std::size_t>(frames) * 2U);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float sample = static_cast<float>(static_cast<double>(amplitude) * std::sin(
            2.0 * kPi * frequencyHz * static_cast<double>(frame) / static_cast<double>(sampleRate)));
        samples[static_cast<std::size_t>(frame) * 2U] = sample;
        samples[static_cast<std::size_t>(frame) * 2U + 1U] = sample;
    }
    return samples;
}

double channelRms(const std::vector<float>& samples, unsigned int channel, unsigned int beginFrame, unsigned int endFrame) {
    double energy = 0.0;
    for (unsigned int frame = beginFrame; frame < endFrame; ++frame) {
        const double sample = samples[static_cast<std::size_t>(frame) * 2U + channel];
        energy += sample * sample;
    }
    return std::sqrt(energy / static_cast<double>(endFrame - beginFrame));
}

void testDescriptorFactoryAndBounds() {
    const auto* descriptor = findNativeEffectDescriptor("sustainer");
    assert(descriptor != nullptr);
    assert(descriptor->sourceIndex == 11);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    auto processor = createNativeEffectProcessor("sustainer");
    assert(processor != nullptr && processor->stableId() == "sustainer");
    assert(processor->prepare(48000U));

    const auto* threshold = findNativeEffectParameter("sustainer", "threshold_db");
    const auto* ratio = findNativeEffectParameter("sustainer", "ratio");
    const auto* release = findNativeEffectParameter("sustainer", "release_ms");
    const auto* output = findNativeEffectParameter("sustainer", "output_db");
    assert(threshold != nullptr && threshold->minimum == -60.0f && threshold->maximum == 0.0f && threshold->defaultValue == -24.0f);
    assert(ratio != nullptr && ratio->minimum == 1.0f && ratio->maximum == 20.0f && ratio->defaultValue == 4.0f);
    assert(release != nullptr && release->minimum == 10.0f && release->maximum == 1000.0f && release->defaultValue == 180.0f);
    assert(output != nullptr && output->minimum == -24.0f && output->maximum == 12.0f && output->defaultValue == 0.0f);

    assert(!processor->setParameter("threshold_db", -60.01f));
    assert(!processor->setParameter("threshold_db", 0.01f));
    assert(!processor->setParameter("ratio", 0.99f));
    assert(!processor->setParameter("ratio", 20.01f));
    assert(!processor->setParameter("release_ms", 9.99f));
    assert(!processor->setParameter("release_ms", 1000.01f));
    assert(!processor->setParameter("output_db", -24.01f));
    assert(!processor->setParameter("output_db", 12.01f));
    assert(!processor->setParameter("output_db", std::numeric_limits<float>::quiet_NaN()));
    assert(!processor->setParameter("not_a_control", 1.0f));

    assert(processor->setParameter("threshold_db", -60.0f, 1U));
    assert(processor->setParameter("ratio", 1.0f, 1U));
    assert(processor->setParameter("release_ms", 10.0f, 1U));
    assert(processor->setParameter("output_db", 12.0f, 1U));
}

void testUpwardDownwardCompressionAndGate() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int settleFrames = 24000U;

    auto upward = createNativeEffectProcessor("sustainer");
    assert(upward != nullptr && upward->prepare(sampleRate));
    setControls(*upward, -24.0f, 4.0f, 180.0f, 0.0f);
    auto quiet = makeTone(settleFrames, sampleRate, 997.0, 0.01f);
    (void)upward->processInPlace(quiet.data(), settleFrames, 2U);
    const double quietInputRms = channelRms(makeTone(2048U, sampleRate, 997.0, 0.01f), 0U, 0U, 2048U);
    const double quietOutputRms = channelRms(quiet, 0U, settleFrames - 4096U, settleFrames);
    assert(quietOutputRms > quietInputRms * 2.5); // below threshold, but above gate-open threshold

    auto downward = createNativeEffectProcessor("sustainer");
    assert(downward != nullptr && downward->prepare(sampleRate));
    setControls(*downward, -24.0f, 4.0f, 180.0f, 0.0f);
    auto loud = makeTone(settleFrames, sampleRate, 997.0, 0.5f);
    (void)downward->processInPlace(loud.data(), settleFrames, 2U);
    const double loudInputRms = channelRms(makeTone(4096U, sampleRate, 997.0, 0.5f), 0U, 0U, 4096U);
    const double loudOutputRms = channelRms(loud, 0U, settleFrames - 4096U, settleFrames);
    assert(loudOutputRms < loudInputRms * 0.55);
    assert(loudOutputRms > loudInputRms * 0.08);
    const double leftRms = channelRms(loud, 0U, settleFrames - 4096U, settleFrames);
    const double rightRms = channelRms(loud, 1U, settleFrames - 4096U, settleFrames);
    assert(std::fabs(leftRms - rightRms) < 1.0e-7); // stereo-linked gain preserves image

    auto gate = createNativeEffectProcessor("sustainer");
    assert(gate != nullptr && gate->prepare(sampleRate));
    setControls(*gate, -24.0f, 4.0f, 180.0f, 0.0f);
    std::vector<float> belowGate(12000U * 2U, 0.001f);
    (void)gate->processInPlace(belowGate.data(), 12000U, 2U);
    assert(channelRms(belowGate, 0U, 10000U, 12000U) < 1.0e-5);
    std::vector<float> aboveGate(12000U * 2U, 0.01f);
    (void)gate->processInPlace(aboveGate.data(), 12000U, 2U);
    assert(channelRms(aboveGate, 0U, 10000U, 12000U) > 0.02);
}

void testLookaheadLatencyAndSafetyLimiter() {
    for (const unsigned int sampleRate : {48000U, 192000U}) {
        const unsigned int lookaheadFrames = sampleRate / 1000U;
        auto processor = createNativeEffectProcessor("sustainer");
        assert(processor != nullptr && processor->prepare(sampleRate));
        setControls(*processor, -60.0f, 1.0f, 180.0f, 0.0f);
        std::vector<float> impulse(static_cast<std::size_t>(lookaheadFrames + 8U) * 2U, 0.0f);
        impulse[0] = 1.0f;
        impulse[1] = 1.0f;
        (void)processor->processInPlace(impulse.data(), lookaheadFrames + 8U, 2U);
        for (unsigned int frame = 0U; frame < lookaheadFrames; ++frame) {
            expectNear(impulse[static_cast<std::size_t>(frame) * 2U], 0.0f, 0.0f);
        }
        assert(impulse[static_cast<std::size_t>(lookaheadFrames) * 2U] > 0.0f);
    }

    auto limiter = createNativeEffectProcessor("sustainer");
    assert(limiter != nullptr && limiter->prepare(48000U));
    setControls(*limiter, 0.0f, 1.0f, 180.0f, 12.0f);
    constexpr unsigned int frames = 12000U;
    std::vector<float> loud(static_cast<std::size_t>(frames) * 2U, 1.0f);
    const float peak = limiter->processInPlace(loud.data(), frames, 2U);
    assert(std::isfinite(peak) && peak <= kSafetyCeiling + 1.0e-6f);
    assert(peak > kSafetyCeiling * 0.98f);
    for (const float sample : loud) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) <= kSafetyCeiling + 1.0e-6f);
    }
}

void testSmoothedControlChunkInvarianceAndNoAllocation() {
    constexpr unsigned int sampleRate = 44100U;
    constexpr unsigned int frames = 15037U;
    auto whole = createNativeEffectProcessor("sustainer");
    auto chunked = createNativeEffectProcessor("sustainer");
    assert(whole != nullptr && chunked != nullptr);
    assert(whole->prepare(sampleRate) && chunked->prepare(sampleRate));
    setControls(*whole, -35.0f, 12.0f, 450.0f, 4.5f, 733U);
    setControls(*chunked, -35.0f, 12.0f, 450.0f, 4.5f, 733U);
    auto input = makeTone(frames, sampleRate, 431.0, 0.42f);
    auto wholeOutput = input;
    auto chunkedOutput = input;

    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    const float peak = whole->processInPlace(wholeOutput.data(), frames, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
    assert(std::isfinite(peak));

    constexpr std::array<unsigned int, 7U> chunks{{1U, 17U, 63U, 64U, 255U, 511U, 1024U}};
    std::size_t offsetFrames = 0U;
    std::size_t chunkIndex = 0U;
    while (offsetFrames < frames) {
        const unsigned int count = static_cast<unsigned int>(std::min<std::size_t>(
            chunks[chunkIndex % chunks.size()], frames - offsetFrames));
        (void)chunked->processInPlace(chunkedOutput.data() + offsetFrames * 2U, count, 2U);
        offsetFrames += count;
        ++chunkIndex;
    }
    for (std::size_t index = 0U; index < wholeOutput.size(); ++index) {
        assert(std::isfinite(wholeOutput[index]));
        expectNear(wholeOutput[index], chunkedOutput[index], 0.0f);
    }
}

} // namespace

int main() {
    testDescriptorFactoryAndBounds();
    testUpwardDownwardCompressionAndGate();
    testLookaheadLatencyAndSafetyLimiter();
    testSmoothedControlChunkInvarianceAndNoAllocation();
}
