#include "native_output_stage.hpp"

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

void testCallbackPipelineKeepsLoopDryAndFiltersOutput() {
    LooperCore looper(48000, 1);
    NativeOutputStage outputStage;
    assert(outputStage.prepare(48000));
    outputStage.setLowPassEnabled(false, 0);

    const std::array<float, 4> take{{0.25f, -0.5f, 0.75f, -0.25f}};
    const std::array<float, 4> silence{};
    std::array<float, 8> output{};

    looper.applyCommand({CommandType::Record, false});
    const auto recordStats = processNativeAudioBlock(
        looper, outputStage, take.data(), output.data(), 4, 1, 2
    );
    assert(recordStats.state == LooperState::Recording);
    expectNear(recordStats.inputPeak, 0.75f);
    expectNear(recordStats.outputPeak, 0.0f);
    for (const float sample : output) {
        expectNear(sample, 0.0f);
    }

    looper.applyCommand({CommandType::StopRecordOrPlayback, false});
    looper.applyCommand({CommandType::Play, false});
    const auto dryStats = processNativeAudioBlock(
        looper, outputStage, silence.data(), output.data(), 4, 1, 2
    );
    assert(dryStats.state == LooperState::Playing);
    std::array<float, 8> dryPlayback{};
    dryPlayback = output;
    for (std::size_t frame = 0; frame < take.size(); ++frame) {
        expectNear(dryPlayback[frame * 2], take[frame]);
        expectNear(dryPlayback[frame * 2 + 1], take[frame]);
    }

    // A queued callback command reaches this same pipeline stage; the smoother
    // moves wet mix over four frames while the two fixed filters run in place.
    looper.applyCommand({CommandType::StopRecordOrPlayback, false});
    looper.applyCommand({CommandType::Play, false});
    outputStage.setLowPassEnabled(true, 4);
    const auto filteredStats = processNativeAudioBlock(
        looper, outputStage, silence.data(), output.data(), 4, 1, 2
    );
    assert(filteredStats.state == LooperState::Playing);
    assert(outputStage.lowPassEnabled());
    bool changed = false;
    float measuredPeak = 0.0f;
    for (std::size_t i = 0; i < output.size(); ++i) {
        assert(std::isfinite(output[i]));
        if (std::fabs(output[i] - dryPlayback[i]) > 1.0e-4f) {
            changed = true;
        }
        measuredPeak = std::max(measuredPeak, std::fabs(output[i]));
        if ((i % 2) == 0) {
            expectNear(output[i], output[i + 1]);
        }
    }
    assert(changed);
    expectNear(filteredStats.outputPeak, measuredPeak);

    // Disabling the output stage restores the same recorded samples, proving
    // post-processing was not written back into the loop buffer.
    looper.applyCommand({CommandType::StopRecordOrPlayback, false});
    looper.applyCommand({CommandType::Play, false});
    outputStage.setLowPassEnabled(false, 0);
    const auto replayStats = processNativeAudioBlock(
        looper, outputStage, silence.data(), output.data(), 4, 1, 2
    );
    assert(replayStats.state == LooperState::Playing);
    for (std::size_t i = 0; i < output.size(); ++i) {
        expectNear(output[i], dryPlayback[i]);
    }
}

