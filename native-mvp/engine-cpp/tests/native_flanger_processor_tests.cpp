#include "native_flanger_processor.hpp"
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

void expectNear(float actual, float expected, float tolerance = 1.0e-6f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

NativeFlangerProcessorConfig audibleConfig() {
    NativeFlangerProcessorConfig config;
    config.enabled = true;
    config.delayMs = 3.0f;
    config.rateHz = 0.5f;
    config.depth = 0.8f;
    config.feedback = 0.0f;
    config.wetMix = 1.0f;
    return config;
}

void testPrepareAndCatalogSemanticsAtSupportedRates() {
    for (const unsigned int rate : {44100U, 48000U, 96000U}) {
        NativeFlangerProcessor flanger;
        assert(flanger.prepare(rate));
        assert(flanger.sampleRate() == rate);
        assert(!flanger.enabled());

        const auto config = audibleConfig();
        assert(flanger.setConfig(config, 0U));
        expectNear(flanger.delayMs(), 3.0f);
        expectNear(flanger.rateHz(), 0.5f);
        expectNear(flanger.depth(), 0.8f);
        expectNear(flanger.feedback(), 0.0f);
        expectNear(flanger.wetMix(), 1.0f);

        // The wet endpoint is finite for a hot but ordinary test signal.
        std::array<float, 32> signal{};
        signal.fill(0.25f);
        const auto peak = flanger.processInPlace(signal.data(), 16U, 2U);
        assert(std::isfinite(peak));
        for (const float sample : signal) {
            assert(std::isfinite(sample));
            assert(std::fabs(sample) < 1.0f);
        }
    }

    NativeFlangerProcessor flanger;
    assert(!flanger.prepare(0U));
    assert(!flanger.prepare(7999U));
    assert(!flanger.prepare(384001U));
    assert(flanger.prepare(48000U));
    assert(!flanger.prepare(1000U));
    assert(flanger.sampleRate() == 48000U); // Invalid re-prepare is non-destructive.
}

void testParameterValidationIsTransactional() {
    NativeFlangerProcessor flanger;
    assert(flanger.prepare(48000U));
    auto valid = audibleConfig();
    valid.delayMs = 4.5f;
    valid.rateHz = 1.25f;
    valid.depth = 0.4f;
    valid.feedback = -0.75f;
    valid.wetMix = 0.35f;
    assert(flanger.setConfig(valid, 0U));

    auto invalid = valid;
    invalid.delayMs = 0.19f;
    assert(!flanger.setConfig(invalid));
    invalid = valid;
    invalid.delayMs = 10.01f;
    assert(!flanger.setConfig(invalid));
    invalid = valid;
    invalid.rateHz = 0.049f;
    assert(!flanger.setConfig(invalid));
    invalid = valid;
    invalid.rateHz = 20.01f;
    assert(!flanger.setConfig(invalid));
    invalid = valid;
    invalid.depth = -0.01f;
    assert(!flanger.setConfig(invalid));
    invalid = valid;
    invalid.depth = 1.01f;
    assert(!flanger.setConfig(invalid));
    invalid = valid;
    invalid.feedback = 0.951f;
    assert(!flanger.setConfig(invalid));
    invalid = valid;
    invalid.feedback = -0.951f;
    assert(!flanger.setConfig(invalid));
    invalid = valid;
    invalid.wetMix = std::numeric_limits<float>::quiet_NaN();
    assert(!flanger.setConfig(invalid));

    expectNear(flanger.delayMs(), valid.delayMs);
    expectNear(flanger.rateHz(), valid.rateHz);
    expectNear(flanger.depth(), valid.depth);
    expectNear(flanger.feedback(), valid.feedback);
    expectNear(flanger.wetMix(), valid.wetMix);
}

void testModulationAndFeedbackAcrossSampleRates() {
    for (const unsigned int rate : {44100U, 48000U, 96000U}) {
        NativeFlangerProcessor modulated;
        NativeFlangerProcessor fixed;
        NativeFlangerProcessor feedback;
        assert(modulated.prepare(rate));
        assert(fixed.prepare(rate));
        assert(feedback.prepare(rate));

        auto movingConfig = audibleConfig();
        assert(modulated.setConfig(movingConfig, 0U));
        auto fixedConfig = movingConfig;
        fixedConfig.depth = 0.0f;
        assert(fixed.setConfig(fixedConfig, 0U));

        const auto frames = static_cast<std::size_t>(rate) * 2U;
        std::vector<float> tone(frames * 2U);
        for (std::size_t frame = 0U; frame < frames; ++frame) {
            const float sample = static_cast<float>(0.4 * std::sin(
                2.0 * kPi * 440.0 * static_cast<double>(frame) / static_cast<double>(rate)
            ));
            tone[frame * 2U] = sample;
            tone[frame * 2U + 1U] = sample;
        }
        auto movingOutput = tone;
        auto fixedOutput = tone;
        (void)modulated.processInPlace(movingOutput.data(), static_cast<unsigned int>(frames), 2U);
        (void)fixed.processInPlace(fixedOutput.data(), static_cast<unsigned int>(frames), 2U);

        double modulationDifferenceEnergy = 0.0;
        double stereoDifferenceEnergy = 0.0;
        double referenceEnergy = 0.0;
        for (std::size_t frame = rate / 20U; frame < frames; ++frame) {
            const double leftDifference = static_cast<double>(movingOutput[frame * 2U] - fixedOutput[frame * 2U]);
            const double stereoDifference = static_cast<double>(movingOutput[frame * 2U] - movingOutput[frame * 2U + 1U]);
            modulationDifferenceEnergy += leftDifference * leftDifference;
            stereoDifferenceEnergy += stereoDifference * stereoDifference;
            referenceEnergy += static_cast<double>(fixedOutput[frame * 2U]) * fixedOutput[frame * 2U];
        }
        assert(modulationDifferenceEnergy > referenceEnergy * 0.002);
        assert(stereoDifferenceEnergy > referenceEnergy * 0.001);
        for (const float sample : movingOutput) {
            assert(std::isfinite(sample));
            assert(std::fabs(sample) < 1.5f);
        }

        auto feedbackConfig = movingConfig;
        feedbackConfig.rateHz = 0.3f;
        feedbackConfig.depth = 0.5f;
        feedbackConfig.feedback = 0.95f;
        assert(feedback.setConfig(feedbackConfig, 0U));
        const auto tailFrames = static_cast<std::size_t>(rate) * 2U;
        std::vector<float> impulse(tailFrames * 2U, 0.0f);
        impulse[0] = 0.7f;
        impulse[1] = 0.7f;
        (void)feedback.processInPlace(impulse.data(), static_cast<unsigned int>(tailFrames), 2U);

        double earlyEnergy = 0.0;
        double lateEnergy = 0.0;
        for (std::size_t frame = rate / 10U; frame < rate / 2U; ++frame) {
            earlyEnergy += static_cast<double>(impulse[frame * 2U]) * impulse[frame * 2U];
            earlyEnergy += static_cast<double>(impulse[frame * 2U + 1U]) * impulse[frame * 2U + 1U];
        }
        for (std::size_t frame = rate * 3U / 2U; frame < tailFrames; ++frame) {
            lateEnergy += static_cast<double>(impulse[frame * 2U]) * impulse[frame * 2U];
            lateEnergy += static_cast<double>(impulse[frame * 2U + 1U]) * impulse[frame * 2U + 1U];
        }
        assert(earlyEnergy > 0.0);
        assert(lateEnergy > 0.0);
        assert(lateEnergy < earlyEnergy);
        for (const float sample : impulse) {
            assert(std::isfinite(sample));
            assert(std::fabs(sample) < 3.0f);
        }
    }
}

void testControlRampsAndBlockSegmentation() {
    constexpr unsigned int sampleRate = 48000U;
    NativeFlangerProcessor ramped;
    NativeFlangerProcessor immediate;
    assert(ramped.prepare(sampleRate));
    assert(immediate.prepare(sampleRate));
    auto startConfig = audibleConfig();
    startConfig.depth = 0.0f;
    startConfig.feedback = 0.0f;
    startConfig.wetMix = 0.0f;
    assert(ramped.setConfig(startConfig, 0U));
    assert(immediate.setConfig(startConfig, 0U));

    constexpr unsigned int primeFrames = 1024U;
    std::vector<float> prime(primeFrames * 2U);
    for (unsigned int frame = 0U; frame < primeFrames; ++frame) {
        const float sample = static_cast<float>(0.4 * std::sin(static_cast<double>(frame) * 0.071));
        prime[frame * 2U] = sample;
        prime[frame * 2U + 1U] = -sample;
    }
    auto primeRamped = prime;
    auto primeImmediate = prime;
    (void)ramped.processInPlace(primeRamped.data(), primeFrames, 2U);
    (void)immediate.processInPlace(primeImmediate.data(), primeFrames, 2U);

    auto targetConfig = startConfig;
    targetConfig.wetMix = 1.0f;
    assert(ramped.setConfig(targetConfig, 64U));
    assert(immediate.setConfig(targetConfig, 0U));

    std::array<float, 64U * 2U> rampSignal{};
    for (unsigned int frame = 0U; frame < 64U; ++frame) {
        const float sample = static_cast<float>(0.4 * std::cos(static_cast<double>(frame) * 0.13));
        rampSignal[frame * 2U] = sample;
        rampSignal[frame * 2U + 1U] = -sample;
    }
    auto immediateSignal = rampSignal;
    (void)ramped.processInPlace(rampSignal.data(), 64U, 2U);
    (void)immediate.processInPlace(immediateSignal.data(), 64U, 2U);
    const float firstFrameDifference = std::fabs(rampSignal[0] - immediateSignal[0]);
    assert(firstFrameDifference > 0.05f);
    expectNear(rampSignal[126], immediateSignal[126], 2.0e-5f);
    expectNear(rampSignal[127], immediateSignal[127], 2.0e-5f);

    NativeFlangerProcessor wholeProcessor;
    NativeFlangerProcessor chunkedProcessor;
    assert(wholeProcessor.prepare(sampleRate));
    assert(chunkedProcessor.prepare(sampleRate));
    auto config = audibleConfig();
    config.rateHz = 1.8f;
    config.depth = 0.72f;
    config.feedback = 0.4f;
    config.wetMix = 0.63f;
    assert(wholeProcessor.setConfig(config, 333U));
    assert(chunkedProcessor.setConfig(config, 333U));

    constexpr std::size_t frames = 4097U;
    std::vector<float> input(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        input[frame * 2U] = static_cast<float>(std::sin(static_cast<double>(frame) * 0.021) * 0.4);
        input[frame * 2U + 1U] = static_cast<float>(std::cos(static_cast<double>(frame) * 0.017) * 0.3);
    }
    auto whole = input;
    auto chunked = input;
    (void)wholeProcessor.processInPlace(whole.data(), static_cast<unsigned int>(frames), 2U);

    constexpr std::array<unsigned int, 7U> chunks{{1U, 63U, 64U, 255U, 511U, 1024U, 17U}};
    std::size_t offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(
            chunks[chunkIndex % chunks.size()], frames - offset
        ));
        (void)chunkedProcessor.processInPlace(chunked.data() + offset * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t sample = 0U; sample < whole.size(); ++sample) {
        expectNear(chunked[sample], whole[sample], 2.0e-6f);
    }
}

