#include "native_autopan_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <vector>

using namespace webrc::native;

namespace {

void expectNear(float actual, float expected, float tolerance = 1.0e-5f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

void testPrepareBypassAndConfigurationBounds() {
    NativeAutoPanProcessor autoPan;
    assert(!autoPan.prepare(7999U));
    assert(autoPan.prepare(48000U));
    assert(autoPan.sampleRate() == 48000U);
    assert(!autoPan.enabled());

    NativeAutoPanConfig config;
    config.rateHz = 0.05f;
    config.depth = 1.0f;
    config.enabled = false;
    config.wetMix = 1.0f;
    assert(autoPan.setConfig(config, 0U));
    std::array<float, 12> samples{{0.1f, -0.2f, 0.3f, -0.4f, 0.5f, -0.6f,
                                   0.7f, -0.8f, 0.9f, -1.0f, 1.1f, -1.2f}};
    const auto dry = samples;
    expectNear(autoPan.processInPlace(samples.data(), 6U, 2U), 1.2f);
    for (std::size_t index = 0; index < samples.size(); ++index) {
        expectNear(samples[index], dry[index], 0.0f);
    }

    auto invalid = config;
    invalid.rateHz = 0.049f;
    assert(!autoPan.setConfig(invalid));
    invalid = config;
    invalid.depth = 1.01f;
    assert(!autoPan.setConfig(invalid));
    invalid = config;
    invalid.waveform = static_cast<NativeAutoPanWaveform>(99);
    assert(!autoPan.setConfig(invalid));
    invalid = config;
    invalid.algorithm = static_cast<NativeAutoPanAlgorithm>(99);
    assert(!autoPan.setConfig(invalid));
}

void testMonoEqualPowerAndStereoMidSideSemantics() {
    constexpr unsigned int sampleRate = 8000U;
    constexpr unsigned int quarterCycle = sampleRate / 4U;
    NativeAutoPanConfig config;
    config.enabled = true;
    config.rateHz = 1.0f;
    config.depth = 1.0f;
    config.waveform = NativeAutoPanWaveform::Sine;
    config.wetMix = 1.0f;

    NativeAutoPanProcessor monoPan;
    assert(monoPan.prepare(sampleRate));
    assert(monoPan.setConfig(config, 0U));
    std::vector<float> mono(quarterCycle + 1U, 0.5f);
    std::vector<float> stereo((quarterCycle + 1U) * 2U, 0.0f);
    (void)monoPan.processMonoToStereo(mono.data(), stereo.data(), static_cast<unsigned int>(mono.size()));
    expectNear(stereo[quarterCycle * 2U], 0.0f, 2.0e-4f);
    expectNear(stereo[(quarterCycle * 2U) + 1U], 0.5f, 2.0e-4f);
    expectNear(stereo[quarterCycle * 2U] * stereo[quarterCycle * 2U] +
        stereo[(quarterCycle * 2U) + 1U] * stereo[(quarterCycle * 2U) + 1U], 0.25f, 2.0e-4f);

    NativeAutoPanProcessor stereoPan;
    assert(stereoPan.prepare(sampleRate));
    assert(stereoPan.setConfig(config, 0U));
    std::vector<float> equalStereo((quarterCycle + 1U) * 2U, 0.5f);
    (void)stereoPan.processInPlace(equalStereo.data(), quarterCycle + 1U, 2U);
    expectNear(equalStereo[quarterCycle * 2U], 0.0f, 3.0e-4f);
    expectNear(equalStereo[(quarterCycle * 2U) + 1U], 0.5f * 1.41421356f, 3.0e-4f);

    NativeAutoPanProcessor sidePan;
    assert(sidePan.prepare(sampleRate));
    assert(sidePan.setConfig(config, 0U));
    std::vector<float> antiPhase((quarterCycle + 1U) * 2U);
    for (std::size_t frame = 0U; frame < antiPhase.size() / 2U; ++frame) {
        antiPhase[frame * 2U] = 0.5f;
        antiPhase[(frame * 2U) + 1U] = -0.5f;
    }
    (void)sidePan.processInPlace(antiPhase.data(), quarterCycle + 1U, 2U);
    expectNear(antiPhase[quarterCycle * 2U], 0.0f, 3.0e-4f);
    expectNear(antiPhase[(quarterCycle * 2U) + 1U], 0.0f, 3.0e-4f);
}

void testBlockSegmentationSmoothingAndAllocationFreeProcessing() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = 8192U;
    NativeAutoPanProcessor wholeProcessor;
    NativeAutoPanProcessor chunkedProcessor;
    assert(wholeProcessor.prepare(sampleRate));
    assert(chunkedProcessor.prepare(sampleRate));
    NativeAutoPanConfig config;
    config.enabled = true;
    config.rateHz = 4.0f;
    config.depth = 0.85f;
    config.waveform = NativeAutoPanWaveform::Triangle;
    config.wetMix = 0.72f;
    assert(wholeProcessor.setConfig(config, 333U));
    assert(chunkedProcessor.setConfig(config, 333U));

    std::vector<float> input(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        input[frame * 2U] = static_cast<float>(std::sin(static_cast<double>(frame) * 0.021) * 0.4);
        input[(frame * 2U) + 1U] = static_cast<float>(std::cos(static_cast<double>(frame) * 0.017) * 0.3);
    }
    auto whole = input;
    auto chunked = input;
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)wholeProcessor.processInPlace(whole.data(), static_cast<unsigned int>(frames), 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);