void testCatalogBankOnlyProcessesLoopPlayback() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = 64U;
    LooperCore dryLooper(sampleRate, 1U);
    LooperCore fxLooper(sampleRate, 1U);
    NativeOutputStage dryOutputStage;
    NativeOutputStage fxOutputStage;
    assert(dryOutputStage.prepare(sampleRate));
    assert(fxOutputStage.prepare(sampleRate));
    auto& trackFxBank = fxOutputStage.trackFxBank();
    assert(trackFxBank.setEffect(NativeEffectSlot::A, "filter.lpf"));
    assert(trackFxBank.setParameter(NativeEffectSlot::A, "cutoff_hz", 300.0f, 1U));
    assert(trackFxBank.setParameter(NativeEffectSlot::A, "resonance_percent", 15.0f, 1U));

    std::array<float, frames> take{};
    take[0] = 0.7f;
    take[1] = -0.35f;
    std::array<float, frames> live{};
    live.fill(0.1f);
    std::array<float, frames * 2U> dryOutput{};
    std::array<float, frames * 2U> fxOutput{};
    float* const playbackScratch = fxOutputStage.playbackOnlyScratch();

    dryLooper.applyCommand({CommandType::SetMonitoring, true});
    fxLooper.applyCommand({CommandType::SetMonitoring, true});
    dryLooper.applyCommand({CommandType::Record, false});
    fxLooper.applyCommand({CommandType::Record, false});
    (void)processNativeAudioBlock(dryLooper, dryOutputStage, take.data(), dryOutput.data(), frames, 1U, 2U);
    (void)processNativeAudioBlock(
        fxLooper, fxOutputStage, take.data(), fxOutput.data(), frames, 1U, 2U,
        nullptr, 0U
    );

    // Track FX is playback-only: recording-time monitoring remains unchanged.
    for (std::size_t frame = 0; frame < frames; ++frame) {
        expectNear(dryOutput[frame * 2U], take[frame]);
        expectNear(fxOutput[frame * 2U], take[frame]);
        expectNear(playbackScratch[frame * 2U], 0.0f);
    }

    dryLooper.applyCommand({CommandType::StopRecordOrPlayback, false});
    fxLooper.applyCommand({CommandType::StopRecordOrPlayback, false});
    dryLooper.applyCommand({CommandType::Play, false});
    fxLooper.applyCommand({CommandType::Play, false});
    dryOutput.fill(0.0f);
    fxOutput.fill(0.0f);
    (void)processNativeAudioBlock(dryLooper, dryOutputStage, live.data(), dryOutput.data(), frames, 1U, 2U);
    (void)processNativeAudioBlock(
        fxLooper, fxOutputStage, live.data(), fxOutput.data(), frames, 1U, 2U,
        nullptr, 0U
    );

    bool effectChangedLoop = false;
    for (std::size_t frame = 0; frame < frames; ++frame) {
        const std::size_t left = frame * 2U;
        expectNear(fxOutput[left], playbackScratch[left] + live[frame], 1.0e-5f);
        expectNear(fxOutput[left + 1U], playbackScratch[left + 1U] + live[frame], 1.0e-5f);
        expectNear(fxOutput[left] - dryOutput[left], playbackScratch[left] - (frame == 0U ? take[0] : (frame == 1U ? take[1] : 0.0f)), 1.0e-5f);
        effectChangedLoop = effectChangedLoop || std::fabs(playbackScratch[left] - take[frame]) > 1.0e-5f;
    }
    assert(effectChangedLoop);
}

void testOutputStagePreparationAndPassThroughChannels() {
    NativeOutputStage stage;
    assert(!stage.prepare(0));
    assert(stage.prepare(44100));
    assert(stage.sampleRate() == 44100);

    // Bypass is a true linear pass-through, including finite values above
    // full scale; limiting is not implicitly part of the low-pass stage.
    std::array<float, 4> aboveFullScale{{1.25f, -1.5f, 0.8f, -0.7f}};
    stage.setLowPassEnabled(false, 0);
    const auto passThroughPeak = stage.processInPlace(aboveFullScale.data(), 2, 2);
    expectNear(aboveFullScale[0], 1.25f, 0.0f);
    expectNear(aboveFullScale[1], -1.5f, 0.0f);
    expectNear(aboveFullScale[2], 0.8f, 0.0f);
    expectNear(aboveFullScale[3], -0.7f, 0.0f);
    expectNear(passThroughPeak, 1.5f, 0.0f);

    // Extra channels are left alone; the native MVP itself uses stereo output.
    std::array<float, 6> threeChannels{{0.1f, 0.2f, 0.3f, -0.1f, -0.2f, -0.3f}};
    (void)stage.processInPlace(threeChannels.data(), 2, 3);
    expectNear(threeChannels[2], 0.3f);
    expectNear(threeChannels[5], -0.3f);
}

void testExplicitHighPassEffect() {
    NativeOutputStage highPass;
    assert(highPass.prepare(48000));
    highPass.setHighPassEnabled(true, 0);
    std::array<float, 2048> dc{};
    dc.fill(0.5f);
    (void)highPass.processInPlace(dc.data(), 1024, 2);
    assert(std::fabs(dc.back()) < 0.02f);

}