void testResetBypassExtraChannelsAndFiniteGuard() {
    NativeFlangerProcessor flanger;
    NativeFlangerProcessor fresh;
    assert(flanger.prepare(44100U));
    assert(fresh.prepare(44100U));
    auto config = audibleConfig();
    config.feedback = 0.8f;
    assert(flanger.setConfig(config, 0U));
    assert(fresh.setConfig(config, 0U));

    std::array<float, 128> initial{};
    initial[0] = 0.5f;
    initial[1] = -0.5f;
    (void)flanger.processInPlace(initial.data(), 64U, 2U);
    flanger.reset();

    std::array<float, 128> zeroAfterReset{};
    auto zeroFromFresh = zeroAfterReset;
    (void)flanger.processInPlace(zeroAfterReset.data(), 64U, 2U);
    (void)fresh.processInPlace(zeroFromFresh.data(), 64U, 2U);
    for (std::size_t index = 0U; index < zeroAfterReset.size(); ++index) {
        expectNear(zeroAfterReset[index], zeroFromFresh[index], 0.0f);
    }

    NativeFlangerProcessor bypass;
    assert(bypass.prepare(48000U));
    config.enabled = false;
    config.wetMix = 1.0f;
    assert(bypass.setConfig(config, 0U));
    std::array<float, 9> threeChannel{{0.1f, -0.2f, 0.9f, -0.4f, 0.5f, -0.8f, 0.3f, 0.7f, -0.6f}};
    const auto original = threeChannel;
    const auto peak = bypass.processInPlace(threeChannel.data(), 3U, 3U);
    assert(std::isfinite(peak));
    for (std::size_t index = 0U; index < threeChannel.size(); ++index) {
        expectNear(threeChannel[index], original[index], 0.0f);
    }

    config.enabled = true;
    config.wetMix = 1.0f;
    config.feedback = 0.95f;
    assert(bypass.setConfig(config, 0U));
    std::array<float, 6> badInputs{{std::numeric_limits<float>::quiet_NaN(),
        std::numeric_limits<float>::infinity(), 0.1f, -0.2f, -std::numeric_limits<float>::infinity(), 0.3f}};
    const auto finitePeak = bypass.processInPlace(badInputs.data(), 3U, 2U);
    assert(std::isfinite(finitePeak));
    for (const float sample : badInputs) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) <= 4.1f);
    }
}

void testProcessingDoesNotAllocate() {
    NativeFlangerProcessor flanger;
    assert(flanger.prepare(48000U));
    assert(flanger.setConfig(audibleConfig(), 128U));
    std::array<float, 512> block{};
    block.fill(0.25f);
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)flanger.processInPlace(block.data(), 256U, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
}

} // namespace

int main() {
    testPrepareAndCatalogSemanticsAtSupportedRates();
    testParameterValidationIsTransactional();
    testModulationAndFeedbackAcrossSampleRates();
    testControlRampsAndBlockSegmentation();
    testResetBypassExtraChannelsAndFiniteGuard();
    testProcessingDoesNotAllocate();
    return 0;
}