    constexpr std::array<unsigned int, 7> chunks{{1U, 63U, 64U, 127U, 255U, 511U, 1024U}};
    std::size_t offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(chunks[chunkIndex % chunks.size()], frames - offset));
        (void)chunkedProcessor.processInPlace(chunked.data() + offset * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t sample = 0U; sample < whole.size(); ++sample) {
        expectNear(chunked[sample], whole[sample]);
    }

    NativeAutoPanProcessor callbackProcessor;
    assert(callbackProcessor.prepare(sampleRate));
    assert(callbackProcessor.setConfig(config, 64U));
    std::array<float, 256> callbackBlock{};
    callbackBlock.fill(0.25f);
    const auto callbackAllocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)callbackProcessor.processInPlace(callbackBlock.data(), 128U, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == callbackAllocationsBefore);
    for (const float sample : callbackBlock) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) < 1.0f);
    }
}

void testWaveformTransitionAndExtraChannelPassThrough() {
    NativeAutoPanProcessor autoPan;
    assert(autoPan.prepare(44100U));
    NativeAutoPanConfig config;
    config.enabled = true;
    config.rateHz = 20.0f;
    config.depth = 1.0f;
    config.waveform = NativeAutoPanWaveform::Square;
    config.wetMix = 1.0f;
    assert(autoPan.setConfig(config, 64U));
    std::array<float, 192> samples{};
    for (std::size_t frame = 0U; frame < samples.size() / 3U; ++frame) {
        samples[frame * 3U] = 0.2f;
        samples[(frame * 3U) + 1U] = -0.4f;
        samples[(frame * 3U) + 2U] = 0.75f;
    }
    (void)autoPan.processInPlace(samples.data(), 64U, 3U);
    for (std::size_t frame = 0U; frame < samples.size() / 3U; ++frame) {
        expectNear(samples[(frame * 3U) + 2U], 0.75f, 0.0f);
        assert(std::isfinite(samples[frame * 3U]));
        assert(std::isfinite(samples[(frame * 3U) + 1U]));
    }
}

} // namespace

int main() {
    testPrepareBypassAndConfigurationBounds();
    testMonoEqualPowerAndStereoMidSideSemantics();
    testBlockSegmentationSmoothingAndAllocationFreeProcessing();
    testWaveformTransitionAndExtraChannelPassThrough();
    return 0;
}