void testFdn16ImpulseAndTailAtCommonSampleRates() {
    for (const unsigned int sampleRate : {44100U, 48000U, 96000U}) {
        NativeOutputStage stage;
        assert(stage.prepare(sampleRate));
        NativeReverbConfig config;
        config.enabled = true;
        config.wetMix = 1.0f;
        config.rt60Seconds = 1.2f;
        assert(stage.setReverbConfig(config, 0));

        const auto frames = static_cast<std::size_t>(sampleRate) * 3U;
        std::vector<float> impulse(frames * 2U, 0.0f);
        impulse[0] = 1.0f;
        impulse[1] = -0.5f;
        (void)stage.processInPlace(impulse.data(), static_cast<unsigned int>(frames), 2U);

        for (const float sample : impulse) {
            assert(std::isfinite(sample));
            assert(std::fabs(sample) < 2.0f);
        }
        const auto firstWetFrame = NativeOutputStage::reverbMinimumDelayFramesForSampleRate(sampleRate);
        assert(stage.reverbMinimumDelayFrames() == firstWetFrame);
        for (std::size_t frame = 0; frame < firstWetFrame; ++frame) {
            expectNear(impulse[frame * 2U], 0.0f, 0.0f);
            expectNear(impulse[frame * 2U + 1U], 0.0f, 0.0f);
        }
        const auto firstWetIndex = static_cast<std::size_t>(firstWetFrame) * 2U;
        assert(std::fabs(impulse[firstWetIndex]) > 1.0e-3f);
        assert(std::fabs(impulse[firstWetIndex + 1U]) > 1.0e-3f);

        double earlyEnergy = 0.0;
        double lateEnergy = 0.0;
        const auto earlyBegin = static_cast<std::size_t>(sampleRate) / 5U;
        const auto earlyEnd = static_cast<std::size_t>(sampleRate) / 2U;
        const auto lateBegin = static_cast<std::size_t>(sampleRate) * 2U;
        const auto lateEnd = static_cast<std::size_t>(sampleRate) * 5U / 2U;
        for (std::size_t frame = earlyBegin; frame < earlyEnd; ++frame) {
            earlyEnergy += static_cast<double>(impulse[frame * 2U]) * impulse[frame * 2U];
            earlyEnergy += static_cast<double>(impulse[frame * 2U + 1U]) * impulse[frame * 2U + 1U];
        }
        for (std::size_t frame = lateBegin; frame < lateEnd; ++frame) {
            lateEnergy += static_cast<double>(impulse[frame * 2U]) * impulse[frame * 2U];
            lateEnergy += static_cast<double>(impulse[frame * 2U + 1U]) * impulse[frame * 2U + 1U];
        }
        assert(earlyEnergy > 1.0e-5);
        assert(lateEnergy < earlyEnergy);
    }
}

void testFdn16BlockSegmentationInvarianceAndDryBypass() {
    constexpr unsigned int sampleRate = 48000;
    constexpr std::size_t frames = 4096;
    std::vector<float> input(frames * 2U, 0.0f);
    for (std::size_t frame = 0; frame < frames; ++frame) {
        input[frame * 2U] = frame == 0U ? 1.0f : static_cast<float>(std::sin(static_cast<double>(frame) * 0.013) * 0.1);
        input[frame * 2U + 1U] = frame == 0U ? -0.5f : static_cast<float>(std::cos(static_cast<double>(frame) * 0.017) * 0.08);
    }

    NativeOutputStage wholeStage;
    NativeOutputStage chunkedStage;
    assert(wholeStage.prepare(sampleRate));
    assert(chunkedStage.prepare(sampleRate));
    NativeReverbConfig config;
    config.enabled = true;
    config.wetMix = 0.65f;
    config.rt60Seconds = 2.5f;
    assert(wholeStage.setReverbConfig(config, 128));
    assert(chunkedStage.setReverbConfig(config, 128));

    auto whole = input;
    auto chunked = input;
    (void)wholeStage.processInPlace(whole.data(), static_cast<unsigned int>(frames), 2U);
    constexpr std::array<unsigned int, 7> chunks{{1U, 63U, 64U, 127U, 256U, 511U, 1024U}};
    std::size_t offset = 0;
    std::size_t chunkIndex = 0;
    while (offset < frames) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(chunks[chunkIndex % chunks.size()], frames - offset));
        (void)chunkedStage.processInPlace(chunked.data() + offset * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t sample = 0; sample < whole.size(); ++sample) {
        expectNear(chunked[sample], whole[sample], 1.0e-6f);
    }

    NativeOutputStage bypass;
    assert(bypass.prepare(sampleRate));
    auto untouched = input;
    (void)bypass.processInPlace(untouched.data(), static_cast<unsigned int>(frames), 2U);
    for (std::size_t sample = 0; sample < untouched.size(); ++sample) {
        expectNear(untouched[sample], input[sample], 0.0f);
    }
}

