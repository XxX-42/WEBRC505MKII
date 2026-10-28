#include "looper_core.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <vector>

using namespace webrc::native;

namespace {

void testNativeDubModesReplacePcmAndKeepPlaybackTapSemantics() {
    const std::array<float, 4U> original{{0.1f, 0.2f, 0.3f, 0.4f}};
    const std::array<float, 2U> live{{0.7f, 0.8f}};
    for (const auto mode : {NativeDubMode::Overdub, NativeDubMode::Replace1, NativeDubMode::Replace2}) {
        LooperCore core(8000U, 1U, 1U);
        assert(core.setDubMode(mode));
        assert(core.dubMode() == mode);
        assert(!core.setDubMode(static_cast<NativeDubMode>(255U)));
        core.applyCommand({CommandType::SetMonitoring, false});
        core.applyCommand({CommandType::Record});
        (void)core.process(original.data(), nullptr, 4U, 1U, 1U);
        core.applyCommand({CommandType::StopRecordOrPlayback});
        core.applyCommand({CommandType::Play});
        std::array<float, 2U> output{};
        std::array<float, 2U> playbackTap{};
        (void)core.process(nullptr, output.data(), 2U, 0U, 1U, playbackTap.data());
        assert((output == std::array<float, 2U>{{0.1f, 0.2f}}));

        core.applyCommand({CommandType::ToggleOverdub});
        std::array<float, 2U> bouncePreview{{9.0f, 9.0f}};
        const bool previewAvailable = core.previewPlayback(bouncePreview.data(), 2U, 1U, 2U);
        if (mode == NativeDubMode::Replace2) {
            assert((!previewAvailable && bouncePreview == std::array<float, 2U>{{0.0f, 0.0f}}));
        } else {
            assert((previewAvailable && bouncePreview == std::array<float, 2U>{{0.3f, 0.4f}}));
        }
        output.fill(0.0f);
        playbackTap.fill(-1.0f);
        (void)core.process(live.data(), output.data(), 2U, 1U, 1U, playbackTap.data());
        if (mode == NativeDubMode::Overdub) {
            assert((output == std::array<float, 2U>{{1.0f, 1.0f}}));
            assert((playbackTap == std::array<float, 2U>{{0.3f, 0.4f}}));
        } else if (mode == NativeDubMode::Replace1) {
            assert((output == std::array<float, 2U>{{1.0f, 1.0f}}));
            assert((playbackTap == std::array<float, 2U>{{0.3f, 0.4f}}));
        } else {
            assert((output == live));
            assert((playbackTap == std::array<float, 2U>{{0.0f, 0.0f}}));
        }
        core.applyCommand({CommandType::ToggleOverdub}); // cancel before any further PCM writes
        assert(core.state() == LooperState::Playing);
        core.applyCommand({CommandType::StopRecordOrPlayback});
        std::array<float, 4U> pcm{};
        std::size_t copied = 0U;
        assert(core.copyFinalizedLoopSnapshot(pcm.data(), pcm.size(), copied));
        assert(copied == 4U);
        if (mode == NativeDubMode::Overdub) {
            assert((pcm == std::array<float, 4U>{{0.1f, 0.2f, 1.0f, 1.0f}}));
        } else {
            assert((pcm == std::array<float, 4U>{{0.1f, 0.2f, 0.7f, 0.8f}}));
        }
    }

    // A queued start/cancel pair that reaches the callback without processing
    // any input does not edit or truncate the canonical phrase.
    LooperCore cancelled(8000U, 1U, 1U);
    cancelled.applyCommand({CommandType::Record});
    (void)cancelled.process(original.data(), nullptr, 4U, 1U, 1U);
    cancelled.applyCommand({CommandType::StopRecordOrPlayback});
    cancelled.applyCommand({CommandType::Play});
    cancelled.applyCommand({CommandType::ToggleOverdub});
    cancelled.applyCommand({CommandType::ToggleOverdub});
    cancelled.applyCommand({CommandType::StopRecordOrPlayback});
    std::array<float, 4U> unchanged{};
    std::size_t copied = 0U;
    assert(cancelled.copyFinalizedLoopSnapshot(unchanged.data(), unchanged.size(), copied));
    assert(copied == original.size() && unchanged == original);
}

void testOptionalOutputPeakKeepsLooperAudioAndState(unsigned int storedChannels) {
    constexpr unsigned int kSampleRate = 8000U;
    LooperCore metered(kSampleRate, 1U, storedChannels);
    LooperCore unmetered(kSampleRate, 1U, storedChannels);
    std::array<float, 16U> input{};
    std::array<float, 16U> meteredOutput{};
    std::array<float, 16U> unmeteredOutput{};
    std::array<float, 16U> meteredPlayback{};
    std::array<float, 16U> unmeteredPlayback{};
    for (std::size_t frame = 0U; frame < 8U; ++frame) {
        input[frame * 2U] = (frame % 2U == 0U ? 1.0f : -1.0f) * (0.08f + 0.025f * static_cast<float>(frame));
        input[(frame * 2U) + 1U] = (frame % 2U == 0U ? -1.0f : 1.0f) * (0.11f + 0.02f * static_cast<float>(frame));
    }

    const auto applyBoth = [&](CommandType type, bool value = false) {
        metered.applyCommand({type, value});
        unmetered.applyCommand({type, value});
    };
    const auto processAndCompare = [&](const float* source, unsigned int frames, unsigned int inputChannels) {
        meteredOutput.fill(0.0f);
        unmeteredOutput.fill(0.0f);
        meteredPlayback.fill(0.0f);
        unmeteredPlayback.fill(0.0f);
        const auto expected = metered.process(
            source, meteredOutput.data(), frames, inputChannels, 2U, meteredPlayback.data()
        );
        const auto actual = unmetered.process(
            source, unmeteredOutput.data(), frames, inputChannels, 2U, unmeteredPlayback.data(), false
        );
        assert(meteredOutput == unmeteredOutput);
        assert(meteredPlayback == unmeteredPlayback);
        assert(expected.inputPeak == actual.inputPeak);
        assert(expected.state == actual.state);
        assert(expected.loopProgress == actual.loopProgress);
        assert(expected.loopTransportStatus == actual.loopTransportStatus);
        assert(actual.outputPeak == 0.0f);

        float measuredPeak = 0.0f;
        for (std::size_t sample = 0U; sample < static_cast<std::size_t>(frames) * 2U; ++sample) {
            measuredPeak = std::max(measuredPeak, std::fabs(meteredOutput[sample]));
        }
        assert(expected.outputPeak == measuredPeak);
        const auto expectedMetadata = metered.metadata();
        const auto actualMetadata = unmetered.metadata();
        assert(expectedMetadata.state == actualMetadata.state);
        assert(expectedMetadata.recordedFrames == actualMetadata.recordedFrames);
        assert(expectedMetadata.finalizedFrames == actualMetadata.finalizedFrames);
        assert(expectedMetadata.playhead == actualMetadata.playhead);
    };

    applyBoth(CommandType::SetMonitoring, true);
    applyBoth(CommandType::Record);
    // Deliberately irregular blocks cover chunk boundaries in both mono and
    // stereo loop storage, while preserving the legacy public meter by default.
    processAndCompare(input.data(), 3U, 2U);
    processAndCompare(input.data() + 6U, 1U, 2U);
    processAndCompare(input.data() + 8U, 4U, 2U);
    applyBoth(CommandType::StopRecordOrPlayback);
    processAndCompare(nullptr, 1U, 0U);

    std::array<float, 16U> meteredSnapshot{};
    std::array<float, 16U> unmeteredSnapshot{};
    std::size_t meteredFrames = 0U;
    std::size_t unmeteredFrames = 0U;
    assert(metered.copyFinalizedStereoLoopSnapshot(meteredSnapshot.data(), 8U, meteredFrames));
    assert(unmetered.copyFinalizedStereoLoopSnapshot(unmeteredSnapshot.data(), 8U, unmeteredFrames));
    assert(meteredFrames == unmeteredFrames && meteredSnapshot == unmeteredSnapshot);

    applyBoth(CommandType::Play);
    processAndCompare(input.data(), 5U, 2U);
    processAndCompare(input.data() + 10U, 3U, 2U);
    applyBoth(CommandType::ToggleOverdub);
    processAndCompare(input.data(), 2U, 2U);
    processAndCompare(input.data() + 4U, 3U, 2U);
    processAndCompare(input.data() + 10U, 3U, 2U);
    applyBoth(CommandType::StopRecordOrPlayback);
    processAndCompare(nullptr, 1U, 0U);
    assert(metered.copyFinalizedStereoLoopSnapshot(meteredSnapshot.data(), 8U, meteredFrames));
    assert(unmetered.copyFinalizedStereoLoopSnapshot(unmeteredSnapshot.data(), 8U, unmeteredFrames));
    assert(meteredFrames == unmeteredFrames && meteredSnapshot == unmeteredSnapshot);
}

void testReadOnlyPlaybackPreview() {
    for (const auto rate : {8000U, 48000U, 192000U}) for (const auto channels : {1U, 2U}) {
        LooperCore previewed(rate, 1U, channels), reference(rate, 1U, channels);
        std::vector<float> source(514U);
        for (std::size_t f = 0U; f < 257U; ++f) { source[f * 2U] = 0.1f + static_cast<float>(f) * 0.0007f; source[f * 2U + 1U] = -0.5f * source[f * 2U]; }
        for (auto* core : {&previewed, &reference}) {
            core->applyCommand({CommandType::SetMonitoring, false});
            core->applyCommand({CommandType::Record});
            (void)core->process(source.data(), nullptr, 257U, 2U, 2U);
            core->applyCommand({CommandType::StopRecordOrPlayback});
            core->applyCommand({CommandType::Play});
        }
        std::array<float, 8192U> expected{}, repeated{}, actual{}, untouched{};
        for (unsigned int phase = 0U; phase < 5U; ++phase) {
            LoopTransportConfig config;
            if (phase == 1U) { config.mode = LoopTransportMode::BeatShift; config.beatOffsetBeats = -0.375f; config.bpm = 87.0f; }
            if (phase == 2U || phase == 3U) { config.mode = LoopTransportMode::VinylFlick; config.vinylSpeedPercent = phase == 2U ? 100.0f : -100.0f; config.motorReturnSeconds = 0.05f; config.brakePercent = 37.0f; }
            config.crossfadeMs = 7.0f;
            assert(previewed.setLoopTransportConfig(config)); assert(reference.setLoopTransportConfig(config));
            for (const auto frames : {1U, 13U, 127U, 4096U, 47U}) {
                const auto before = previewed.metadata();
                assert(previewed.previewPlayback(expected.data(), frames, 2U, 4096U));
                assert(previewed.previewPlayback(repeated.data(), frames, 2U, 4096U));
                assert(before.playhead == previewed.metadata().playhead && before.state == previewed.state());
                (void)previewed.process(nullptr, actual.data(), frames, 0U, 2U);
                (void)reference.process(nullptr, untouched.data(), frames, 0U, 2U);
                for (unsigned int i = 0U; i < frames * 2U; ++i) {
                    assert(expected[i] == repeated[i]); assert(expected[i] == actual[i]); assert(actual[i] == untouched[i]);
                }
                assert(previewed.metadata().playhead == reference.metadata().playhead);
            }
        }
        for (const auto command : {CommandType::ToggleOverdub, CommandType::StopRecordOrPlayback, CommandType::Clear, CommandType::Record}) {
            previewed.applyCommand({command}); expected.fill(9.0f);
            const auto before = previewed.metadata();
            const bool previewAvailable = previewed.previewPlayback(expected.data(), 128U, 2U, 4096U);
            assert(previewAvailable == (command == CommandType::ToggleOverdub));
            if (!previewAvailable) {
                assert(std::all_of(expected.begin(), expected.begin() + 256U, [](float x) { return x == 0.0f; }));
            }
            const auto after = previewed.metadata();
            assert(before.state == after.state && before.playhead == after.playhead && before.recordedFrames == after.recordedFrames);
        }
        expected.fill(9.0f);
        assert(!previewed.previewPlayback(expected.data(), 5U, 2U, 4U));
        assert(!previewed.previewPlayback(expected.data(), 4097U, 2U, 5000U));
        assert(!previewed.previewPlayback(expected.data(), 2U, 3U, 4096U));
        assert(!previewed.previewPlayback(nullptr, 2U, 2U, 4096U));
        assert(std::all_of(expected.begin(), expected.end(), [](float x) { return x == 9.0f; }));
    }
}

} // namespace