void testReverbDoesNotWriteIntoLooperStorage() {
    LooperCore looper(48000, 1);
    NativeOutputStage outputStage;
    assert(outputStage.prepare(48000));
    const std::array<float, 4> take{{0.25f, -0.5f, 0.75f, -0.25f}};
    const std::array<float, 4> silence{};
    std::array<float, 8> output{};

    looper.applyCommand({CommandType::Record, false});
    (void)processNativeAudioBlock(looper, outputStage, take.data(), output.data(), 4, 1, 2);
    looper.applyCommand({CommandType::StopRecordOrPlayback, false});
    looper.applyCommand({CommandType::Play, false});
    (void)processNativeAudioBlock(looper, outputStage, silence.data(), output.data(), 4, 1, 2);
    const auto original = output;

    looper.applyCommand({CommandType::StopRecordOrPlayback, false});
    looper.applyCommand({CommandType::Play, false});
    NativeReverbConfig config;
    config.enabled = true;
    config.wetMix = 1.0f;
    assert(outputStage.setReverbConfig(config, 0));
    NativeFractionalDelayConfig delayConfig;
    delayConfig.enabled = true;
    delayConfig.wetMix = 1.0f;
    delayConfig.delayMs = 20.25f;
    assert(outputStage.setFractionalDelayConfig(delayConfig, 0));
    (void)processNativeAudioBlock(looper, outputStage, silence.data(), output.data(), 4, 1, 2);

    config.enabled = false;
    assert(outputStage.setReverbConfig(config, 0));
    delayConfig.enabled = false;
    assert(outputStage.setFractionalDelayConfig(delayConfig, 0));
    looper.applyCommand({CommandType::StopRecordOrPlayback, false});
    looper.applyCommand({CommandType::Play, false});
    (void)processNativeAudioBlock(looper, outputStage, silence.data(), output.data(), 4, 1, 2);
    for (std::size_t sample = 0; sample < output.size(); ++sample) {
        expectNear(output[sample], original[sample], 0.0f);
    }
}

void testFractionalDelayImpulseAndFeedbackStability() {
    for (const unsigned int sampleRate : {44100U, 48000U, 96000U}) {
        NativeOutputStage stage;
        assert(stage.prepare(sampleRate));
        NativeFractionalDelayConfig config;
        config.enabled = true;
        config.slot = NativeTrackOutputSlot::A;
        config.algorithm = NativeFractionalDelayAlgorithm::Lagrange4;
        config.delayMs = 12.5f;
        config.wetMix = 1.0f;
        config.feedback = 0.75f;
        assert(stage.setFractionalDelayConfig(config, 0));

        const auto frames = static_cast<std::size_t>(sampleRate) * 2U;
        std::vector<float> impulse(frames * 2U, 0.0f);
        impulse[0] = 1.0f;
        impulse[1] = -0.5f;
        (void)stage.processInPlace(impulse.data(), static_cast<unsigned int>(frames), 2U);
        const auto echoFrame = static_cast<std::size_t>(std::round(0.0125 * static_cast<double>(sampleRate)));
        assert(std::fabs(impulse[echoFrame * 2U]) > 0.5f);
        assert(std::fabs(impulse[echoFrame * 2U + 1U]) > 0.25f);

        double earlyEnergy = 0.0;
        double lateEnergy = 0.0;
        for (std::size_t frame = echoFrame - 4U; frame < echoFrame + 5U; ++frame) {
            earlyEnergy += static_cast<double>(impulse[frame * 2U]) * impulse[frame * 2U];
            earlyEnergy += static_cast<double>(impulse[frame * 2U + 1U]) * impulse[frame * 2U + 1U];
        }
        const auto lateBegin = static_cast<std::size_t>(sampleRate);
        const auto lateEnd = lateBegin + static_cast<std::size_t>(sampleRate) / 2U;
        for (std::size_t frame = lateBegin; frame < lateEnd; ++frame) {
            lateEnergy += static_cast<double>(impulse[frame * 2U]) * impulse[frame * 2U];
            lateEnergy += static_cast<double>(impulse[frame * 2U + 1U]) * impulse[frame * 2U + 1U];
        }
        assert(earlyEnergy > 0.0);
        assert(lateEnergy < earlyEnergy);
        for (const float sample : impulse) {
            assert(std::isfinite(sample));
            assert(std::fabs(sample) < 2.0f);
        }
    }

    NativeOutputStage invalid;
    assert(invalid.prepare(48000));
    NativeFractionalDelayConfig unsupportedSlot;
    unsupportedSlot.slot = NativeTrackOutputSlot::B;
    assert(!invalid.setFractionalDelayConfig(unsupportedSlot));
    NativeFractionalDelayConfig invalidFeedback;
    invalidFeedback.feedback = 0.96f;
    assert(!invalid.setFractionalDelayConfig(invalidFeedback));
}