int main() {
    testNativeDubModesReplacePcmAndKeepPlaybackTapSemantics();
    testReadOnlyPlaybackPreview();
    testOptionalOutputPeakKeepsLooperAudioAndState(1U);
    testOptionalOutputPeakKeepsLooperAudioAndState(2U);

    assert(LooperCore::maximumDurationSecondsForBudget(48000U, 2U, 5U) == 300U);
    assert(LooperCore::maximumDurationSecondsForBudget(96000U, 2U, 5U) == 209U);
    assert(LooperCore::maximumDurationSecondsForBudget(192000U, 2U, 5U) == 104U);
    assert(LooperCore::maximumDurationSecondsForBudget(
        96000U, 2U, 5U, 300U, 1536ULL * 1024ULL * 1024ULL) == 300U);
    assert(LooperCore::maximumDurationSecondsForBudget(
        192000U, 2U, 5U, 300U, 2560ULL * 1024ULL * 1024ULL) == 300U);
    assert(LooperCore::maximumDurationSecondsForBudget(192001U, 2U, 5U) == 0U);
    assert(LooperCore::maximumDurationSecondsForBudget(48000U, 2U, 0U) == 0U);
    LooperCore looper(48000, 10);
    assert(looper.capacityFrames() == 48000U * 10U);
    assert(looper.storageBytes() == 48000U * 10U * sizeof(float));
    const auto preparedStorageBytes = looper.storageBytes();
    std::vector<float> input(256, 0.25f);
    std::vector<float> output(512, 0.0f);
    std::vector<float> playback(512, -9.0f);

    looper.applyCommand({CommandType::Record, false});
    auto stats = looper.process(input.data(), output.data(), 256, 1, 2);
    assert(stats.state == LooperState::Recording);
    assert(looper.storageBytes() == preparedStorageBytes);

    looper.applyCommand({CommandType::StopRecordOrPlayback, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2);
    assert(stats.state == LooperState::Stopped);

    std::vector<float> loopSnapshot(256, -1.0f);
    std::size_t copiedFrames = 0U;
    assert(looper.copyFinalizedLoopSnapshot(loopSnapshot.data(), loopSnapshot.size(), copiedFrames));
    assert(copiedFrames == input.size());
    assert(std::all_of(loopSnapshot.begin(), loopSnapshot.end(), [](float sample) { return sample == 0.25f; }));
    assert(!looper.copyFinalizedLoopSnapshot(loopSnapshot.data(), loopSnapshot.size() - 1U, copiedFrames));
    assert(copiedFrames == 0U);

    looper.applyCommand({CommandType::Play, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2, playback.data());
    assert(stats.state == LooperState::Playing);
    assert(output[0] == 0.25f && output[1] == 0.25f);
    assert(playback[0] == 0.25f && playback[1] == 0.25f);

    // Playback advances only the playhead, so a caller with the Native host's
    // callback pin can still copy an identical finalized loop while playing.
    std::fill(loopSnapshot.begin(), loopSnapshot.end(), -1.0f);
    assert(looper.copyFinalizedLoopSnapshot(loopSnapshot.data(), loopSnapshot.size(), copiedFrames));
    assert(copiedFrames == input.size());
    assert(std::all_of(loopSnapshot.begin(), loopSnapshot.end(), [](float sample) { return sample == 0.25f; }));

    looper.applyCommand({CommandType::SetMonitoring, true});
    std::fill(input.begin(), input.end(), -0.1f);
    stats = looper.process(input.data(), output.data(), 16, 1, 2, playback.data());
    assert(output[0] > 0.14f && output[0] < 0.16f);
    assert(playback[0] == 0.25f && playback[1] == 0.25f);

    looper.applyCommand({CommandType::ToggleOverdub, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2, playback.data());
    assert(stats.state == LooperState::Overdubbing);
    assert(playback[0] == 0.25f && playback[1] == 0.25f);
    assert(output[0] > 0.14f && output[0] < 0.16f);

    looper.applyCommand({CommandType::ToggleOverdub, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2);
    assert(stats.state == LooperState::Playing);

    looper.applyCommand({CommandType::Clear, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2);
    assert(stats.state == LooperState::Empty);
    assert(!looper.copyFinalizedLoopSnapshot(loopSnapshot.data(), loopSnapshot.size(), copiedFrames));
    assert(copiedFrames == 0U);

    // Stereo loop storage keeps left/right samples independent and exports a
    // frame-counted interleaved stereo snapshot.
    LooperCore stereo(48000U, 1U, 2U);
    assert(stereo.capacityFrames() == 48000U);
    assert(stereo.storageBytes() == 48000U * 2U * sizeof(float));
    const std::array<float, 8> stereoInput{{0.1f, -0.1f, 0.2f, -0.2f, 0.3f, -0.3f, 0.4f, -0.4f}};
    std::array<float, 8> stereoOutput{};
    std::array<float, 8> stereoSnapshot{};
    stereo.applyCommand({CommandType::Record, false});
    (void)stereo.process(stereoInput.data(), stereoOutput.data(), 4U, 2U, 2U);
    stereo.applyCommand({CommandType::StopRecordOrPlayback, false});
    std::size_t stereoCopiedFrames = 0U;
    assert(stereo.copyFinalizedStereoLoopSnapshot(stereoSnapshot.data(), 4U, stereoCopiedFrames));
    assert(stereoCopiedFrames == 4U);
    assert(stereoSnapshot == stereoInput);
    stereo.applyCommand({CommandType::Play, false});
    (void)stereo.process(nullptr, stereoOutput.data(), 4U, 0U, 2U);
    assert(stereoOutput == stereoInput);

    // Tiny one-second capacity makes the duration guard testable without
    // allocating the full five-minute Native maximum. Extra callback frames
    // at capacity must not extend or overwrite the finalized loop.
    LooperCore bounded(2U, 1U, 2U);
    const std::array<float, 6> beyondCapacity{{0.11f, -0.11f, 0.22f, -0.22f, 0.33f, -0.33f}};
    std::array<float, 10> boundedOutput{};
    std::array<float, 4> boundedSnapshot{};
    bounded.applyCommand({CommandType::Record, false});
    (void)bounded.process(beyondCapacity.data(), boundedOutput.data(), 3U, 2U, 2U);
    (void)bounded.process(beyondCapacity.data(), boundedOutput.data(), 2U, 2U, 2U);
    bounded.applyCommand({CommandType::StopRecordOrPlayback, false});
    assert(bounded.state() == LooperState::Stopped);
    assert(bounded.loopLengthSamples() == 2U);
    std::size_t boundedCopiedFrames = 0U;
    assert(bounded.copyFinalizedStereoLoopSnapshot(boundedSnapshot.data(), 2U, boundedCopiedFrames));
    assert(boundedCopiedFrames == 2U);
    assert((boundedSnapshot == std::array<float, 4>{{0.11f, -0.11f, 0.22f, -0.22f}}));

    // Prepared capacity is a fixed, explicit 300-second/192-kHz maximum. An
    // over-limit request is rejected without replacing a working buffer.
    const auto boundedStorageBytes = bounded.storageBytes();
    const auto boundedCapacityFrames = bounded.capacityFrames();
    assert(!bounded.prepare(192001U, 1U, 2U));
    assert(!bounded.prepare(48000U, LooperCore::kMaximumLoopSeconds + 1U, 2U));
    assert(bounded.storageBytes() == boundedStorageBytes);
    assert(bounded.capacityFrames() == boundedCapacityFrames);

    // Source-aware loop transport stays inert by default, reports unsupported
    // record/overdub states explicitly, and leaves overdub writes on the
    // canonical playhead.
    LooperCore sourceAware(8000U, 1U, 1U);
    std::array<float, 8000> sourceRamp{};
    std::array<float, 8000> sourceOutput{};
    std::array<float, 8000> sourcePlayback{};
    for (std::size_t frame = 0U; frame < sourceRamp.size(); ++frame) {
        sourceRamp[frame] = static_cast<float>(frame) * 0.000025f;
    }
    LoopTransportConfig beatShift;
    beatShift.mode = LoopTransportMode::BeatShift;
    beatShift.beatOffsetBeats = 0.1f;
    beatShift.bpm = 120.0f;
    beatShift.crossfadeMs = 5.0f;
    assert(LooperCore::validLoopTransportConfig(beatShift));
    auto invalidBeatShift = beatShift;
    invalidBeatShift.crossfadeMs = 10.1f;
    assert(!sourceAware.setLoopTransportConfig(invalidBeatShift));
    assert(sourceAware.loopTransportStatus() == LoopTransportStatus::Disabled);
    assert(sourceAware.setLoopTransportConfig(beatShift));
    auto sourceStats = sourceAware.process(nullptr, sourceOutput.data(), 1U, 0U, 1U, sourcePlayback.data());
    assert(sourceStats.loopTransportStatus == LoopTransportStatus::WaitingForLoop);
    sourceAware.applyCommand({CommandType::Record, false});
    sourceStats = sourceAware.process(sourceRamp.data(), sourceOutput.data(), 8000U, 1U, 1U, sourcePlayback.data());
    assert(sourceStats.loopTransportStatus == LoopTransportStatus::UnsupportedRecording);
    sourceAware.applyCommand({CommandType::StopRecordOrPlayback, false});
    sourceStats = sourceAware.process(nullptr, sourceOutput.data(), 1U, 0U, 1U, sourcePlayback.data());
    assert(sourceStats.state == LooperState::Stopped);
    assert(sourceStats.loopTransportStatus == LoopTransportStatus::WaitingForPlayback);
    sourceAware.applyCommand({CommandType::Play, false});
    sourceStats = sourceAware.process(nullptr, sourceOutput.data(), 40U, 0U, 1U, sourcePlayback.data());
    assert(sourceStats.loopTransportStatus == LoopTransportStatus::Active);
    // The signed +0.1 beat shift reads +400 frames at 8 kHz / 120 BPM. It
    // crossfades from the canonical head at start of playback over 40 frames.
    assert(std::fabs(sourcePlayback[0] - sourceRamp[0U]) < 0.00001f);
    assert(std::fabs(sourcePlayback[39U] - sourceRamp[439U]) < 0.0001f);

    // Parameter jumps use an equal-power crossfade of exactly the configured
    // 5 ms (40 frames); the old and new head positions remain loop-relative.
    beatShift.beatOffsetBeats = -0.1f;
    assert(sourceAware.setLoopTransportConfig(beatShift));
    sourceStats = sourceAware.process(nullptr, sourceOutput.data(), 40U, 0U, 1U, sourcePlayback.data());
    assert(std::fabs(sourcePlayback[39U] - sourceRamp[7679U]) < 0.0001f);
    assert(sourcePlayback[0] > sourceRamp[439U]);
    assert(sourcePlayback[0] < sourceRamp[7679U]);

    // Native 1SHOT is finite, ignores overdub entry, and a Play command during
    // playback retriggers from the beginning. The callback performs this with
    // a fixed cursor and no locks or allocations.
    LooperCore oneShot(8U, 1U, 1U);
    std::array<float, 4> oneShotInput{{0.1f, 0.2f, 0.3f, 0.4f}};
    std::array<float, 4> oneShotOutput{};
    oneShot.applyCommand({CommandType::Record, false});
    (void)oneShot.process(oneShotInput.data(), oneShotOutput.data(), 4U, 1U, 1U);
    oneShot.applyCommand({CommandType::StopRecordOrPlayback, false});
    LoopTransportConfig oneShotConfig;
    oneShotConfig.oneShot = true;
    assert(oneShot.setLoopTransportConfig(oneShotConfig));
    oneShot.applyCommand({CommandType::Play, false});
    oneShot.applyCommand({CommandType::ToggleOverdub, false});
    assert(oneShot.state() == LooperState::Playing);
    std::array<float, 6> oneShotPreview{};
    const auto beforePreview = oneShot.metadata();
    assert(oneShot.previewPlayback(oneShotPreview.data(), 6U, 1U, 6U));
    assert((std::array<float, 4>{{oneShotPreview[0], oneShotPreview[1], oneShotPreview[2], oneShotPreview[3]}} == oneShotInput));
    assert(oneShotPreview[4] == 0.0f && oneShotPreview[5] == 0.0f);
    assert(oneShot.metadata().playhead == beforePreview.playhead && oneShot.state() == beforePreview.state);
    std::array<float, 2> oneShotInterrupted{};
    (void)oneShot.process(nullptr, oneShotInterrupted.data(), 2U, 0U, 1U);
    assert(!oneShot.setLoopTransportConfig(LoopTransportConfig{}));
    oneShot.applyCommand({CommandType::Play, false});
    std::array<float, 6> oneShotPlayback{};
    std::array<float, 6> oneShotBounceTap{};
    auto oneShotStats = oneShot.process(nullptr, oneShotPlayback.data(), 6U, 0U, 1U, oneShotBounceTap.data());
    assert(oneShotStats.state == LooperState::Stopped);
    assert((std::array<float, 4>{{oneShotPlayback[0], oneShotPlayback[1], oneShotPlayback[2], oneShotPlayback[3]}} == oneShotInput));
    assert(oneShotPlayback[4] == 0.0f && oneShotPlayback[5] == 0.0f);
    assert(oneShotBounceTap == oneShotPlayback);
    oneShot.applyCommand({CommandType::Clear, false});
    oneShot.applyCommand({CommandType::Record, false});
    (void)oneShot.process(oneShotInput.data(), oneShotOutput.data(), 4U, 1U, 1U);
    oneShot.applyCommand({CommandType::FinishRecording, true});
    assert(oneShot.state() == LooperState::Playing);
    std::array<float, 4> oneShotRecToDub{};
    oneShotStats = oneShot.process(nullptr, oneShotRecToDub.data(), 4U, 0U, 1U);
    assert(oneShotStats.state == LooperState::Stopped && oneShotRecToDub == oneShotInput);

    // Integer read-head wrap remains phase-continuous for a periodic source;
    // Beat Shift changes pointer position but preserves the loop period.
    LooperCore seam(8000U, 1U, 1U);
    std::array<float, 1000> periodicLoop{};
    std::array<float, 1000> seamRecordOutput{};
    std::array<float, 602> seamOutput{};
    for (std::size_t frame = 0U; frame < periodicLoop.size(); ++frame) {
        periodicLoop[frame] = std::sin(static_cast<float>(frame) * 6.2831853071795864769f /
                                       static_cast<float>(periodicLoop.size()));
    }
    seam.applyCommand({CommandType::Record, false});
    (void)seam.process(periodicLoop.data(), seamRecordOutput.data(), static_cast<unsigned int>(periodicLoop.size()), 1U, 1U);
    seam.applyCommand({CommandType::StopRecordOrPlayback, false});
    beatShift.beatOffsetBeats = 0.1f;
    assert(seam.setLoopTransportConfig(beatShift));
    seam.applyCommand({CommandType::Play, false});
    (void)seam.process(nullptr, seamOutput.data(), static_cast<unsigned int>(seamOutput.size()), 0U, 1U);
    // +400 frames wraps from loop frame 999 to frame 0 at output frame 600.
    assert(std::fabs(seamOutput[600U] - seamOutput[599U]) < 0.02f);

    // Fractional Beat Shift positions use the shared Native four-point
    // Lagrange interpolator. A 0.1-beat shift at 123 BPM is 390.2439 samples;
    // the 1 kHz loop tone should stay within 2% amplitude of its 0.5 input
    // level after the short startup crossfade has completed.
    LooperCore fractionalBeatShift(8000U, 1U, 1U);
    std::array<float, 8000> fractionalTone{};
    std::array<float, 8000> fractionalOutput{};
    std::array<float, 8000> fractionalPlayback{};
    constexpr double fractionalToneHz = 1000.0;
    constexpr double fractionalSampleRate = 8000.0;
    constexpr double fractionalPi = 3.14159265358979323846;
    for (std::size_t frame = 0U; frame < fractionalTone.size(); ++frame) {
        fractionalTone[frame] = 0.5f * static_cast<float>(std::sin(
            2.0 * fractionalPi * fractionalToneHz * static_cast<double>(frame) / fractionalSampleRate));
    }
    fractionalBeatShift.applyCommand({CommandType::Record, false});
    (void)fractionalBeatShift.process(fractionalTone.data(), fractionalOutput.data(),
        static_cast<unsigned int>(fractionalTone.size()), 1U, 1U);
    fractionalBeatShift.applyCommand({CommandType::StopRecordOrPlayback, false});
    LoopTransportConfig fractionalBeatConfig;
    fractionalBeatConfig.mode = LoopTransportMode::BeatShift;
    fractionalBeatConfig.beatOffsetBeats = 0.1f;
    fractionalBeatConfig.bpm = 123.0f;
    fractionalBeatConfig.crossfadeMs = 1.0f;
    const double requestedOffset = fractionalSampleRate * 60.0 / 123.0 * 0.1;
    const double offsetFraction = requestedOffset - std::floor(requestedOffset);
    assert(offsetFraction > 0.2 && offsetFraction < 0.3);
    assert(fractionalBeatShift.setLoopTransportConfig(fractionalBeatConfig));
    fractionalBeatShift.applyCommand({CommandType::Play, false});
    (void)fractionalBeatShift.process(nullptr, fractionalOutput.data(),
        static_cast<unsigned int>(fractionalOutput.size()), 0U, 1U, fractionalPlayback.data());
    constexpr std::size_t amplitudeStart = 64U;
    constexpr std::size_t amplitudeFrames = 4000U;
    double toneSineProjection = 0.0;
    double toneCosineProjection = 0.0;
    for (std::size_t frame = 0U; frame < amplitudeFrames; ++frame) {
        const double phase = 2.0 * fractionalPi * fractionalToneHz *
            static_cast<double>(frame) / fractionalSampleRate;
        const double sample = fractionalPlayback[amplitudeStart + frame];
        toneSineProjection += sample * std::sin(phase);
        toneCosineProjection += sample * std::cos(phase);
    }
    const double fractionalToneAmplitude = 2.0 * std::sqrt(
        toneSineProjection * toneSineProjection + toneCosineProjection * toneCosineProjection) /
        static_cast<double>(amplitudeFrames);
    assert(fractionalToneAmplitude > 0.49 && fractionalToneAmplitude < 0.51);

    sourceAware.applyCommand({CommandType::ToggleOverdub, false});
    const std::array<float, 1> overdubInput{{0.25f}};
    sourceStats = sourceAware.process(overdubInput.data(), sourceOutput.data(), 1U, 1U, 1U, sourcePlayback.data());
    assert(sourceStats.loopTransportStatus == LoopTransportStatus::UnsupportedOverdubbing);
    // Canonical playhead is at frame 80; transport is excluded from both the
    // playback tap used by overdub and the data written back to the loop.
    assert(std::fabs(sourcePlayback[0] - sourceRamp[80U]) < 0.00001f);
    std::array<float, 8000> afterOverdub{};
    std::size_t afterOverdubFrames = 0U;
    sourceAware.applyCommand({CommandType::StopRecordOrPlayback, false});
    assert(sourceAware.copyFinalizedLoopSnapshot(afterOverdub.data(), afterOverdub.size(), afterOverdubFrames));
    assert(afterOverdubFrames == sourceRamp.size());
    assert(std::fabs(afterOverdub[80U] - (sourceRamp[80U] + overdubInput[0])) < 0.00001f);

    // VINYL FLICK's second-order platter approaches a 2x target and the
    // stored-loop reader consequently crosses this one-cycle loop faster.
    LooperCore vinyl(8000U, 1U, 1U);
    std::array<float, 1000> vinylLoop{};
    std::array<float, 8000> vinylOutput{};
    for (std::size_t frame = 0U; frame < vinylLoop.size(); ++frame) {
        vinylLoop[frame] = std::sin(static_cast<float>(frame) * 6.2831853071795864769f /
                                    static_cast<float>(vinylLoop.size()));
    }
    vinyl.applyCommand({CommandType::Record, false});
    (void)vinyl.process(vinylLoop.data(), vinylOutput.data(), static_cast<unsigned int>(vinylLoop.size()), 1U, 1U);
    vinyl.applyCommand({CommandType::StopRecordOrPlayback, false});
    LoopTransportConfig vinylFlick;
    vinylFlick.mode = LoopTransportMode::VinylFlick;
    vinylFlick.vinylSpeedPercent = 100.0f;
    vinylFlick.motorReturnSeconds = 0.05f;
    vinylFlick.brakePercent = 0.0f;
    vinylFlick.vinylMixPercent = 100.0f;
    assert(vinyl.setLoopTransportConfig(vinylFlick));
    vinyl.applyCommand({CommandType::Play, false});
    (void)vinyl.process(nullptr, vinylOutput.data(), 8000U, 0U, 1U);
    std::size_t positiveCrossings = 0U;
    float maximumWrappedStep = 0.0f;
    for (std::size_t frame = 4001U; frame < vinylOutput.size(); ++frame) {
        if (vinylOutput[frame - 1U] <= 0.0f && vinylOutput[frame] > 0.0f) ++positiveCrossings;
        maximumWrappedStep = std::max(maximumWrappedStep, std::fabs(vinylOutput[frame] - vinylOutput[frame - 1U]));
    }
    assert(positiveCrossings >= 7U && positiveCrossings <= 9U);
    assert(maximumWrappedStep < 0.03f);

    // History exchanges only finalized stereo frames and metadata; prepared
    // storage remains full-capacity so restoring a short take never shrinks
    // the next recording's safe write range.
    LooperCore historyLooper(8U, 2U, 2U);
    const std::array<float, 4> shortTake{{0.1f, -0.1f, 0.2f, -0.2f}};
    std::array<float, 16> historyScratch{};
    historyLooper.applyCommand({CommandType::Record, false});
    (void)historyLooper.process(shortTake.data(), historyScratch.data(), 2U, 2U, 2U);
    historyLooper.applyCommand({CommandType::StopRecordOrPlayback, false});
    const auto shortMetadata = historyLooper.metadata();
    assert(shortMetadata.state == LooperState::Stopped && shortMetadata.finalizedFrames == 2U);
    std::array<float, 4> alternate{{0.7f, -0.7f, 0.8f, -0.8f}};
    assert(historyLooper.exchangeFinalizedStereoSamples(alternate.data(), 2U));
    std::array<float, 4> exactAfterSwap{};
    std::size_t exactFrames = 0U;
    assert(historyLooper.copyFinalizedStereoLoopSnapshot(exactAfterSwap.data(), 2U, exactFrames));
    assert((exactAfterSwap == std::array<float, 4>{{0.7f, -0.7f, 0.8f, -0.8f}}));
    assert((alternate == shortTake));
    assert(historyLooper.exchangeFinalizedStereoSamples(alternate.data(), 2U));
    assert((alternate == std::array<float, 4>{{0.7f, -0.7f, 0.8f, -0.8f}}));
    historyLooper.applyCommand({CommandType::Clear, false});
    const auto emptyMetadata = historyLooper.metadata();
    assert(emptyMetadata.state == LooperState::Empty && historyLooper.storageBytes() == 16U * 2U * sizeof(float));
    historyLooper.restoreMetadata(shortMetadata);
    assert(historyLooper.capacityFrames() == 16U && historyLooper.storageBytes() == 16U * 2U * sizeof(float));
    std::array<float, 4> restoredShort{};
    assert(historyLooper.copyFinalizedStereoLoopSnapshot(restoredShort.data(), 2U, exactFrames));
    assert(restoredShort == shortTake);
    historyLooper.restoreMetadata(emptyMetadata);
    std::array<float, 16> longTake{};
    for (std::size_t sample = 0U; sample < longTake.size(); ++sample) longTake[sample] = static_cast<float>(sample) * 0.01f;
    historyLooper.applyCommand({CommandType::Record, false});
    (void)historyLooper.process(longTake.data(), historyScratch.data(), 8U, 2U, 2U);
    historyLooper.applyCommand({CommandType::StopRecordOrPlayback, false});
    assert(historyLooper.loopLengthSamples() == 8U && historyLooper.capacityFrames() == 16U);
    std::array<float, 16> exactLong{};
    assert(historyLooper.copyFinalizedStereoLoopSnapshot(exactLong.data(), 8U, exactFrames));
    assert(exactLong == longTake);

    // Project import swaps a prepared full-capacity candidate in O(1), stops
    // the track, resets its playhead, and keeps the primary maximum write
    // capacity so a later longer recording cannot overflow the short import.
    LooperCore imported(8U, 2U, 2U);
    std::vector<float> importedCandidate(32U, 0.0f);
    importedCandidate[0] = 0.91f;
    importedCandidate[1] = -0.91f;
    importedCandidate[2] = 0.42f;
    importedCandidate[3] = -0.42f;
    const auto importedStorageBytes = imported.storageBytes();
    assert(imported.swapImportedStereoStorage(importedCandidate, 2U));
    assert(imported.storageBytes() == importedStorageBytes && importedCandidate.size() == 32U);
    assert(std::all_of(importedCandidate.begin(), importedCandidate.end(), [](float sample) { return sample == 0.0f; }));
    assert(imported.state() == LooperState::Stopped && imported.loopLengthSamples() == 2U);
    assert(imported.metadata().playhead == 0U);
    std::array<float, 4> importedSnapshot{};
    std::size_t importedFrames = 0U;
    assert(imported.copyFinalizedStereoLoopSnapshot(importedSnapshot.data(), 2U, importedFrames));
    assert((importedSnapshot == std::array<float, 4>{{0.91f, -0.91f, 0.42f, -0.42f}}));
    assert(!imported.swapImportedStereoStorage(importedCandidate, 17U));
    std::vector<float> emptyCandidate(32U, 0.0f);
    assert(imported.swapImportedStereoStorage(emptyCandidate, 0U));
    assert(imported.state() == LooperState::Empty && imported.loopLengthSamples() == 0U);
    std::array<float, 16> afterImportLongTake{};
    for (std::size_t sample = 0U; sample < afterImportLongTake.size(); ++sample) {
        afterImportLongTake[sample] = static_cast<float>(sample) * 0.02f;
    }
    std::array<float, 16> afterImportOutput{};
    imported.applyCommand({CommandType::Record, false});
    (void)imported.process(afterImportLongTake.data(), afterImportOutput.data(), 8U, 2U, 2U);
    imported.applyCommand({CommandType::StopRecordOrPlayback, false});
    std::array<float, 16> afterImportSnapshot{};
    assert(imported.capacityFrames() == 16U && imported.loopLengthSamples() == 8U);
    assert(imported.copyFinalizedStereoLoopSnapshot(afterImportSnapshot.data(), 8U, importedFrames));
    assert(afterImportSnapshot == afterImportLongTake);

    return 0;
}