void testFractionalDelayBlockSegmentationInvariance() {
    constexpr unsigned int sampleRate = 48000;
    constexpr std::size_t frames = 8192;
    std::vector<float> input(frames * 2U, 0.0f);
    for (std::size_t frame = 0; frame < frames; ++frame) {
        input[frame * 2U] = frame == 0U ? 1.0f : static_cast<float>(std::sin(static_cast<double>(frame) * 0.011) * 0.1);
        input[frame * 2U + 1U] = frame == 0U ? -0.5f : static_cast<float>(std::cos(static_cast<double>(frame) * 0.019) * 0.08);
    }

    NativeOutputStage wholeStage;
    NativeOutputStage chunkedStage;
    assert(wholeStage.prepare(sampleRate));
    assert(chunkedStage.prepare(sampleRate));
    NativeFractionalDelayConfig config;
    config.enabled = true;
    config.delayMs = 197.3f;
    config.wetMix = 0.55f;
    config.feedback = 0.6f;
    assert(wholeStage.setFractionalDelayConfig(config, 128));
    assert(chunkedStage.setFractionalDelayConfig(config, 128));

    auto whole = input;
    auto chunked = input;
    (void)wholeStage.processInPlace(whole.data(), static_cast<unsigned int>(frames), 2U);
    constexpr std::array<unsigned int, 6> chunks{{1U, 63U, 64U, 255U, 511U, 1024U}};
    std::size_t offset = 0;
    std::size_t chunkIndex = 0;
    while (offset < frames) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(chunks[chunkIndex % chunks.size()], frames - offset));
        (void)chunkedStage.processInPlace(chunked.data() + offset * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t sample = 0; sample < whole.size(); ++sample) {
        expectNear(chunked[sample], whole[sample], 1.0e-6f);
    }
}

void testNativePeakCompressorBehaviorAndBlockInvariance() {
    constexpr unsigned int sampleRate = 48000;
    NativeOutputStage bypass;
    assert(bypass.prepare(sampleRate));
    std::array<float, 4> dry{{1.25f, -0.8f, 1.1f, -0.6f}};
    const auto original = dry;
    (void)bypass.processInPlace(dry.data(), 2U, 2U);
    for (std::size_t sample = 0; sample < dry.size(); ++sample) {
        expectNear(dry[sample], original[sample], 0.0f);
    }

    NativeCompressorConfig config;
    config.enabled = true;
    config.slot = NativeTrackOutputSlot::A;
    config.algorithm = NativeCompressorAlgorithm::PeakCompressor;
    config.thresholdDb = -18.0f;
    config.ratio = 4.0f;
    config.attackMs = 0.1f;
    config.releaseMs = 20.0f;
    config.wetMix = 1.0f;
    config.makeupDb = 0.0f;

    NativeOutputStage compressor;
    assert(compressor.prepare(sampleRate));
    assert(compressor.setCompressorConfig(config, 0U));
    constexpr std::size_t settleFrames = sampleRate / 4U;
    std::vector<float> sustained(settleFrames * 2U, 0.0f);
    for (std::size_t frame = 0; frame < settleFrames; ++frame) {
        sustained[frame * 2U] = 0.8f;
        sustained[frame * 2U + 1U] = 0.4f;
    }
    (void)compressor.processInPlace(sustained.data(), static_cast<unsigned int>(settleFrames), 2U);
    const float compressedLeft = sustained[sustained.size() - 2U];
    const float compressedRight = sustained.back();
    assert(std::fabs(compressedLeft) < 0.3f);
    assert(std::fabs(compressedRight) < 0.15f);
    expectNear(compressedLeft / compressedRight, 2.0f, 1.0e-4f); // stereo-linked gain reduction

    constexpr std::size_t frames = 4096;
    std::vector<float> input(frames * 2U, 0.0f);
    for (std::size_t frame = 0; frame < frames; ++frame) {
        const float tone = static_cast<float>(std::sin(static_cast<double>(frame) * 0.031) * 0.8);
        input[frame * 2U] = tone;
        input[frame * 2U + 1U] = tone * 0.6f;
    }
    NativeOutputStage wholeStage;
    NativeOutputStage chunkedStage;
    assert(wholeStage.prepare(sampleRate));
    assert(chunkedStage.prepare(sampleRate));
    assert(wholeStage.setCompressorConfig(config, 128U));
    assert(chunkedStage.setCompressorConfig(config, 128U));
    auto whole = input;
    auto chunked = input;
    (void)wholeStage.processInPlace(whole.data(), static_cast<unsigned int>(frames), 2U);
    constexpr std::array<unsigned int, 6> chunks{{1U, 63U, 64U, 255U, 511U, 1024U}};
    std::size_t offset = 0;
    std::size_t chunkIndex = 0;
    while (offset < frames) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(chunks[chunkIndex % chunks.size()], frames - offset));
        (void)chunkedStage.processInPlace(chunked.data() + offset * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    for (std::size_t sample = 0; sample < whole.size(); ++sample) {
        expectNear(chunked[sample], whole[sample], 1.0e-6f);
    }

    NativeCompressorConfig unsupportedSlot = config;
    unsupportedSlot.slot = NativeTrackOutputSlot::C;
    assert(!wholeStage.setCompressorConfig(unsupportedSlot));
    NativeCompressorConfig invalidRatio = config;
    invalidRatio.ratio = 20.1f;
    assert(!wholeStage.setCompressorConfig(invalidRatio));
}

void testNativeChorusThroughOutputStage() {
    constexpr unsigned int sampleRate = 48000U;
    NativeOutputStage stage;
    assert(stage.prepare(sampleRate));
    constexpr std::size_t prefillFrames = 1600U;
    std::vector<float> prefill(prefillFrames * 2U);
    for (std::size_t frame = 0; frame < prefillFrames; ++frame) {
        const float sample = static_cast<float>(0.7 * std::sin(2.0 * 3.14159265358979323846 * 440.0 * static_cast<double>(frame) / sampleRate));
        prefill[frame * 2U] = sample;
        prefill[frame * 2U + 1U] = sample;
    }
    (void)stage.processInPlace(prefill.data(), static_cast<unsigned int>(prefillFrames), 2U);

    NativeChorusConfig config;
    config.enabled = true;
    config.slot = NativeTrackOutputSlot::A;
    config.algorithm = NativeChorusAlgorithm::StereoLfoLagrange4;
    config.rateHz = 0.8f;
    config.depthMs = 10.0f;
    config.feedback = 0.0f;
    config.wetMix = 1.0f;
    assert(stage.setChorusConfig(config, 0U));
    std::array<float, 128> block{};
    for (std::size_t frame = 0; frame < block.size() / 2U; ++frame) {
        const auto absoluteFrame = prefillFrames + frame;
        const float sample = static_cast<float>(0.7 * std::sin(2.0 * 3.14159265358979323846 * 440.0 * static_cast<double>(absoluteFrame) / sampleRate));
        block[frame * 2U] = sample;
        block[frame * 2U + 1U] = sample;
    }
    const auto original = block;
    (void)stage.processInPlace(block.data(), 64U, 2U);
    double changeEnergy = 0.0;
    for (std::size_t sample = 0; sample < block.size(); ++sample) {
        const double difference = static_cast<double>(block[sample] - original[sample]);
        changeEnergy += difference * difference;
        assert(std::isfinite(block[sample]));
    }
    assert(changeEnergy > 0.1);
    assert(stage.chorusEnabled());
    assert(stage.chorusSlot() == NativeTrackOutputSlot::A);
    assert(stage.chorusAlgorithm() == NativeChorusAlgorithm::StereoLfoLagrange4);
}

void testNativePhaserThroughOutputStageWithCallbackSizedBlocks() {
    constexpr unsigned int sampleRate = 48000U;
    NativeOutputStage stage;
    assert(stage.prepare(sampleRate));
    NativePhaserConfig config;
    config.enabled = false;
    config.slot = NativeTrackOutputSlot::A;
    config.algorithm = NativePhaserAlgorithm::AllpassSweep;
    config.stages = 8U;
    config.rateHz = 0.7f;
    config.depth = 0.8f;
    config.feedback = -0.4f;
    config.wetMix = 1.0f;
    assert(stage.setPhaserConfig(config, 0U));
    assert(!stage.phaserEnabled());
    assert(stage.phaserSlot() == NativeTrackOutputSlot::A);
    assert(stage.phaserAlgorithm() == NativePhaserAlgorithm::AllpassSweep);
    assert(stage.phaserStages() == 8U);

    std::array<float, 128> block{};
    for (std::size_t frame = 0; frame < block.size() / 2U; ++frame) {
        const float sample = static_cast<float>(0.6 * std::sin(2.0 * 3.14159265358979323846 * 440.0 * static_cast<double>(frame) / sampleRate));
        block[frame * 2U] = sample;
        block[frame * 2U + 1U] = sample;
    }
    const auto bypassBlock = block;
    (void)stage.processInPlace(block.data(), 64U, 2U);
    for (std::size_t sample = 0; sample < block.size(); ++sample) {
        expectNear(block[sample], bypassBlock[sample], 0.0f);
    }

    config.enabled = true;
    config.stages = 4U;
    config.rateHz = 0.05f;
    config.depth = 0.0f;
    config.feedback = 0.0f;
    assert(stage.setPhaserConfig(config, 0U));
    (void)stage.processInPlace(block.data(), 64U, 2U);
    bool changed = false;
    for (std::size_t sample = 0; sample < block.size(); ++sample) {
        assert(std::isfinite(block[sample]));
        changed = changed || std::fabs(block[sample] - bypassBlock[sample]) > 1.0e-4f;
    }
    assert(changed);

    NativePhaserConfig unsupportedSlot = config;
    unsupportedSlot.slot = NativeTrackOutputSlot::B;
    assert(!stage.setPhaserConfig(unsupportedSlot));
    NativePhaserConfig invalidFeedback = config;
    invalidFeedback.feedback = 0.91f;
    assert(!stage.setPhaserConfig(invalidFeedback));
}

void testCleanRoomRhythmUsesTheDeviceFreeBlockRoute() {
    LooperCore looper(48000, 1);
    NativeOutputStage outputStage;
    NativeRhythmEngine rhythm;
    assert(outputStage.prepare(48000));
    assert(rhythm.prepare(48000));
    NativeRhythmConfig config;
    config.enabled = true;
    config.bpm = 120.0;
    config.kitIndex = 12;
    config.variation = NativeRhythmVariation::D;
    config.section = NativeRhythmSection::Fill;
    assert(rhythm.setConfig(config, 0));

    const std::array<float, 64> silence{};
    std::array<float, 128> output{};
    const auto stats = processNativeAudioBlock(
        looper, outputStage, silence.data(), output.data(), 64, 1, 2, &rhythm, 0
    );
    assert(stats.state == LooperState::Empty);
    assert(stats.outputPeak > 0.0f);
    assert(rhythm.activeVoiceCount() > 0);
    for (std::size_t frame = 0; frame < 64; ++frame) {
        expectNear(output[frame * 2], output[frame * 2 + 1]);
    }

    config.enabled = false;
    assert(rhythm.setConfig(config, 64));
    output.fill(0.0f);
    (void)processNativeAudioBlock(
        looper, outputStage, silence.data(), output.data(), 64, 1, 2, &rhythm, 64
    );
    for (const float sample : output) {
        expectNear(sample, 0.0f, 0.0f);
    }
}

} // namespace

int main() {
    testCallbackPipelineKeepsLoopDryAndFiltersOutput();
    testCatalogBankOnlyProcessesLoopPlayback();
    testOutputStagePreparationAndPassThroughChannels();
    testExplicitHighPassEffect();
    testFdn16ImpulseAndTailAtCommonSampleRates();
    testFdn16BlockSegmentationInvarianceAndDryBypass();
    testReverbDoesNotWriteIntoLooperStorage();
    testFractionalDelayImpulseAndFeedbackStability();
    testFractionalDelayBlockSegmentationInvariance();
    testNativePeakCompressorBehaviorAndBlockInvariance();
    testNativeChorusThroughOutputStage();
    testNativePhaserThroughOutputStageWithCallbackSizedBlocks();
    testCleanRoomRhythmUsesTheDeviceFreeBlockRoute();
    return 0;
}
